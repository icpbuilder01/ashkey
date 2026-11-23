//! Ashkey — an encrypted vault and a dead man's switch, paid in Monero.
//!
//! Trust model, in short (details in ../../SECURITY.md):
//!  - Accounts are Mullvad-style account numbers. The browser turns the
//!    account number into an Ed25519 identity (which signs calls) and into the
//!    vault encryption key. This canister only ever sees the resulting public
//!    principal: it cannot recover the account number, and it never holds a
//!    key able to decrypt a vault.
//!  - Vault files, file names and heritage contents are encrypted in the
//!    browser (AES-256-GCM) before upload.
//!  - Heritage ("switch") contents are additionally locked with vetKeys
//!    identity-based encryption: the subnet only releases the decryption key
//!    once the owner has stopped checking in, and only to someone holding a
//!    heir link (whose secret never reaches this canister either).
//!  - Payments are verified here with the service wallet's VIEW key only.
//!  - Unpaid vaults self-destruct `VAULT_GRACE` after expiry.

mod price;
mod store;
mod xmr;

use candid::{CandidType, Deserialize, Principal};
use ic_cdk::api::{
    accept_message, canister_cycle_balance, instruction_counter, is_controller, msg_caller,
    msg_method_name, time,
};
use ic_cdk_management_canister::{
    vetkd_derive_key, vetkd_public_key, HttpRequestResult, TransformArgs, VetKDCurve,
    VetKDDeriveKeyArgs, VetKDKeyId, VetKDPublicKeyArgs,
};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;
use store::*;

// ---------------------------------------------------------------- constants

const SEC: u64 = 1_000_000_000;
const DAY: u64 = 86_400 * SEC;
const YEAR: u64 = 365 * DAY;

/// Vault sizes for tiers 1, 2, 3 (decimal gigabytes).
const TIER_BYTES: [u64; 3] = [1_000_000_000, 5_000_000_000, 20_000_000_000];
/// After the paid period ends, files stay readable (not writable) this long,
/// then they are destroyed automatically.
const VAULT_GRACE: u64 = 7 * DAY;
/// If a heritage plan is not renewed, armed switches release to heirs this
/// long after expiry (instead of being destroyed: heirs come first).
const HERITAGE_GRACE: u64 = 30 * DAY;
/// Released switches stay openable this long, then they are destroyed.
const RELEASED_KEEP: u64 = 180 * DAY;
/// Heritage contents: total per account (ciphertext bytes).
const HERITAGE_MAX_BYTES: u64 = 10_500_000;
const MAX_SWITCHES: usize = 3;
const MAX_HEIRS: usize = 5;
const MAX_OPENS_PER_HEIR: u32 = 3;
const MAX_OPENS_PER_SWITCH: u32 = 10;
/// Default floor for switch intervals; a controller can lower it (never below 60 s) for tests.
const MIN_INTERVAL: u64 = 7 * DAY;
const MAX_INTERVAL: u64 = 730 * DAY;
/// Max ciphertext bytes per upload chunk (1 MiB of plaintext + AES-GCM overhead).
const MAX_CHUNK: usize = 1_048_576 + 64;
const MAX_META: usize = 4_096;
/// Encrypted image thumbnail, made by the browser (counted in the quota).
const MAX_THUMB: usize = 48_000;
const MAX_FILES_PER_ACCOUNT: usize = 20_000;
const INCOMPLETE_TTL: u64 = DAY;
const UNPAID_ORDER_TTL: u64 = 30 * DAY;
const MAX_PENDING_ORDERS: usize = 5;
const HERITAGE_CONTEXT: &[u8] = b"ashkey-heritage-v1";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Default yearly prices in US cents (vault tiers 1..3, heritage).
const DEFAULT_USD_VAULT: [u64; 3] = [1_500, 4_900, 16_900];
const DEFAULT_USD_HERITAGE: u64 = 2_500;

type R<T> = Result<T, String>;

// ---------------------------------------------------------------- heap-only rate limits

