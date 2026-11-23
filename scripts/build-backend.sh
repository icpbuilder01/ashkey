#!/usr/bin/env sh
# Reproducible build of the Ashkey backend canister.
# Anyone can run this on a fresh clone and compare the printed SHA-256 with
# the module hash of the live canister (`icp canister status ashkey -e ic`).
# Local paths are remapped so the wasm is identical on every machine.
set -eu
cd "$(dirname "$0")/../backend"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export RUSTFLAGS="--remap-path-prefix=$CARGO_HOME/registry/src=/cargo/src --remap-path-prefix=$CARGO_HOME/git/checkouts=/cargo/git --remap-path-prefix=$RUSTUP_HOME=/rustup --remap-path-prefix=$(pwd)=/ashkey"
export SOURCE_DATE_EPOCH=0
cargo build --release --target wasm32-unknown-unknown --locked --quiet
OUT="${ICP_WASM_OUTPUT_PATH:-../ashkey.wasm}"
ic-wasm target/wasm32-unknown-unknown/release/ashkey.wasm -o "$OUT" metadata candid:service -f ashkey.did -v public
if strings "$OUT" | grep -q "$HOME"; then echo "local path leaked into the wasm" >&2; exit 1; fi
sha256sum "$OUT"
