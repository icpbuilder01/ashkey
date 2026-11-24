use super::*;
use ic_cdk_management_canister::{HttpRequestResult, TransformArgs};

const REAL_TXID: &str = "66a44c6f1ab6238c831f85c654ca75932bc267ce4e3615ee093dc6e4089d422e";
const REAL_TX_HEX: &str = include_str!("../testdata/mainnet_tx_66a44c6f.hex");
const REAL_REPLY: &str = include_str!("../testdata/get_transactions_reply.json");

/// Keys from the monero crate's own test vectors.
fn test_cfg() -> Config {
    Config {
        view_key: Some(hex::decode("77916d0cd56ed1920aef6ca56d8a41bac915b68e4c46a589e0956e27a7b77404").unwrap()),
        spend_pub: Some(
            monero::PublicKey::from_private_key(
                &monero::PrivateKey::from_slice(
                    &hex::decode("8163466f1883598e6dd14027b8da727057165da91485834314f5500a65846f09").unwrap(),
                )
                .unwrap(),
            )
            .as_bytes()
            .to_vec(),
        ),
        ..Config::default()
    }
}

fn args(body: &str) -> TransformArgs {
    TransformArgs {
        response: HttpRequestResult { status: 200u32.into(), headers: vec![], body: body.as_bytes().to_vec() },
        context: vec![],
    }
}

#[test]
fn txid_format() {
    assert!(xmr::valid_txid(REAL_TXID));
    assert!(!xmr::valid_txid(&REAL_TXID.to_uppercase()));
    assert!(!xmr::valid_txid("abc"));
    assert!(!xmr::valid_txid(&"g".repeat(64)));
}

#[test]
fn real_mainnet_tx_parses_and_hashes() {
    // A real Bulletproofs+ transaction from mainnet block 3812936.
    let cfg = test_cfg();
    let got = xmr::amount_to_subaddress(&cfg, REAL_TXID, REAL_TX_HEX.trim(), 7);
    assert_eq!(got, Ok(0), "not ours, so nothing is credited");
}

#[test]
fn substituted_tx_is_rejected() {
    let cfg = test_cfg();
    let other = "00".repeat(32);
    let err = xmr::amount_to_subaddress(&cfg, &other, REAL_TX_HEX.trim(), 7).unwrap_err();
    assert!(err.contains("does not match"), "{err}");
}

#[test]
fn subaddresses_are_distinct_and_stable() {
    let cfg = test_cfg();
    let a1 = xmr::subaddress(&cfg, 1).unwrap();
    let a2 = xmr::subaddress(&cfg, 2).unwrap();
    assert_ne!(a1, a2);
    assert_eq!(a1, xmr::subaddress(&cfg, 1).unwrap());
    assert!(a1.starts_with('8'), "mainnet subaddresses start with 8: {a1}");
    let main = xmr::primary_address(&cfg).unwrap();
    assert!(main.starts_with('4'), "{main}");
    let mut st = cfg.clone();
    st.network = "stagenet".into();
    assert!(xmr::subaddress(&st, 1).unwrap().starts_with('7'));
}

#[test]
fn transform_tx_keeps_only_stable_fields() {
    let out = xmr::transform_tx(args(REAL_REPLY));
    let v: serde_json::Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(v["height"], 3812936);
    assert_eq!(v["pool"], false);
    assert_eq!(v["hex"].as_str().unwrap(), REAL_TX_HEX.trim());
    assert!(v.get("confirmations").is_none());
    assert!(out.headers.is_empty());
    // Two replicas seeing different confirmation counts must agree after transform.
    let other = REAL_REPLY.replace("\"confirmations\": 4", "\"confirmations\": 5");
    assert_eq!(xmr::transform_tx(args(&other)).body, out.body);
}