thread_local! {
    /// (caller, method) → last call time. Reset on upgrade, which is fine.
    static LAST_CALL: RefCell<HashMap<(Principal, &'static str), u64>> = RefCell::new(HashMap::new());
    /// Orders created in the current minute (global spam brake).
    static ORDER_BUCKET: RefCell<(u64, u32)> = const { RefCell::new((0, 0)) };
}

fn throttle(p: Principal, method: &'static str, gap: u64) -> R<()> {
    let now = time();
    LAST_CALL.with(|l| {
        let mut l = l.borrow_mut();
        if let Some(t) = l.get(&(p, method)) {
            if now < t + gap {
                return Err(format!("Please wait {} s before trying again.", (t + gap - now) / SEC + 1));
            }
        }
        if l.len() > 50_000 {
            l.clear();
        }
        l.insert((p, method), now);
        Ok(())
    })
}

fn caller() -> R<Principal> {
    let p = msg_caller();
    if p == Principal::anonymous() {
        return Err("Sign in with your account number first.".into());
    }
    Ok(p)
}

fn admin() -> R<Principal> {
    let p = msg_caller();
    if !is_controller(&p) {
        return Err("Controllers only.".into());
    }
    Ok(p)
}

fn sha256(b: &[u8]) -> Vec<u8> {
    Sha256::digest(b).to_vec()
}

// ---------------------------------------------------------------- public views

#[derive(CandidType)]
pub struct Info {
    version: String,
    network: String,
    payments_ready: bool,
    paused: bool,
    /// Current XMR equivalents (piconero) of the USD prices; 0 when no fresh rate.
    vault_prices: Vec<u64>,
    heritage_price: u64,
    /// Yearly prices in US cents.
    usd_vault_prices: Vec<u64>,
    usd_heritage_price: u64,
    /// Agreed XMR rate in US cents, and when it was last confirmed (ns).
    xmr_usd_cents: Option<u64>,
    xmr_usd_at: Option<u64>,
    quote_valid_sec: u64,
    tier_bytes: Vec<u64>,
    min_confirmations: u32,
    vault_grace_sec: u64,
    heritage_grace_sec: u64,
    released_keep_sec: u64,
    heritage_max_bytes: u64,
    max_switches: u32,
    max_heirs: u32,
    max_chunk: u64,
    key_name: String,
    heritage_context: Vec<u8>,
    heritage_public_key: Option<Vec<u8>>,
    nodes: Vec<String>,
}

#[derive(CandidType)]
pub struct AccountView {
    exists: bool,
    now: u64,
    vault_tier: u8,
    vault_until: u64,
    vault_active: bool,
    /// When files will be destroyed if not renewed (only once the plan expired).
    vault_destroy_at: Option<u64>,
    quota: u64,
    used: u64,
    heritage_until: u64,
    heritage_active: bool,
}

#[derive(CandidType)]
pub struct OrderView {
    id: u64,
    product: Product,
    years: u8,
    amount: u64,
    received: u64,
    address: String,
    created: u64,
    paid: bool,
    txs: Vec<String>,
    usd_cents: Option<u64>,
    quote_until: Option<u64>,
}

impl From<Order> for OrderView {
    fn from(o: Order) -> Self {
        OrderView {
            id: o.id,
            product: o.product,
            years: o.years,
            amount: o.amount,
            received: o.received,
            address: o.address,
            created: o.created,
            paid: o.status == OrderStatus::Paid,
            txs: o.txs,
            usd_cents: o.usd_cents,
            quote_until: o.quote_until,
        }
    }
}

#[derive(CandidType)]
pub enum PaymentStatus {
    /// Transaction not known to the nodes (yet). Wait a minute and retry.
    NotFound,
    /// Seen in the mempool, not mined yet.
    InPool,
    /// Mined at `height`; needs `needed` confirmations in total.
    Waiting { height: u64, needed: u32 },
    /// Credited. `order.paid` tells whether the order is now fully paid.
    Credited { amount: u64, order: OrderView },
}

#[derive(CandidType)]
pub struct FileView {
    id: u64,
    meta: Vec<u8>,
    size: u64,
    chunks: u32,
    complete: bool,
    created: u64,
    has_thumb: bool,
}

#[derive(CandidType)]
pub struct SwitchView {
    id: u64,
    meta: Vec<u8>,
    size: u64,
    chunks: u32,
    complete: bool,
    created: u64,
    last_check_in: u64,
    interval_sec: u64,
    deadline: u64,
    released: bool,
    destroy_at: u64,
    heir_opens: Vec<u32>,
}

#[derive(CandidType)]
pub struct HeirView {
    released: bool,
    deadline: u64,
    size: u64,
    chunks: u32,
    opens_left: u32,
}

#[derive(CandidType)]
pub struct Opened {
    ibe_id: Vec<u8>,
    wrapped_key: Vec<u8>,
    encrypted_key: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
pub struct HeirIn {
    claim_hash: Vec<u8>,
    wrapped_key: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
pub struct SwitchIn {
    meta: Vec<u8>,
    ibe_id: Vec<u8>,
    size: u64,
    chunks: u32,
    interval_sec: u64,
    heirs: Vec<HeirIn>,
}

#[derive(CandidType)]
pub struct Stats {
    accounts: u64,
    orders: u64,
    paid_orders: u64,
    received_pico: u64,
    files: u64,
    vault_bytes: u64,
    switches: u64,
    cycles: u128,
}

// ---------------------------------------------------------------- helpers

fn vault_active(a: &Account, now: u64) -> bool {
    a.vault_tier > 0 && a.vault_until > now
}

fn quota(a: &Account) -> u64 {
    if a.vault_tier == 0 {
        0
    } else {
        TIER_BYTES[(a.vault_tier - 1) as usize]
    }
}

fn heritage_active(a: &Account, now: u64) -> bool {
    a.heritage_until > now
}

/// When a switch releases: the owner stopped checking in, or stopped paying
/// (after a grace period). Whichever comes first.
fn deadline(s: &Switch, owner: &Account) -> u64 {
    let by_check_in = s.last_check_in.saturating_add(s.interval_ns);
    let by_payment = owner.heritage_until.saturating_add(HERITAGE_GRACE);
    by_check_in.min(by_payment)
}

fn switch_view(s: &Switch, owner: &Account, now: u64) -> SwitchView {
    let d = deadline(s, owner);
    SwitchView {
        id: s.id,
        meta: s.meta.clone(),
        size: s.size,
        chunks: s.chunks,
        complete: s.complete,
        created: s.created,
        last_check_in: s.last_check_in,
        interval_sec: s.interval_ns / SEC,
        deadline: d,
        released: now >= d,
        destroy_at: d.saturating_add(RELEASED_KEEP),
        heir_opens: s.heirs.iter().map(|h| h.opens).collect(),
    }
}

fn usd_vault(cfg: &Config) -> Vec<u64> {
    cfg.usd_vault_prices.clone().unwrap_or_else(|| DEFAULT_USD_VAULT.to_vec())
}

fn usd_heritage(cfg: &Config) -> u64 {
    cfg.usd_heritage_price.unwrap_or(DEFAULT_USD_HERITAGE)
}

/// Yearly price of a product, in US cents.
fn product_usd(cfg: &Config, p: &Product) -> R<u64> {
    match p {
        Product::Vault(t) if (1..=3).contains(t) => Ok(usd_vault(cfg)[(*t - 1) as usize]),
        Product::Vault(_) => Err("Unknown vault tier.".into()),
        Product::Heritage => Ok(usd_heritage(cfg)),
    }
}

/// The XMR rate, if recent enough to sell at.
fn fresh_rate(cfg: &Config, now: u64) -> Option<u64> {
    match (cfg.xmr_usd_cents, cfg.xmr_usd_at) {
        (Some(c), Some(at)) if now.saturating_sub(at) <= price::MAX_AGE_NS => Some(c),
        _ => None,
    }
}

/// Grants what an order paid for.
fn apply(owner: Principal, product: &Product, years: u8, now: u64) {
    let cfg = config();
    let mut a = account(&owner).unwrap_or(Account { created: now, ..Default::default() });
    let span = years as u64 * YEAR;
    match product {
        Product::Vault(t) => {
            if a.vault_tier == *t && a.vault_until > now {
                a.vault_until += span;
            } else if a.vault_tier != 0 && a.vault_until > now {
                // Switching tier: the unused time of the old tier is converted
                // at the ratio of the two prices.
                let prices = usd_vault(&cfg);
                let old = prices.get((a.vault_tier - 1) as usize).copied().unwrap_or(1).max(1) as u128;
                let new = prices.get((*t - 1) as usize).copied().unwrap_or(1).max(1) as u128;
                let credit = ((a.vault_until - now) as u128 * old / new) as u64;
                a.vault_tier = *t;
                a.vault_until = now + span + credit;
            } else {
                a.vault_tier = *t;
                a.vault_until = now + span;
            }
        }
        Product::Heritage => {
            a.heritage_until = a.heritage_until.max(now) + span;
        }
    }
    put_account(owner, a);
}

fn owned_file(p: Principal, id: u64) -> R<FileMeta> {
    FILES.with(|f| f.borrow().get(&(p, id))).ok_or_else(|| "File not found.".into())
}

fn owned_switch(p: Principal, id: u64) -> R<Switch> {
    let s = SWITCHES.with(|m| m.borrow().get(&id)).ok_or("Switch not found.")?;
    if s.owner != p {
        return Err("Switch not found.".into());
    }
    Ok(s)
}

fn check_proof(s: &Switch, proof: &[u8]) -> Option<usize> {
    let h = sha256(proof);
    s.heirs.iter().position(|x| x.claim_hash == h)
}

fn min_interval() -> u64 {
    config().min_interval_sec.map(|s| s * SEC).unwrap_or(MIN_INTERVAL)
}

fn key_id(cfg: &Config) -> VetKDKeyId {
    VetKDKeyId { curve: VetKDCurve::Bls12_381_G2, name: cfg.key_name.clone() }
}

// ---------------------------------------------------------------- info & account

#[ic_cdk::query]
fn get_info() -> Info {
    let cfg = config();
    Info {
        version: VERSION.into(),
        network: cfg.network.clone(),
        payments_ready: xmr::view_pair(&cfg).is_ok() && cfg.nodes.len() >= 2,
        paused: cfg.paused,
        vault_prices: usd_vault(&cfg).iter().map(|u| fresh_rate(&cfg, time()).map_or(0, |r| price::quote(*u, r))).collect(),
        heritage_price: fresh_rate(&cfg, time()).map_or(0, |r| price::quote(usd_heritage(&cfg), r)),
        usd_vault_prices: usd_vault(&cfg),
        usd_heritage_price: usd_heritage(&cfg),
        xmr_usd_cents: cfg.xmr_usd_cents,
        xmr_usd_at: cfg.xmr_usd_at,
        quote_valid_sec: price::QUOTE_NS / SEC,
        tier_bytes: TIER_BYTES.to_vec(),
        min_confirmations: cfg.min_confirmations,
        vault_grace_sec: VAULT_GRACE / SEC,
        heritage_grace_sec: HERITAGE_GRACE / SEC,
        released_keep_sec: RELEASED_KEEP / SEC,
        heritage_max_bytes: HERITAGE_MAX_BYTES,
        max_switches: MAX_SWITCHES as u32,
        max_heirs: MAX_HEIRS as u32,
        max_chunk: MAX_CHUNK as u64,
        key_name: cfg.key_name.clone(),
        heritage_context: HERITAGE_CONTEXT.to_vec(),
        heritage_public_key: cfg.heritage_public_key.clone(),
        nodes: cfg.nodes.clone(),
    }
}

#[ic_cdk::query]
fn me() -> AccountView {
    let now = time();
    let p = msg_caller();
    match account(&p) {
        None => AccountView {
            exists: false,
            now,
            vault_tier: 0,
            vault_until: 0,
            vault_active: false,
            vault_destroy_at: None,
            quota: 0,
            used: 0,
            heritage_until: 0,
            heritage_active: false,
        },
        Some(a) => AccountView {
            exists: true,
            now,
            vault_tier: a.vault_tier,
            vault_until: a.vault_until,
            vault_active: vault_active(&a, now),
            vault_destroy_at: if a.vault_tier > 0 && !vault_active(&a, now) { Some(a.vault_until + VAULT_GRACE) } else { None },
            quota: quota(&a),
            used: a.used,
            heritage_until: a.heritage_until,
            heritage_active: heritage_active(&a, now),
        },
    }
}

// ---------------------------------------------------------------- orders & payments

#[ic_cdk::update]
fn create_order(product: Product, years: u8) -> R<OrderView> {
    let p = caller()?;
    let cfg = config();
    if cfg.paused {
        return Err("New orders are paused for maintenance. Existing accounts are not affected.".into());
    }
    if !(1..=3).contains(&years) {
        return Err("Choose 1 to 3 years.".into());
    }
    let usd = product_usd(&cfg, &product)? * years as u64;
    let rate = fresh_rate(&cfg, time()).ok_or("The XMR price feed is temporarily unavailable, so new orders are paused. Please try again later.")?;
    if let (Product::Vault(t), Some(a)) = (&product, account(&p)) {
        if a.used > TIER_BYTES[(*t - 1) as usize] {
            return Err("Your vault holds more than this tier allows. Delete files first.".into());
        }
    }
    let pending = OWNER_ORDERS.with(|o| {
        o.borrow()
            .range((p, 0)..=(p, u64::MAX))
            .filter(|e| ORDERS.with(|m| m.borrow().get(&e.key().1).map(|x| x.status == OrderStatus::Pending).unwrap_or(false)))
            .count()
    });
    if pending >= MAX_PENDING_ORDERS {
        return Err("You already have several unpaid orders. Pay or wait for one to expire.".into());
    }
    throttle(p, "create_order", 3 * SEC)?;
    let now = time();
    ORDER_BUCKET.with(|b| {
        let mut b = b.borrow_mut();
        let minute = now / (60 * SEC);
        if b.0 != minute {
            *b = (minute, 0);
        }
        if b.1 >= 120 {
            return Err("Too many new orders right now. Try again in a minute.".to_string());
        }
        b.1 += 1;
        Ok(())
    })?;
    let id = cfg.next_order;
    if id > u32::MAX as u64 {
        return Err("Order space exhausted.".into());
    }
    let address = xmr::subaddress(&cfg, id as u32)?;
    update_config(|c| c.next_order += 1);
    let order = Order {
        id,
        owner: p,
        product,
        years,
        amount: price::quote(usd, rate),
        received: 0,
        address,
        created: now,
        status: OrderStatus::Pending,
        txs: vec![],
        usd_cents: Some(usd),
        quote_until: Some(now + price::QUOTE_NS),
    };
    ORDERS.with(|m| m.borrow_mut().insert(id, order.clone()));
    OWNER_ORDERS.with(|m| m.borrow_mut().insert((p, id), ()));
    Ok(order.into())
}

#[ic_cdk::query]
fn my_orders() -> Vec<OrderView> {
    let p = msg_caller();
    OWNER_ORDERS.with(|o| {
        o.borrow()
            .range((p, 0)..=(p, u64::MAX))
            .filter_map(|e| ORDERS.with(|m| m.borrow().get(&e.key().1)))
            .map(OrderView::from)
            .collect()
    })
}

#[ic_cdk::update]
async fn submit_payment(order_id: u64, txid: String) -> R<PaymentStatus> {
    let p = caller()?;
    let txid = txid.trim().to_lowercase();
    if !xmr::valid_txid(&txid) {
        return Err("A transaction ID is 64 hexadecimal characters.".into());
    }
    let order = ORDERS.with(|m| m.borrow().get(&order_id)).ok_or("Order not found.")?;
    if order.owner != p {
        return Err("Order not found.".into());
    }
    if order.status == OrderStatus::Paid {
        return Err("This order is already paid.".into());
    }
    if USED_TX.with(|u| u.borrow().contains_key(&txid)) {
        return Err("This transaction was already used for a payment.".into());
    }
    throttle(p, "submit_payment", 20 * SEC)?;
    let cfg = config();
    let outcome = xmr::verify(&cfg, &txid, order_id as u32, time() / SEC).await?;
    match outcome {
        xmr::Outcome::NotFound => Ok(PaymentStatus::NotFound),
        xmr::Outcome::InPool => Ok(PaymentStatus::InPool),
        xmr::Outcome::Waiting { height } => Ok(PaymentStatus::Waiting { height, needed: cfg.min_confirmations }),
        xmr::Outcome::Received { amount, .. } => {
            if amount == 0 {
                return Err("This transaction sent nothing to this order's address.".into());
            }
            // State may have changed during the outcalls: check again.
            if USED_TX.with(|u| u.borrow().contains_key(&txid)) {
                return Err("This transaction was already used for a payment.".into());
            }
            let mut o = ORDERS.with(|m| m.borrow().get(&order_id)).ok_or("Order not found.")?;
            if o.status == OrderStatus::Paid {
                return Err("This order is already paid.".into());
            }
            // A quote is guaranteed for 24 h. Paid later: the dollar price is
            // converted again at the current rate (if one is available).
            let now = time();
            if let (Some(usd), Some(until)) = (o.usd_cents, o.quote_until) {
                if now > until {
                    if let Some(rate) = fresh_rate(&config(), now) {
                        o.amount = price::quote(usd, rate);
                        o.quote_until = Some(now + price::QUOTE_NS);
                    }
                }
            }
            USED_TX.with(|u| u.borrow_mut().insert(txid.clone(), order_id));
            o.received = o.received.saturating_add(amount);
            o.txs.push(txid);
            if o.received >= o.amount {
                o.status = OrderStatus::Paid;
                apply(o.owner, &o.product, o.years, time());
            }
            ORDERS.with(|m| m.borrow_mut().insert(order_id, o.clone()));
            Ok(PaymentStatus::Credited { amount, order: o.into() })
        }
    }
}

// ---------------------------------------------------------------- vault

#[ic_cdk::update]
fn file_begin(meta: Vec<u8>, size: u64, chunks: u32) -> R<u64> {
    let p = caller()?;
    let now = time();
    let mut a = account(&p).ok_or("No vault plan on this account.")?;
    if !vault_active(&a, now) {
        return Err("Your vault plan is not active. Renew it to upload.".into());
    }
    if meta.len() > MAX_META || size == 0 || chunks == 0 || (chunks as u64) * (MAX_CHUNK as u64) < size || (chunks as u64) > size {
        return Err("Invalid upload.".into());
    }
    if a.used.saturating_add(size) > quota(&a) {
        return Err("Not enough space left in your vault.".into());
    }
    let count = FILES.with(|f| f.borrow().range((p, 0)..=(p, u64::MAX)).count());
    if count >= MAX_FILES_PER_ACCOUNT {
        return Err("Too many files in this vault.".into());
    }
    let id = config().next_file;
    update_config(|c| c.next_file += 1);
    a.used += size;
    put_account(p, a);
    FILES.with(|f| {
        f.borrow_mut().insert(
            (p, id),
            FileMeta { meta, size, chunks, received_chunks: 0, received_bytes: 0, complete: false, created: now },
        )
    });
    Ok(id)
}

#[ic_cdk::update]
fn file_put(id: u64, index: u32, data: Vec<u8>) -> R<()> {
    let p = caller()?;
    let now = time();
    let a = account(&p).ok_or("No vault plan on this account.")?;
    if !vault_active(&a, now) {
        return Err("Your vault plan is not active.".into());
    }
    let mut f = owned_file(p, id)?;
    if f.complete || index >= f.chunks || data.is_empty() || data.len() > MAX_CHUNK {
        return Err("Invalid chunk.".into());
    }
    if f.received_bytes + data.len() as u64 > f.size {
        return Err("Chunk exceeds the announced file size.".into());
    }
    if CHUNKS.with(|c| c.borrow().contains_key(&(p, id, index))) {
        return Ok(()); // already stored (retry)
    }
    f.received_bytes += data.len() as u64;
    f.received_chunks += 1;
    CHUNKS.with(|c| c.borrow_mut().insert((p, id, index), data));
    FILES.with(|m| m.borrow_mut().insert((p, id), f));
    Ok(())
}

#[ic_cdk::update]
fn file_commit(id: u64) -> R<()> {
    let p = caller()?;
    let mut f = owned_file(p, id)?;
    if f.complete {
        return Ok(());
    }
    if f.received_chunks != f.chunks {
        return Err("Some chunks are missing.".into());
    }
    if let Some(mut a) = account(&p) {
        a.used = a.used.saturating_sub(f.size - f.received_bytes);
        put_account(p, a);
    }
    f.size = f.received_bytes;
    f.complete = true;
    FILES.with(|m| m.borrow_mut().insert((p, id), f));
    Ok(())
}

#[ic_cdk::update]
fn file_set_meta(id: u64, meta: Vec<u8>) -> R<()> {
    let p = caller()?;
    if meta.len() > MAX_META {
        return Err("Too long.".into());
    }
    let mut f = owned_file(p, id)?;
    f.meta = meta;
    FILES.with(|m| m.borrow_mut().insert((p, id), f));
    Ok(())
}

#[ic_cdk::query]
fn file_list() -> Vec<FileView> {
    let p = msg_caller();
    FILES.with(|f| {
        f.borrow()
            .range((p, 0)..=(p, u64::MAX))
            .map(|e| {
                let (k, v) = e.into_pair();
                let has_thumb = THUMBS.with(|t| t.borrow().contains_key(&k));
                FileView { id: k.1, meta: v.meta, size: v.size, chunks: v.chunks, complete: v.complete, created: v.created, has_thumb }
            })
            .collect()
    })
}

/// Stores (or replaces) the encrypted thumbnail of an image.
#[ic_cdk::update]
fn file_set_thumb(id: u64, data: Vec<u8>) -> R<()> {
    let p = caller()?;
    let now = time();
    let mut a = account(&p).ok_or("No vault plan on this account.")?;
    if !vault_active(&a, now) {
        return Err("Your vault plan is not active.".into());
    }
    owned_file(p, id)?;
    if data.is_empty() || data.len() > MAX_THUMB {
        return Err("Invalid thumbnail.".into());
    }
    let old = THUMBS.with(|t| t.borrow().get(&(p, id))).map_or(0, |t| t.len() as u64);
    let used = a.used.saturating_sub(old) + data.len() as u64;
    if used > quota(&a) {
        return Err("Not enough space left in your vault.".into());
    }
    a.used = used;
    put_account(p, a);
    THUMBS.with(|t| t.borrow_mut().insert((p, id), data));
    Ok(())
}

#[ic_cdk::query]
fn file_thumb(id: u64) -> R<Vec<u8>> {
    let p = msg_caller();
    THUMBS.with(|t| t.borrow().get(&(p, id))).ok_or_else(|| "No thumbnail.".into())
}

#[ic_cdk::query]
fn file_chunk(id: u64, index: u32) -> R<Vec<u8>> {
    let p = msg_caller();
    CHUNKS.with(|c| c.borrow().get(&(p, id, index))).ok_or_else(|| "Chunk not found.".into())
}

fn delete_file(p: Principal, id: u64) -> u64 {
    let f = match FILES.with(|m| m.borrow_mut().remove(&(p, id))) {
        Some(f) => f,
        None => return 0,
    };
    let thumb = THUMBS.with(|t| t.borrow_mut().remove(&(p, id))).map_or(0, |t| t.len() as u64);
    let keys: Vec<_> = CHUNKS.with(|c| c.borrow().keys_range((p, id, 0)..=(p, id, u32::MAX)).collect());
    CHUNKS.with(|c| {
        let mut c = c.borrow_mut();
        for k in keys {
            c.remove(&k);
        }
    });
    f.size + thumb
}

#[ic_cdk::update]
fn file_delete(id: u64) -> R<()> {
    let p = caller()?;
    owned_file(p, id)?;
    let freed = delete_file(p, id);
    if let Some(mut a) = account(&p) {
        a.used = a.used.saturating_sub(freed);
        put_account(p, a);
    }
    Ok(())
}

// ---------------------------------------------------------------- heritage (owner side)

/// Fetches and caches this canister's vetKD public key for heritage.
/// Browsers also derive it offline from the IC master key and compare.
#[ic_cdk::update]
async fn heritage_public_key() -> R<Vec<u8>> {
    let cfg = config();
    if let Some(k) = cfg.heritage_public_key {
        return Ok(k);
    }
    let r = vetkd_public_key(&VetKDPublicKeyArgs { canister_id: None, context: HERITAGE_CONTEXT.to_vec(), key_id: key_id(&cfg) })
        .await
        .map_err(|e| format!("vetKD unavailable: {e:?}"))?;
    update_config(|c| c.heritage_public_key = Some(r.public_key.clone()));
    Ok(r.public_key)
}

fn heritage_bytes_used(p: Principal) -> u64 {
    OWNER_SWITCHES.with(|o| {
        o.borrow()
            .keys_range((p, 0)..=(p, u64::MAX))
            .filter_map(|(_, id)| SWITCHES.with(|s| s.borrow().get(&id)))
            .map(|s| s.size)
            .sum()
    })
}

#[ic_cdk::update]
fn switch_create(a: SwitchIn) -> R<u64> {
    let p = caller()?;
    let now = time();
    let acc = account(&p).ok_or("No heritage plan on this account.")?;
    if !heritage_active(&acc, now) {
        return Err("Your heritage plan is not active.".into());
    }
    let count = OWNER_SWITCHES.with(|o| o.borrow().keys_range((p, 0)..=(p, u64::MAX)).count());
    if count >= MAX_SWITCHES {
        return Err(format!("You can keep up to {MAX_SWITCHES} switches."));
    }
    if a.meta.len() > MAX_META || a.ibe_id.len() != 32 {
        return Err("Invalid switch.".into());
    }
    if a.size == 0 || a.chunks == 0 || (a.chunks as u64) * (MAX_CHUNK as u64) < a.size || a.chunks as u64 > a.size {
        return Err("Invalid content size.".into());
    }
    if heritage_bytes_used(p) + a.size > HERITAGE_MAX_BYTES {
        return Err("Heritage contents are limited to 10 MB per account.".into());
    }
    let interval = a.interval_sec.saturating_mul(SEC);
    if !(min_interval()..=MAX_INTERVAL).contains(&interval) {
        return Err("Choose an interval between 7 and 730 days.".into());
    }
    if a.heirs.is_empty() || a.heirs.len() > MAX_HEIRS {
        return Err(format!("Add 1 to {MAX_HEIRS} heirs."));
    }
    if a.heirs.iter().any(|h| h.claim_hash.len() != 32 || h.wrapped_key.is_empty() || h.wrapped_key.len() > 1024) {
        return Err("Invalid heir data.".into());
    }
    let id = config().next_heritage;
    update_config(|c| c.next_heritage += 1);
    let s = Switch {
        id,
        owner: p,
        meta: a.meta,
        ibe_id: a.ibe_id,
        size: a.size,
        chunks: a.chunks,
        received_chunks: 0,
        received_bytes: 0,
        complete: false,
        created: now,
        last_check_in: now,
        interval_ns: interval,
        heirs: a.heirs.into_iter().map(|h| Heir { claim_hash: h.claim_hash, wrapped_key: h.wrapped_key, opens: 0 }).collect(),
    };
    SWITCHES.with(|m| m.borrow_mut().insert(id, s));
    OWNER_SWITCHES.with(|m| m.borrow_mut().insert((p, id), ()));
    Ok(id)
}

#[ic_cdk::update]
fn switch_put(id: u64, index: u32, data: Vec<u8>) -> R<()> {
    let p = caller()?;
    let mut s = owned_switch(p, id)?;
    if s.complete || index >= s.chunks || data.is_empty() || data.len() > MAX_CHUNK {
        return Err("Invalid chunk.".into());
    }
    if s.received_bytes + data.len() as u64 > s.size {
        return Err("Chunk exceeds the announced size.".into());
    }
    if SWITCH_CHUNKS.with(|c| c.borrow().contains_key(&(id, index))) {
        return Ok(());
    }
    s.received_bytes += data.len() as u64;
    s.received_chunks += 1;
    SWITCH_CHUNKS.with(|c| c.borrow_mut().insert((id, index), data));
    SWITCHES.with(|m| m.borrow_mut().insert(id, s));
    Ok(())
}

#[ic_cdk::update]
fn switch_commit(id: u64) -> R<()> {
    let p = caller()?;
    let mut s = owned_switch(p, id)?;
    if s.received_chunks != s.chunks {
        return Err("Some chunks are missing.".into());
    }
    s.size = s.received_bytes;
    s.complete = true;
    SWITCHES.with(|m| m.borrow_mut().insert(id, s));
    Ok(())
}

#[ic_cdk::query]
fn my_switches() -> Vec<SwitchView> {
    let p = msg_caller();
    let now = time();
    let acc = account(&p).unwrap_or_default();
    OWNER_SWITCHES.with(|o| {
        o.borrow()
            .keys_range((p, 0)..=(p, u64::MAX))
            .filter_map(|(_, id)| SWITCHES.with(|s| s.borrow().get(&id)))
            .map(|s| switch_view(&s, &acc, now))
            .collect()
    })
}

/// "I'm still here": pushes back every armed switch of this account.
/// Free, and works even if the plan has lapsed (it cannot push past the
/// payment grace deadline, though).
#[ic_cdk::update]
fn check_in() -> R<u32> {
    let p = caller()?;
    let now = time();
    let acc = account(&p).unwrap_or_default();
    let ids: Vec<u64> = OWNER_SWITCHES.with(|o| o.borrow().keys_range((p, 0)..=(p, u64::MAX)).map(|(_, id)| id).collect());
    let mut n = 0;
    for id in ids {
        if let Some(mut s) = SWITCHES.with(|m| m.borrow().get(&id)) {
            if now < deadline(&s, &acc) {
                s.last_check_in = now;
                SWITCHES.with(|m| m.borrow_mut().insert(id, s));
                n += 1;
            }
        }
    }
    Ok(n)
}

#[ic_cdk::update]
fn switch_set_interval(id: u64, interval_sec: u64) -> R<()> {
    let p = caller()?;
    let now = time();
    let acc = account(&p).unwrap_or_default();
    if !heritage_active(&acc, now) {
        return Err("Your heritage plan is not active.".into());
    }
    let mut s = owned_switch(p, id)?;
    if now >= deadline(&s, &acc) {
        return Err("This switch has already been released.".into());
    }
    let interval = interval_sec.saturating_mul(SEC);
    if !(min_interval()..=MAX_INTERVAL).contains(&interval) {
        return Err("Choose an interval between 7 and 730 days.".into());
    }
    s.interval_ns = interval;
    s.last_check_in = now;
    SWITCHES.with(|m| m.borrow_mut().insert(id, s));
    Ok(())
}

fn destroy_switch(id: u64) {
    if let Some(s) = SWITCHES.with(|m| m.borrow_mut().remove(&id)) {
        OWNER_SWITCHES.with(|m| m.borrow_mut().remove(&(s.owner, id)));
    }
    let keys: Vec<_> = SWITCH_CHUNKS.with(|c| c.borrow().keys_range((id, 0)..=(id, u32::MAX)).collect());
    SWITCH_CHUNKS.with(|c| {
        let mut c = c.borrow_mut();
        for k in keys {
            c.remove(&k);
        }
    });
}

#[ic_cdk::update]
fn switch_delete(id: u64) -> R<()> {
    let p = caller()?;
    owned_switch(p, id)?;
    destroy_switch(id);
    Ok(())
}

// ---------------------------------------------------------------- heritage (heir side, no login)

fn released_switch(id: u64, proof: &[u8]) -> R<(Switch, usize, u64)> {
    let s = SWITCHES.with(|m| m.borrow().get(&id)).ok_or("This link is not valid.")?;
    let i = check_proof(&s, proof).ok_or("This link is not valid.")?;
    let owner = account(&s.owner).unwrap_or_default();
    Ok((s.clone(), i, deadline(&s, &owner)))
}

#[ic_cdk::query]
fn heir_lookup(id: u64, proof: Vec<u8>) -> R<HeirView> {
    let (s, i, d) = released_switch(id, &proof)?;
    let total: u32 = s.heirs.iter().map(|h| h.opens).sum();
    let left = (MAX_OPENS_PER_HEIR.saturating_sub(s.heirs[i].opens)).min(MAX_OPENS_PER_SWITCH.saturating_sub(total));
    Ok(HeirView { released: time() >= d && s.complete, deadline: d, size: s.size, chunks: s.chunks, opens_left: left })
}

#[ic_cdk::update]
async fn heir_open(id: u64, proof: Vec<u8>, transport_public_key: Vec<u8>) -> R<Opened> {
    let (mut s, i, d) = released_switch(id, &proof)?;
    if time() < d || !s.complete {
        return Err("This switch has not been released.".into());
    }
    let total: u32 = s.heirs.iter().map(|h| h.opens).sum();
    if s.heirs[i].opens >= MAX_OPENS_PER_HEIR || total >= MAX_OPENS_PER_SWITCH {
        return Err("This link has been opened the maximum number of times.".into());
    }
    if transport_public_key.len() != 48 {
        return Err("Invalid transport key.".into());
    }
    // Count the open before the (paid) derivation, so parallel calls cannot exceed the cap.
    s.heirs[i].opens += 1;
    let ibe_id = s.ibe_id.clone();
    let wrapped_key = s.heirs[i].wrapped_key.clone();
    SWITCHES.with(|m| m.borrow_mut().insert(id, s));
    let cfg = config();
    let r = vetkd_derive_key(&VetKDDeriveKeyArgs {
        input: ibe_id.clone(),
        context: HERITAGE_CONTEXT.to_vec(),
        transport_public_key,
        key_id: key_id(&cfg),
    })
    .await
    .map_err(|e| format!("Key release failed, please retry: {e:?}"))?;
    Ok(Opened { ibe_id, wrapped_key, encrypted_key: r.encrypted_key })
}

#[ic_cdk::query]
fn heir_chunk(id: u64, proof: Vec<u8>, index: u32) -> R<Vec<u8>> {
    let (s, _, d) = released_switch(id, &proof)?;
    if time() < d || !s.complete {
        return Err("This switch has not been released.".into());
    }
    SWITCH_CHUNKS.with(|c| c.borrow().get(&(id, index))).ok_or_else(|| "Chunk not found.".into())
}

// ---------------------------------------------------------------- maintenance (self-destruction)

const BUDGET: u64 = 3_000_000_000;

fn maintenance() {
    maintenance_at(time(), || instruction_counter() > BUDGET);
}

/// Self-destruction and cleanup. `over()` says when to stop (instruction budget).
fn maintenance_at(now: u64, over: impl Fn() -> bool) {

    // 1. Unpaid vaults past their grace period: destroy every file.
    let expired: Vec<Principal> = ACCOUNTS.with(|a| {
        a.borrow()
            .iter()
            .filter(|e| {
                let v = e.value();
                v.vault_tier > 0 && now > v.vault_until.saturating_add(VAULT_GRACE)
            })
            .map(|e| *e.key())
            .take(20)
            .collect()
    });
    for p in expired {
        let ids: Vec<u64> = FILES.with(|f| f.borrow().keys_range((p, 0)..=(p, u64::MAX)).map(|k| k.1).collect());
        let mut done = true;
        for id in ids {
            if over() {
                done = false;
                break;
            }
            delete_file(p, id);
        }
        if done {
            if let Some(mut a) = account(&p) {
                a.vault_tier = 0;
                a.vault_until = 0;
                a.used = 0;
                put_account(p, a);
            }
        }
        if over() {
            return;
        }
    }

    // 2. Uploads started but never finished.
    let stale: Vec<(Principal, u64)> = FILES.with(|f| {
        f.borrow().iter().filter(|e| !e.value().complete && now > e.value().created + INCOMPLETE_TTL).map(|e| *e.key()).take(50).collect()
    });
    for (p, id) in stale {
        if over() {
            return;
        }
        let freed = delete_file(p, id);
        if let Some(mut a) = account(&p) {
            a.used = a.used.saturating_sub(freed);
            put_account(p, a);
        }
    }

    // 3. Switches: released long ago, or never finished uploading.
    let gone: Vec<u64> = SWITCHES.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| {
                let s = e.value();
                let owner = account(&s.owner).unwrap_or_default();
                now > deadline(&s, &owner).saturating_add(RELEASED_KEEP) || (!s.complete && now > s.created + INCOMPLETE_TTL)
            })
            .map(|e| *e.key())
            .take(20)
            .collect()
    });
    for id in gone {
        if over() {
            return;
        }
        destroy_switch(id);
    }

    // 4. Orders never paid.
    let old: Vec<(u64, Principal)> = ORDERS.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| e.value().status == OrderStatus::Pending && e.value().received == 0 && now > e.value().created + UNPAID_ORDER_TTL)
            .map(|e| (*e.key(), e.value().owner))
            .take(200)
            .collect()
    });
    for (id, owner) in old {
        ORDERS.with(|m| m.borrow_mut().remove(&id));
        OWNER_ORDERS.with(|m| m.borrow_mut().remove(&(owner, id)));
    }
}

