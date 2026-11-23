# Operating Ashkey

## 1. Service wallet (view-only)

Create a dedicated Monero wallet for the service (Feather, Cake or `monero-wallet-cli`).
Only two values go to the canister:

- the **private view key** (Feather: Wallet → Keys),
- the **public spend key**.

Never give the private spend key or the seed. Then:

```sh
icp canister call ashkey admin_set_wallet '("<private view key hex>", "<public spend key hex>", "mainnet")' -e ic
```

It returns the wallet's main address: check it matches your wallet.

**Subaddress lookahead.** Each order uses subaddress `0/<order id>`. Wallets only scan a
window of subaddresses ahead of the last used one. Raise it so payments to high order ids show
up in your wallet, e.g. `monero-wallet-cli`: `set subaddress-lookahead 1:50000`; in Feather,
Settings → subaddress lookahead.

## 2. Nodes and parameters

```sh
icp canister call ashkey admin_set_nodes '(vec { "https://node1"; "https://node2"; "https://node3" })' -e ic
icp canister call ashkey admin_set_params '(10 : nat32, "key_1", false)' -e ic
icp canister call ashkey heritage_public_key '()' -e ic    # caches the vetKD key
```

At least two independent HTTPS nodes are required; three or more lets checks continue when
one is down. Public HTTPS nodes: https://xmr.ditatompel.com/remote-nodes/ (filter https).

## 3. Prices

```sh
icp canister call ashkey admin_set_prices '(vec { 30_000_000_000; 100_000_000_000; 350_000_000_000 }, 50_000_000_000)' -e ic
```

Piconero per year (1 XMR = 10^12). Changing prices does not affect plans already paid.

## 4. Support and stats

```sh
icp canister call ashkey admin_stats '()' -e ic
icp canister call ashkey admin_grant '(principal "<account principal>", variant { Vault = 1 : nat8 }, 1 : nat8)' -e ic
```

## 5. Cycles

Storage is the main cost: about 4T cycles per GB per year on a 13-node subnet (≈ 5 € /GB/yr).
A heir opening a switch costs one vetKD derivation (~26B cycles). Each payment check costs a
few billion cycles. Keep the canister well above its freezing threshold.
