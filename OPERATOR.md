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

At least three HTTPS nodes from at least two different domains are required. A payment is
only accepted when two nodes **run by different domains** return the same answer
(`chad.example.com` and `kowalski.example.com` count as one operator). Keep about ten nodes
from different operators so checks continue when some disappear. Public HTTPS nodes:
https://monero.fail (filter https), https://xmr.ditatompel.com/remote-nodes/.

## 3. Prices

```sh
icp canister call ashkey admin_set_usd_prices '(vec { 1_500 : nat64; 4_900; 16_900 }, 2_500 : nat64)' -e ic
```

US cents per year. Changing prices does not affect plans already paid.

## 4. Support and stats

```sh
icp canister call ashkey admin_stats '()' -e ic
icp canister call ashkey admin_grant '(principal "<account principal>", variant { Vault = 1 : nat8 }, 1 : nat8)' -e ic
```

## 5. Operator role (works after blackholing)

The controllers can name an **operator** principal. It keeps the service running without
being a controller, so it still works once every controller is removed:

```sh
icp canister call ashkey admin_set_operator '(opt principal "<operator principal>")' -e ic
```

| The operator can | Limits |
|---|---|
| replace the Monero nodes (`admin_set_nodes`) | 3+ nodes, 2+ domains |
| change the USD prices (`admin_set_usd_prices`) | at most 3x the launch prices |
| set the XMR rate by hand (`admin_set_xmr_rate`) | only while the price feeds are down |
| pause new orders (`admin_pause_orders`) | 48 h at most, once every 7 days |
| change the service wallet, give free plans, read stats | |
| hand the role to another principal or give it up (`admin_set_operator`) | |

The operator can **never** read vaults, release or delay switches, change the vetKD key,
the confirmation count or the switch rules (`admin_set_params`, `admin_set_min_interval`
stay controller-only), and it cannot change the code.

## 6. Cycles

Storage is the main cost: about 4T cycles per GB per year on a 13-node subnet (≈ 5 € /GB/yr).
A heir opening a switch costs one vetKD derivation (~26B cycles). Each payment check costs a
few billion cycles. Keep the canister well above its freezing threshold.