async fn refresh_price() -> (Option<u64>, Vec<u64>) {
    let (agreed, readings) = price::fetch(time() / SEC).await;
    let now = time();
    update_config(|c| {
        c.xmr_usd_readings = Some(readings.clone());
        if let Some(r) = agreed {
            c.xmr_usd_cents = Some(r);
            c.xmr_usd_at = Some(now);
        }
    });
    (agreed, readings)
}

fn start_timers() {
    ic_cdk_timers::set_timer_interval(Duration::from_secs(600), || async { maintenance() });
    ic_cdk_timers::set_timer_interval(Duration::from_secs(1800), || async {
        refresh_price().await;
    });
    ic_cdk_timers::set_timer(Duration::from_secs(5), async {
        refresh_price().await;
    });
}

#[ic_cdk::init]
fn init() {
    start_timers();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    start_timers();
}

// ---------------------------------------------------------------- transforms

#[ic_cdk::query(hidden = true)]
fn transform_tx(args: TransformArgs) -> HttpRequestResult {
    xmr::transform_tx(args)
}

#[ic_cdk::query(hidden = true)]
fn transform_header(args: TransformArgs) -> HttpRequestResult {
    xmr::transform_header(args)
}

#[ic_cdk::query(hidden = true)]
fn transform_kraken(args: TransformArgs) -> HttpRequestResult {
    price::transform_kraken(args)
}

