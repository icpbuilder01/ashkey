//! Monero payment verification, done by the canister itself.
//!
//! The canister knows the service wallet's private VIEW key and public SPEND
//! key. With them it can derive one subaddress per order and recognise (and
//! decrypt the amount of) outputs sent to it. It cannot spend anything: the
//! spend key never comes here, the money lands directly in the operator's
//! own wallet.
//!
//! To check a payment, the canister asks two independent HTTPS Monero nodes
//! for the transaction (HTTPS outcalls: every replica of the subnet fetches it
//! and they must agree byte for byte after the transform below). Then:
//!  1. both nodes must return the same transaction blob at the same height,
//!  2. the blob must hash to the txid (a node cannot substitute another tx),
//!  3. the tx must not be time-locked (unlock_time = 0),
//!  4. both nodes must already have a block `min_confirmations - 1` above it,
//!  5. the outputs to this order's subaddress are decrypted with the view key.

use crate::store::Config;
use candid::Principal;
use ic_cdk::call::Call;
use ic_cdk_management_canister::{
    transform_context_from_query, HttpHeader, HttpMethod, HttpRequestArgs, HttpRequestResult, TransformArgs,
};
use monero::consensus::deserialize;
use monero::cryptonote::hash::Hashable;
use monero::cryptonote::onetime_key::SubKeyChecker;
use monero::cryptonote::subaddress::{get_subaddress, Index};
use monero::{Address, Network, PrivateKey, PublicKey, Transaction, ViewPair};
use serde_json::{json, Value};

pub fn network(cfg: &Config) -> Network {
    match cfg.network.as_str() {
        "stagenet" => Network::Stagenet,
        "testnet" => Network::Testnet,
        _ => Network::Mainnet,
    }
}

pub fn view_pair(cfg: &Config) -> Result<ViewPair, String> {
    let view = cfg.view_key.as_ref().ok_or("Payments are not configured yet.")?;
    let spend = cfg.spend_pub.as_ref().ok_or("Payments are not configured yet.")?;
    Ok(ViewPair {
        view: PrivateKey::from_slice(view).map_err(|_| "Invalid view key in config.")?,
        spend: PublicKey::from_slice(spend).map_err(|_| "Invalid spend key in config.")?,
    })
}

/// Main address of the service wallet (to compare with the operator's wallet).
pub fn primary_address(cfg: &Config) -> Result<String, String> {
    let vp = view_pair(cfg)?;
    Ok(Address::standard(network(cfg), vp.spend, PublicKey::from_private_key(&vp.view)).to_string())
}

