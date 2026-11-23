//! XMR/USD rate, so prices can be set in dollars.
//!
//! Every 30 minutes the canister reads the last *closed* hourly candle from
//! three independent public sources (Kraken, KuCoin, CoinGecko) through HTTPS
//! outcalls. A closed candle does not change, so every replica sees the same
//! value. The rate is only updated when at least two sources agree within
//! `MAX_SPREAD`; the lowest agreeing value is kept (the customer pays a hair
//! more XMR rather than the service selling below cost). Orders are refused if
//! the rate is older than `MAX_AGE`.

use candid::Principal;
use ic_cdk::call::Call;
use ic_cdk_management_canister::{
    transform_context_from_query, HttpMethod, HttpRequestArgs, HttpRequestResult, TransformArgs,
};
use serde_json::{json, Value};

/// Sources may differ by at most 3 % to count as agreeing.
pub const MAX_SPREAD_BPS: u64 = 300;
/// Rate older than this: no new orders.
pub const MAX_AGE_NS: u64 = 6 * 3600 * 1_000_000_000;
/// A quoted XMR amount is valid this long; later payments are re-quoted.
pub const QUOTE_NS: u64 = 24 * 3600 * 1_000_000_000;
/// XMR amounts are rounded up to 0.0001 XMR.
pub const ROUND_PICO: u64 = 100_000_000;

const PICO: u128 = 1_000_000_000_000;

/// piconero needed for `usd_cents` at `cents_per_xmr`, rounded up to 0.0001 XMR.
pub fn quote(usd_cents: u64, cents_per_xmr: u64) -> u64 {
    let raw = (usd_cents as u128 * PICO).div_ceil(cents_per_xmr.max(1) as u128);
    let r = ROUND_PICO as u128;
    (raw.div_ceil(r) * r) as u64
}

/// Keeps the lowest value that at least one other source confirms within MAX_SPREAD.
pub fn combine(values: &[u64]) -> Option<u64> {
    let mut v: Vec<u64> = values.iter().copied().filter(|x| *x > 0).collect();
    v.sort_unstable();
    for (i, a) in v.iter().enumerate() {
        let agrees = v.iter().enumerate().any(|(j, b)| i != j && b.abs_diff(*a) * 10_000 <= MAX_SPREAD_BPS * (*a).min(*b));
        if agrees {
            return Some(*a);
        }
    }
    None
}

fn cents(s: &Value) -> Option<u64> {
    let f = match s {
        Value::String(t) => t.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if !(1.0..10_000_000.0).contains(&f) {
        return None;
    }
    Some((f * 100.0).round() as u64)
}

fn out(v: Option<u64>) -> HttpRequestResult {
    let body = match v {
        Some(c) => json!({ "cents": c }),
        None => json!({ "none": true }),
    };
    HttpRequestResult { status: 200u32.into(), headers: vec![], body: body.to_string().into_bytes() }
}

/// Kraken OHLC: the candle whose time equals `last` is the last closed one.
/// Row: [time, open, high, low, close, vwap, volume, count]
pub fn transform_kraken(args: TransformArgs) -> HttpRequestResult {
    let v: Value = serde_json::from_slice(&args.response.body).unwrap_or(Value::Null);
    let r = &v["result"];
    let last = r["last"].as_u64();
    let rows = r.as_object().and_then(|o| o.iter().find(|(k, _)| k.as_str() != "last").map(|(_, x)| x.clone()));
    let c = match (last, rows) {
        (Some(last), Some(Value::Array(rows))) => rows.iter().find(|row| row[0].as_u64() == Some(last)).and_then(|row| cents(&row[4])),
        _ => None,
    };
    out(c)
}

/// KuCoin candles, newest first; [0] is still open, [1] is the last closed.
/// Row: [time, open, close, high, low, volume, turnover]
pub fn transform_kucoin(args: TransformArgs) -> HttpRequestResult {
    let v: Value = serde_json::from_slice(&args.response.body).unwrap_or(Value::Null);
    out(v["data"].get(1).and_then(|row| cents(&row[2])))
}

/// CoinGecko OHLC (30-minute candles, oldest first); the last row may still
/// move, so the one before it is used. Row: [ms, open, high, low, close]
pub fn transform_coingecko(args: TransformArgs) -> HttpRequestResult {
    let v: Value = serde_json::from_slice(&args.response.body).unwrap_or(Value::Null);
    let c = v.as_array().and_then(|rows| rows.len().checked_sub(2).and_then(|i| rows.get(i))).and_then(|row| cents(&row[4]));
    out(c)
}

async fn get(url: String, max: u64, transform: &str) -> Option<u64> {
    let args = HttpRequestArgs {
        url,
        max_response_bytes: Some(max),
        method: HttpMethod::GET,
        headers: vec![],
        body: None,
        transform: Some(transform_context_from_query(transform.to_string(), vec![])),
        is_replicated: None,
        pricing_version: None,
    };
    let cycles = ic_cdk::api::cost_http_request(args.url.len() as u64 + 200, max);
    let res: HttpRequestResult = Call::unbounded_wait(Principal::management_canister(), "http_request")
        .with_arg(&args)
        .with_cycles(cycles)
        .await
        .ok()?
        .candid()
        .ok()?;
    serde_json::from_slice::<Value>(&res.body).ok()?["cents"].as_u64()
}

/// Reads the three sources; returns the agreed rate (USD cents per XMR) and the raw readings.
pub async fn fetch(now_sec: u64) -> (Option<u64>, Vec<u64>) {
    let since = now_sec.saturating_sub(4 * 3600);
    let kraken = get(format!("https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=60&since={since}"), 8_000, "transform_kraken");
    let kucoin = get(format!("https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=XMR-USDT&startAt={since}"), 8_000, "transform_kucoin");
    let gecko = get("https://api.coingecko.com/api/v3/coins/monero/ohlc?vs_currency=usd&days=1".to_string(), 12_000, "transform_coingecko");
    let (a, b, c) = (kraken.await, kucoin.await, gecko.await);
    let readings: Vec<u64> = [a, b, c].into_iter().flatten().collect();
    (combine(&readings), readings)
}
