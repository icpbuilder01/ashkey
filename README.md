# Ashkey

Encrypted storage and a dead man's switch on the Internet Computer, paid in Monero.
No email, no KYC: a random account number is your only login, like Mullvad.

- **Vault**: 1, 5 or 20 GB of storage. Files and file names are encrypted in the browser.
  Unpaid vaults self-destruct 7 days after expiry.
- **Heritage switch**: a message and attachments (up to 10 MB) for up to 5 heirs, released
  only if you stop checking in. Two independent locks: one in each heir's link, one held
  by the subnet through vetKeys until release.
- **Payments**: the canister verifies Monero payments itself with the service wallet's
  view key, against two independent HTTPS nodes. It cannot spend.

See [SECURITY.md](SECURITY.md) for the full trust model and [OPERATOR.md](OPERATOR.md) to run it.

## Layout

```
backend/    Rust canister (ic-cdk): accounts, orders, XMR verification, vault, heritage
frontend/   React + Vite website (static, served by an asset canister)
scripts/    build-backend.sh: reproducible backend build, prints the SHA-256
```

## Verify the live backend

```sh
./scripts/build-backend.sh                    # prints the SHA-256 of the wasm
icp canister status <backend-id> -e ic        # compare "Module hash"
```

Paths are remapped and the toolchain is pinned (`rust-toolchain.toml`), so the same source
gives the same bytes on any machine.

## Develop

```sh
icp network start -d
icp deploy -y                                 # local network on port 8180
cd backend && cargo test --release            # unit tests (also writes ashkey.did)
cd frontend && npx tsx test/e2e.ts            # end-to-end against the local network
```

The local network uses `dfx_test_key` for vetKD: `icp canister call ashkey admin_set_params '(10 : nat32, "dfx_test_key", false)'`.

## License

MIT