#[test]
fn transform_tx_missing_and_garbage() {
    let v: serde_json::Value =
        serde_json::from_slice(&xmr::transform_tx(args(r#"{"missed_tx":["ab"],"status":"OK"}"#)).body).unwrap();
    assert_eq!(v["missing"], true);
    let v: serde_json::Value = serde_json::from_slice(&xmr::transform_tx(args("<html>")).body).unwrap();
    assert!(v.get("error").is_some());
}

#[test]
fn transform_header_cases() {
    let ok = r#"{"id":"0","jsonrpc":"2.0","result":{"block_header":{"hash":"abc","height":5,"timestamp":1},"credits":0,"status":"OK"}}"#;
    let v: serde_json::Value = serde_json::from_slice(&xmr::transform_header(args(ok)).body).unwrap();
    assert_eq!(v, serde_json::json!({"hash": "abc"}));
    let future = r#"{"error":{"code":-2,"message":"Requested block height: 9 greater than current top block height: 5"},"id":"0","jsonrpc":"2.0"}"#;
    let v: serde_json::Value = serde_json::from_slice(&xmr::transform_header(args(future)).body).unwrap();
    assert_eq!(v, serde_json::json!({"none": true}));
}

#[test]
fn renewing_and_switching_tiers() {
    let p = Principal::from_slice(&[7; 29]);
    let now = 56 * YEAR; // ~2026
    apply(p, &Product::Vault(1), 1, now);
    let a = account(&p).unwrap();
    assert_eq!((a.vault_tier, a.vault_until), (1, now + YEAR));
    // Same tier: extends.
    apply(p, &Product::Vault(1), 2, now);
    assert_eq!(account(&p).unwrap().vault_until, now + 3 * YEAR);
    // Upgrade to tier 2 with 3 years of tier 1 left: credit = 3y * $15 / $49.
    apply(p, &Product::Vault(2), 1, now);
    let a = account(&p).unwrap();
    assert_eq!(a.vault_tier, 2);
    assert_eq!(a.vault_until, now + YEAR + ((3 * YEAR) as u128 * 1_500 / 4_900) as u64);
    // Heritage is independent.
    apply(p, &Product::Heritage, 1, now);
    assert_eq!(account(&p).unwrap().heritage_until, now + YEAR);
}

#[test]
fn switch_releases_on_silence_or_on_non_payment() {
    let owner = Account { heritage_until: 10 * YEAR, ..Default::default() };
    let s = Switch {
        id: 1,
        owner: Principal::anonymous(),
        meta: vec![],
        ibe_id: vec![0; 32],
        size: 1,
        chunks: 1,
        received_chunks: 1,
        received_bytes: 1,
        complete: true,
        created: 0,
        last_check_in: 9 * YEAR,
        interval_ns: 90 * DAY,
    heirs: vec![],
    };
    // Owner silent: releases 90 days after the last check-in.
    assert_eq!(deadline(&s, &owner), 9 * YEAR + 90 * DAY);
    // Plan lapses first: releases after the payment grace period.
    let lapsed = Account { heritage_until: 9 * YEAR + 10 * DAY, ..Default::default() };
    assert_eq!(deadline(&s, &lapsed), 9 * YEAR + 10 * DAY + HERITAGE_GRACE);
}

#[test]
fn candid_interface_is_exported() {
    let did = __export_service();
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/ashkey.did"), &did).unwrap();
    assert!(did.contains("submit_payment"));
    assert!(!did.contains("transform_tx"), "transforms are hidden");
}

fn put_test_file(p: Principal, id: u64, chunks: u32) {
    FILES.with(|f| {
        f.borrow_mut().insert(
            (p, id),
            FileMeta { meta: vec![1], size: chunks as u64 * 10, chunks, received_chunks: chunks, received_bytes: chunks as u64 * 10, complete: true, created: 0 },
        )
    });
    for i in 0..chunks {
        CHUNKS.with(|c| c.borrow_mut().insert((p, id, i), vec![9; 10]));
    }
}

#[test]
fn unpaid_vaults_self_destruct_after_grace_only() {
    let now = 56 * YEAR;
    let paid = Principal::from_slice(&[1; 29]);
    let grace = Principal::from_slice(&[2; 29]);
    let gone = Principal::from_slice(&[3; 29]);
    put_account(paid, Account { vault_tier: 1, vault_until: now + DAY, used: 30, ..Default::default() });
    put_account(grace, Account { vault_tier: 1, vault_until: now - 3 * DAY, used: 30, ..Default::default() });
    put_account(gone, Account { vault_tier: 1, vault_until: now - VAULT_GRACE - 1, used: 30, ..Default::default() });
    for (i, p) in [paid, grace, gone].into_iter().enumerate() {
        put_test_file(p, 100 + i as u64, 3);
    }
    THUMBS.with(|t| t.borrow_mut().insert((gone, 102), vec![7; 20]));
    THUMBS.with(|t| t.borrow_mut().insert((paid, 100), vec![7; 20]));
    maintenance_at(now, || false);
    assert!(THUMBS.with(|t| t.borrow().get(&(gone, 102)).is_none()), "thumbnail destroyed with the file");
    assert!(THUMBS.with(|t| t.borrow().get(&(paid, 100)).is_some()));
    let chunks_of = |p: Principal| CHUNKS.with(|c| c.borrow().keys_range((p, 0, 0)..=(p, u64::MAX, u32::MAX)).count());
    assert_eq!(chunks_of(paid), 3, "paid vault untouched");
    assert_eq!(chunks_of(grace), 3, "still in grace: readable");
    assert_eq!(chunks_of(gone), 0, "past grace: destroyed");
    assert!(FILES.with(|f| f.borrow().get(&(gone, 102)).is_none()));
    let a = account(&gone).unwrap();
    assert_eq!((a.vault_tier, a.used), (0, 0));
}

#[test]
fn released_switches_are_destroyed_after_keep_period() {
    let now = 57 * YEAR;
    let owner = Principal::from_slice(&[4; 29]);
    put_account(owner, Account { heritage_until: now + YEAR, ..Default::default() });
    let mk = |id: u64, last: u64| {
        SWITCHES.with(|m| {
            m.borrow_mut().insert(
                id,
                Switch {
                    id,
                    owner,
                    meta: vec![],
                    ibe_id: vec![0; 32],
                    size: 1,
                    chunks: 1,
                    received_chunks: 1,
                    received_bytes: 1,
                    complete: true,
                    created: 0,
                    last_check_in: last,
                    interval_ns: 30 * DAY,
                    heirs: vec![],
                },
            )
        });
        OWNER_SWITCHES.with(|m| m.borrow_mut().insert((owner, id), ()));
        SWITCH_CHUNKS.with(|c| c.borrow_mut().insert((id, 0), vec![1]));
    };
    mk(500, now - 10 * DAY); // armed
    mk(501, now - 40 * DAY); // released 10 days ago: still openable
    mk(502, now - 30 * DAY - RELEASED_KEEP - DAY); // released long ago
    maintenance_at(now, || false);
    assert!(SWITCHES.with(|m| m.borrow().get(&500).is_some()));
    assert!(SWITCHES.with(|m| m.borrow().get(&501).is_some()));
    assert!(SWITCHES.with(|m| m.borrow().get(&502).is_none()));
    assert!(SWITCH_CHUNKS.with(|c| c.borrow().get(&(502, 0)).is_none()));
}

#[test]
fn usd_quotes_round_up_to_a_ten_thousandth() {
    // $15 at $492.61/XMR = 0.030449... → 0.0305 XMR
    assert_eq!(price::quote(1_500, 49_261), 30_500_000_000);
    // exact amounts stay exact
    assert_eq!(price::quote(50_000, 50_000), 1_000_000_000_000);
    assert_eq!(price::quote(1, 49_261) % price::ROUND_PICO, 0);
}

#[test]
fn price_sources_must_agree() {
    assert_eq!(price::combine(&[49_261, 49_311, 49_100]), Some(49_100), "all agree: lowest");
    assert_eq!(price::combine(&[49_261, 60_000]), None, "two sources 20 % apart: refuse");
    assert_eq!(price::combine(&[10_000, 49_261, 49_311]), Some(49_261), "outlier ignored");
    assert_eq!(price::combine(&[49_261]), None, "one source is not enough");
    assert_eq!(price::combine(&[]), None);
}

#[test]
fn price_transforms_pick_the_last_closed_candle() {
    let kraken = r#"{"error":[],"result":{"XXMRZUSD":[[1795464000,"502.39","503.93","493.11","496.10","497.72","694.3",853],[1795467600,"496.10","498.29","489.42","492.61","492.48","688.9",674],[1795471200,"492.58","492.64","484.34","484.34","489.02","319.4",467]],"last":1795467600}}"#;
    let v: serde_json::Value = serde_json::from_slice(&price::transform_kraken(args(kraken)).body).unwrap();
    assert_eq!(v["cents"], 49_261);
    let kucoin = r#"{"code":"200000","data":[["1795471200","493.25","484.77","493.68","484.1","2863","1399780"],["1795467600","496.95","493.11","499.19","489.53","2368","1168762"]]}"#;
    let v: serde_json::Value = serde_json::from_slice(&price::transform_kucoin(args(kucoin)).body).unwrap();
    assert_eq!(v["cents"], 49_311);
    let gecko = "[[1795388400000,492.09,493.35,490.86,492.87],[1795390200000,492.9,495.13,492.9,494.45],[1795392000000,494.45,494.89,492.96,493.91]]";
    let v: serde_json::Value = serde_json::from_slice(&price::transform_coingecko(args(gecko)).body).unwrap();
    assert_eq!(v["cents"], 49_445);
    let v: serde_json::Value = serde_json::from_slice(&price::transform_kraken(args("<html>rate limited")).body).unwrap();
    assert_eq!(v["none"], true);
}

#[test]
fn order_references_hide_the_order_number() {
    update_config(|c| c.order_salt = Some(vec![42; 32]));
    let a = order_ref(1).unwrap();
    let b = order_ref(2).unwrap();
    assert_ne!(a, b);
    assert_eq!(a.len(), 9);
    assert_eq!(&a[4..5], "-");
    assert!(a.chars().all(|c| c == '-' || CROCKFORD.contains(&(c as u8))), "{a}");
    assert_eq!(normalize_ref(&a.to_lowercase().replace('-', " ")), a);
    // A different salt gives unrelated references.
    update_config(|c| c.order_salt = Some(vec![7; 32]));
    assert_ne!(order_ref(1).unwrap(), a);
}
