# Security model

## Accounts

An account number is 128 random bits generated in the browser, shown as 28 Crockford
base-32 characters (26 data + 2 checksum). The browser derives, with HKDF-SHA-256:

- `ashkey-identity`: a 32-byte seed for an Ed25519 key pair. It signs every call; the
  canister only knows the resulting principal.
- `ashkey-vault-key`: an AES-256-GCM key that encrypts vault metadata and heritage owner notes.

The account number is never sent. The canister cannot derive it, and holds no key that can
decrypt a vault. Optionally the browser remembers the number (session or local storage).

## Vault

Each file gets a random 256-bit key and a 128-bit nonce. The file is split into 1 MiB chunks,
each sealed with AES-256-GCM, `aad = nonce || ":" || index` (chunks cannot be reordered or
swapped between files). The file key, nonce, name, type and size are sealed with the account
key and stored as the file's metadata. The canister sees ciphertext sizes and timestamps.

## Heritage switches

Same scheme as PIKO Legacy:

```
content  --AES-GCM(K, chunked)-->  ciphertext chunks
K||nonce --AES-GCM(sha256("ashkey-inner"||s_i))--> --IBE(vetKD pk, switch identity)--> wrapped_i
claim_i  = sha256(sha256("ashkey-claim"||s_i))
```

`s_i` exists only in heir i's link (URL fragment). The IBE layer opens only with the vetKey
for the switch's random identity, which the canister requests from the subnet only after the
deadline. So the link alone is useless before release, and the vetKey alone is useless
without a link. Before encrypting, the browser checks the vetKD public key against the IC's
published master key (`key_1`). Opens are capped (3 per link, 10 per switch).

Deadline = `min(last check-in + interval, plan end + 30 days)`: if the owner stops paying,
switches release to heirs rather than being destroyed. Released switches are deleted after
180 days. Owner notes (title, heir labels, link secrets) are encrypted with the account key,
so the owner can re-display links later.

## Payments

The service wallet's private **view** key and public **spend** key are configured in the
canister; the spend key never is. Each order gets its own subaddress (account 0, index =
order id). To credit a payment the canister, via HTTPS outcalls (all replicas fetch and must
agree after a deterministic transform):

1. fetches the transaction from two different configured nodes; both answers must be identical;
2. checks the blob hashes to the submitted txid (a node cannot substitute another transaction);
3. rejects time-locked transactions;
4. requires both nodes to know a block `min_confirmations - 1` above the transaction;
5. decrypts the amounts of outputs to the order's subaddress with the view key.

A txid can only be credited once. The view key lets node operators of the subnet see
incoming payments to the service wallet, not their source.

## Self-destruction

A timer runs every 10 minutes. Vault files of accounts more than 7 days past their paid
period are deleted, as are unfinished uploads older than a day, switches 180 days after
release and unpaid orders after 30 days. Deleted data was ciphertext whose key never existed
on the canister.

## What you still trust

- **The website code**: it runs in the browser and handles keys. While the frontend canister
  has a controller, its code can be changed. The trust page shows the live controllers.
- **The subnet** for heritage: a majority of its nodes would have to collude to release a
  vetKey early.
- **Availability**: canisters need cycles. Keep your own copies.
- **The configured Monero nodes**, mitigated by the two-node agreement and the txid hash check.

No external audit has been done yet.

## Abuse limits

Identities are free (anyone can generate account numbers), so every expensive
operation has a global cap, not only a per-identity one:

- **Payment checks** (HTTPS outcalls, a few billion cycles each): 20 s between
  checks per account, at most 30 per order, at most 400 per day for the whole
  service. A check for an unknown transaction stops after the first node.
- **Cycle reserve:** below 1T cycles the canister makes no outcalls at all
  (payment checks and price refresh pause). A draining attack can delay
  payments, never freeze the vaults.
- **Orders:** at most 20 per minute and 500 per day. Unpaid orders are deleted
  after 7 days and their subaddress index is reused, so spam cannot push the
  index beyond the operator wallet's lookahead.
- **Payment integrity:** the order (and its payment address) is read through an
  update call, so a single replica cannot substitute an address. Each one-time
  output key is credited once (Monero "burning bug").
- **Website:** a Content-Security-Policy restricts scripts to the site itself.

## Review log

- 2026-11-24, internal review: fixed a cycle-drain vector through payment
  checks, an uncertified payment address on the pay page, an unpaginated file
  list, unbounded subaddress growth from order spam, duplicate output keys; added a CSP.