#[ic_cdk::query(hidden = true)]
fn transform_kucoin(args: TransformArgs) -> HttpRequestResult {
    price::transform_kucoin(args)
}

#[ic_cdk::query(hidden = true)]
fn transform_coingecko(args: TransformArgs) -> HttpRequestResult {
    price::transform_coingecko(args)
}

// ---------------------------------------------------------------- admin (controllers)

/// Sets the service wallet. Returns its main address so the operator can
/// check it matches the wallet they control.
#[ic_cdk::update]
fn admin_set_wallet(view_key_hex: String, spend_public_key_hex: String, network: String) -> R<String> {
    admin()?;
    let view = hex::decode(view_key_hex.trim()).map_err(|_| "view key: not hex")?;
    let spend = hex::decode(spend_public_key_hex.trim()).map_err(|_| "spend key: not hex")?;
    if !["mainnet", "stagenet", "testnet"].contains(&network.as_str()) {
        return Err("network: mainnet, stagenet or testnet".into());
    }
    let mut test = config();
    test.view_key = Some(view.clone());
    test.spend_pub = Some(spend.clone());
    test.network = network.clone();
    let addr = xmr::primary_address(&test)?;
    update_config(|c| {
        c.view_key = Some(view);
        c.spend_pub = Some(spend);
        c.network = network;
    });
    Ok(addr)
}

