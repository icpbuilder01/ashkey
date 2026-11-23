// Mullvad-style accounts.
//
// An account number is 16 random bytes (128 bits) generated in this browser,
// written as 26 Crockford base-32 characters plus 2 checksum characters:
//   ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23
// Everything is derived from it locally with HKDF-SHA-256:
//   - an Ed25519 key pair that signs calls (the canister only sees its principal),
//   - the AES-256-GCM key that encrypts vault file names and file keys.
// The account number is never sent anywhere. Lose it and nobody, including
// the operator, can give access back.
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U

function toBase32(bytes: Uint8Array, chars: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function fromBase32(text: string): bigint {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("bad character");
    n = (n << 5n) | BigInt(v);
  }
  return n;
}

async function checksum(raw: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>));
  return ALPHABET[h[0] & 31] + ALPHABET[h[1] & 31];
}

function group(s: string): string {
  return s.match(/.{1,4}/g)!.join("-");
}

/** A brand-new random account number. */
export async function newAccountNumber(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return group(toBase32(raw, 26) + (await checksum(raw)));
}

/** Normalises what the user typed; throws a readable error if it is not a valid number. */
export async function parseAccountNumber(input: string): Promise<{ raw: Uint8Array<ArrayBuffer>; text: string }> {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 28) throw new Error("An account number has 28 characters.");
  let n: bigint;
  try {
    n = fromBase32(s.slice(0, 26));
  } catch {
    throw new Error("That is not an account number (unexpected character).");
  }
  if (n >> 128n) throw new Error("That is not an account number.");
  const raw = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    raw[i] = Number(n & 255n);
    n >>= 8n;
  }
  if ((await checksum(raw)) !== s.slice(26)) throw new Error("Typo? The account number checksum does not match.");
  return { raw, text: group(s) };
}

async function hkdf(raw: Uint8Array, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ashkey-account-v1"), info: new TextEncoder().encode(info) },
    base,
    bytes * 8
  );
  return new Uint8Array(bits);
}

export interface AccountKeys {
  text: string;
  identity: Ed25519KeyIdentity;
  /** Encrypts vault metadata (file names, per-file keys) and heritage owner notes. */
  vaultKey: CryptoKey;
}

export async function deriveAccount(raw: Uint8Array, text: string): Promise<AccountKeys> {
  const identity = Ed25519KeyIdentity.generate(await hkdf(raw, "ashkey-identity", 32));
  const vaultKey = await crypto.subtle.importKey("raw", await hkdf(raw, "ashkey-vault-key", 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { text, identity, vaultKey };
}

// --- remembering the account number on this device (optional) ---

const KEY = "ashkey.account";

export function rememberedNumber(): string | null {
  return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
}

export function remember(text: string, persistent: boolean) {
  sessionStorage.setItem(KEY, text);
  if (persistent) localStorage.setItem(KEY, text);
  else localStorage.removeItem(KEY);
}

export function forget() {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
}