/// Subaddress (account 0, index `minor`) for one order.
pub fn subaddress(cfg: &Config, minor: u32) -> Result<String, String> {
    let vp = view_pair(cfg)?;
    Ok(get_subaddress(&vp, Index { major: 0, minor }, Some(network(cfg))).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    NotFound,
    InPool,
    /// Mined at `height`, not enough confirmations yet.
    Waiting { height: u64 },
    /// Confirmed; `amount` (piconero) went to the order's subaddress.
    Received { amount: u64, height: u64 },
}

pub fn valid_txid(txid: &str) -> bool {
    txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Decodes a transaction blob and returns the amount sent to subaddress (0, minor).
pub fn amount_to_subaddress(cfg: &Config, txid: &str, hex_blob: &str, minor: u32) -> Result<u64, String> {
    let bytes = hex::decode(hex_blob).map_err(|_| "The node returned an invalid transaction.")?;
    let tx: Transaction = deserialize(&bytes).map_err(|_| "Could not decode the transaction.")?;
    if format!("{:x}", tx.hash()) != txid {
        return Err("The node returned a transaction that does not match this ID.".into());
    }
    if tx.prefix.unlock_time.0 != 0 {
        return Err("This transaction is time-locked; locked payments are not accepted.".into());
    }
    let vp = view_pair(cfg)?;
    let checker = SubKeyChecker::new(&vp, 0..1, minor..minor + 1);
    let owned = tx.check_outputs_with(&checker).map_err(|_| "Could not read the transaction outputs.")?;
    let mut total: u64 = 0;
    for out in owned {
        if out.sub_index() == (Index { major: 0, minor }) {
            let a = out.amount().ok_or("Could not decrypt an output amount.")?;
            total = total.saturating_add(a.as_pico());
        }
    }
    Ok(total)
}

async fn post(base: &str, path: &str, body: Value, max_bytes: u64, transform: &str) -> Result<Value, String> {
    // Classic (version 1) pricing: supported everywhere, priced on max_bytes.
    let body = body.to_string().into_bytes();
    let args = HttpRequestArgs {
        url: format!("{}{}", base.trim_end_matches('/'), path),
        max_response_bytes: Some(max_bytes),
        method: HttpMethod::POST,
        headers: vec![HttpHeader { name: "Content-Type".into(), value: "application/json".into() }],
        body: Some(body),
        transform: Some(transform_context_from_query(transform.to_string(), vec![])),
        is_replicated: None,
        pricing_version: None,
    };
    let request_size = (args.url.len() + 30 + args.body.as_ref().map_or(0, |b| b.len()) + transform.len()) as u64;
    let cycles = ic_cdk::api::cost_http_request(request_size + 100, max_bytes);
    let res: HttpRequestResult = Call::unbounded_wait(Principal::management_canister(), "http_request")
        .with_arg(&args)
        .with_cycles(cycles)
        .await
        .map_err(|e| format!("outcall failed: {e:?}"))?
        .candid()
        .map_err(|e| format!("outcall decode: {e:?}"))?;
    serde_json::from_slice(&res.body).map_err(|_| "unreadable node reply".to_string())
}

/// Asks nodes until two of them answered; both answers must be identical.
async fn two_agreeing(cfg: &Config, start: usize, path: &str, body: &Value, max: u64, transform: &str) -> Result<Value, String> {
    let n = cfg.nodes.len();
    if n < 2 {
        return Err("Payments need at least two Monero nodes configured.".into());
    }
    let mut answers: Vec<Value> = vec![];
    for i in 0..n {
        let node = &cfg.nodes[(start + i) % n];
        if let Ok(v) = post(node, path, body.clone(), max, transform).await {
            if v.get("error").is_none() {
                answers.push(v);
            }
        }
        if answers.len() == 2 {
            break;
        }
    }
    if answers.len() < 2 {
        return Err("Monero nodes are not reachable right now. Please try again in a few minutes.".into());
    }
    if answers[0] != answers[1] {
        return Err("Two Monero nodes disagree about this transaction. Please try again later.".into());
    }
    Ok(answers.remove(0))
}

pub async fn verify(cfg: &Config, txid: &str, minor: u32, seed: u64) -> Result<Outcome, String> {
    let start = (seed % cfg.nodes.len().max(1) as u64) as usize;
    let tx = two_agreeing(
        cfg,
        start,
        "/get_transactions",
        &json!({"txs_hashes": [txid], "decode_as_json": false, "prune": false}),
        512_000,
        "transform_tx",
    )
    .await?;
    if tx.get("missing").is_some() {
        return Ok(Outcome::NotFound);
    }
    if tx["pool"].as_bool() == Some(true) {
        return Ok(Outcome::InPool);
    }
    let height = tx["height"].as_u64().ok_or("bad height")?;
    let hex_blob = tx["hex"].as_str().ok_or("bad tx")?;
    let amount = amount_to_subaddress(cfg, txid, hex_blob, minor)?;

    let target = height + cfg.min_confirmations.max(1) as u64 - 1;
    let head = two_agreeing(
        cfg,
        start + 1,
        "/json_rpc",
        &json!({"jsonrpc": "2.0", "id": "0", "method": "get_block_header_by_height", "params": {"height": target}}),
        16_000,
        "transform_header",
    )
    .await;
    match head {
        Ok(v) if v.get("hash").is_some() => Ok(Outcome::Received { amount, height }),
        _ => Ok(Outcome::Waiting { height }),
    }
}

// ---------- transforms (run by every replica on the raw node reply) ----------

fn canonical(body: Value) -> HttpRequestResult {
    HttpRequestResult { status: 200u32.into(), headers: vec![], body: body.to_string().into_bytes() }
}

/// Keeps only what must be identical across replicas: the blob, its height
/// and whether it is still in the pool. Drops "confirmations", "top_hash",
/// "credits", timestamps, headers.
pub fn transform_tx(args: TransformArgs) -> HttpRequestResult {
    let v: Value = match serde_json::from_slice(&args.response.body) {
        Ok(v) => v,
        Err(_) => return canonical(json!({"error": "unreadable"})),
    };
    let t = v.get("txs").and_then(|t| t.get(0));
    match t {
        None => canonical(json!({"missing": true})),
        Some(t) => {
            let hex = t.get("as_hex").and_then(|h| h.as_str()).unwrap_or("");
            if hex.is_empty() {
                return canonical(json!({"missing": true}));
            }
            canonical(json!({
                "hex": hex,
                "height": t.get("block_height").and_then(|h| h.as_u64()).unwrap_or(0),
                "pool": t.get("in_pool").and_then(|p| p.as_bool()).unwrap_or(false),
            }))
        }
    }
}

/// Keeps only the block hash, or `{"none":true}` if the block does not exist yet.
pub fn transform_header(args: TransformArgs) -> HttpRequestResult {
    let v: Value = serde_json::from_slice(&args.response.body).unwrap_or(Value::Null);
    match v.pointer("/result/block_header/hash").and_then(|h| h.as_str()) {
        Some(h) => canonical(json!({"hash": h})),
        None => canonical(json!({"none": true})),
    }
}