#[ic_cdk::update]
fn admin_set_nodes(nodes: Vec<String>) -> R<()> {
    admin()?;
    if nodes.iter().any(|n| !n.starts_with("https://")) {
        return Err("Nodes must be https:// URLs.".into());
    }
    update_config(|c| c.nodes = nodes);
    Ok(())
}

/// Yearly prices in US cents (vault tiers 1..3, heritage). Paid plans are not affected.
#[ic_cdk::update]
fn admin_set_usd_prices(vault: Vec<u64>, heritage: u64) -> R<()> {
    admin()?;
    if vault.len() != 3 || vault.iter().any(|v| *v == 0) || heritage == 0 {
        return Err("Three non-zero vault prices and a heritage price, in US cents.".into());
    }
    update_config(|c| {
        c.usd_vault_prices = Some(vault);
        c.usd_heritage_price = Some(heritage);
    });
    Ok(())
}

/// Reads the price sources now. Returns the agreed rate (if any) and the raw readings.
#[ic_cdk::update]
async fn admin_refresh_price() -> R<(Option<u64>, Vec<u64>)> {
    admin()?;
    Ok(refresh_price().await)
}

/// Emergency fallback when the feeds are down: sets the rate by hand (US cents per XMR).
#[ic_cdk::update]
fn admin_set_xmr_rate(cents: u64) -> R<()> {
    admin()?;
    if !(100..=10_000_000).contains(&cents) {
        return Err("Rate in US cents per XMR, between $1 and $100,000.".into());
    }
    let now = time();
    update_config(|c| {
        c.xmr_usd_cents = Some(cents);
        c.xmr_usd_at = Some(now);
    });
    Ok(())
}

#[ic_cdk::update]
fn admin_set_params(min_confirmations: u32, key_name: String, paused: bool) -> R<()> {
    admin()?;
    if !(1..=60).contains(&min_confirmations) {
        return Err("min_confirmations: 1 to 60".into());
    }
    update_config(|c| {
        if c.key_name != key_name {
            c.heritage_public_key = None;
        }
        c.min_confirmations = min_confirmations;
        c.key_name = key_name;
        c.paused = paused;
    });
    Ok(())
}

/// Gives a plan without payment (support cases, tests). It can only add time
/// to an account; it cannot read or move anything.
#[ic_cdk::update]
fn admin_grant(account: Principal, product: Product, years: u8) -> R<()> {
    admin()?;
    product_usd(&config(), &product)?;
    if !(1..=3).contains(&years) {
        return Err("1 to 3 years.".into());
    }
    apply(account, &product, years, time());
    Ok(())
}

/// Lowers the minimum switch interval (tests only; never below 60 s). `None` restores 7 days.
#[ic_cdk::update]
fn admin_set_min_interval(sec: Option<u64>) -> R<()> {
    admin()?;
    if matches!(sec, Some(s) if s < 60) {
        return Err("At least 60 s.".into());
    }
    update_config(|c| c.min_interval_sec = sec);
    Ok(())
}

#[ic_cdk::query]
fn admin_stats() -> R<Stats> {
    admin()?;
    let (orders, paid, received) = ORDERS.with(|m| {
        let m = m.borrow();
        let mut paid = 0;
        let mut rec = 0u64;
        for e in m.iter() {
            let v = e.value();
            if v.status == OrderStatus::Paid {
                paid += 1;
            }
            rec = rec.saturating_add(v.received);
        }
        (m.len(), paid, rec)
    });
    Ok(Stats {
        accounts: ACCOUNTS.with(|a| a.borrow().len()),
        orders,
        paid_orders: paid,
        received_pico: received,
        files: FILES.with(|f| f.borrow().len()),
        vault_bytes: ACCOUNTS.with(|a| a.borrow().iter().map(|e| e.value().used).sum()),
        switches: SWITCHES.with(|s| s.borrow().len()),
        cycles: canister_cycle_balance(),
    })
}

// ---------------------------------------------------------------- inspect

/// Free refusal of obviously invalid ingress calls (saves cycles).
#[ic_cdk::inspect_message]
fn inspect() {
    let m = msg_method_name();
    let p = msg_caller();
    let ok = if m.starts_with("admin_") {
        is_controller(&p)
    } else if m == "heir_open" {
        true
    } else {
        p != Principal::anonymous()
    };
    if ok {
        accept_message();
    }
}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests;
