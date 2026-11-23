// All Ashkey cryptography, in the browser. Nothing in here sends a key anywhere.
//
// VAULT FILES
//   fileKey  = 32 random bytes, one per file
//   chunk_i  = iv || AES-256-GCM(fileKey, plaintext[i MiB], aad = nonce:i)
//   meta     = iv || AES-256-GCM(vaultKey, {name, type, size, fileKey, nonce})
//   vaultKey comes from the account number (see account.ts). The canister
//   stores chunks and meta, and can read neither.
//
// HERITAGE SWITCHES (same idea as PIKO Legacy, audited scheme)
//   K        = 32 random bytes; content chunks encrypted with K as above
//   for each heir: s = 32 random bytes, only in the heir's link
//     wrapped = IBE(vetKD public key, switch identity, AES-GCM(sha256("ashkey-inner"||s), K||nonce))
//     claim   = sha256(sha256("ashkey-claim"||s))   (the canister stores only this)
//   The IBE layer opens only with the vetKey for the switch identity, which the
//   canister requests from the subnet only after release. The inner layer needs s.
import {
  DerivedPublicKey,
  EncryptedVetKey,
  IbeCiphertext,
  IbeIdentity,
  IbeSeed,
  MasterPublicKey,
  MasterPublicKeyId,
  TransportSecretKey,
} from "@dfinity/vetkeys";
import { Principal } from "@icp-sdk/core/principal";

export const CHUNK = 1024 * 1024; // plaintext bytes per chunk
const OVERHEAD = 28; // iv (12) + GCM tag (16)

const enc = new TextEncoder();
const dec = new TextDecoder();

export function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

async function aes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, ...(aad ? { additionalData: aad as Uint8Array<ArrayBuffer> } : {}) },
    key,
    data as Uint8Array<ArrayBuffer>
  );
  return concat(iv, new Uint8Array(ct));
}

async function unseal(key: CryptoKey, box: Uint8Array, aad?: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: box.slice(0, 12), ...(aad ? { additionalData: aad as Uint8Array<ArrayBuffer> } : {}) },
    key,
    box.slice(12) as Uint8Array<ArrayBuffer>
  );
  return new Uint8Array(pt);
}

export function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------ chunked content

export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / CHUNK));
}

export function cipherSize(plainSize: number): number {
  return plainSize + chunkCount(plainSize) * OVERHEAD;
}

const aadFor = (nonce: Uint8Array, i: number) => concat(nonce, enc.encode(`:${i}`));

/** Encrypts chunk `i` of `data` (a Blob) with `key`. */
export async function encryptChunk(key: CryptoKey, nonce: Uint8Array, data: Blob, i: number): Promise<Uint8Array<ArrayBuffer>> {
  const part = new Uint8Array(await data.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
  return seal(key, part, aadFor(nonce, i));
}

export function decryptChunk(key: CryptoKey, nonce: Uint8Array, box: Uint8Array, i: number): Promise<Uint8Array<ArrayBuffer>> {
  return unseal(key, box, aadFor(nonce, i));
}

// ------------------------------------------------------------ vault files

export interface FileInfo {
  name: string;
  type: string;
  size: number;
  key: CryptoKey;
  nonce: Uint8Array;
}

export async function newFileSecrets(vaultKey: CryptoKey, file: File): Promise<{ meta: Uint8Array<ArrayBuffer>; info: FileInfo }> {
  const raw = random(32);
  const nonce = random(16);
  const body = { v: 1, name: file.name, type: file.type, size: file.size, k: toB64Url(raw), n: toB64Url(nonce) };
  const meta = await seal(vaultKey, enc.encode(JSON.stringify(body)));
  return { meta, info: { name: file.name, type: file.type, size: file.size, key: await aes(raw), nonce } };
}

export async function readFileMeta(vaultKey: CryptoKey, meta: Uint8Array): Promise<FileInfo> {
  const b = JSON.parse(dec.decode(await unseal(vaultKey, meta))) as { name: string; type: string; size: number; k: string; n: string };
  return { name: b.name, type: b.type, size: b.size, key: await aes(fromB64Url(b.k)), nonce: fromB64Url(b.n) };
}

export async function renameMeta(vaultKey: CryptoKey, meta: Uint8Array, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const b = JSON.parse(dec.decode(await unseal(vaultKey, meta)));
  b.name = name;
  return seal(vaultKey, enc.encode(JSON.stringify(b)));
}

// ------------------------------------------------------------ owner notes (encrypted with the account key)

export async function sealJson(vaultKey: CryptoKey, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  return seal(vaultKey, enc.encode(JSON.stringify(value)));
}

export async function openJson<T>(vaultKey: CryptoKey, box: Uint8Array): Promise<T> {
  return JSON.parse(dec.decode(await unseal(vaultKey, box))) as T;
}

// ------------------------------------------------------------ heritage package

export interface Attachment {
  name: string;
  type: string;
  data: Uint8Array;
}

/** message + files → one byte string: u32 header length || header JSON || file bytes. */
export async function packHeritage(message: string, files: File[]): Promise<Blob> {
  const header = enc.encode(JSON.stringify({ v: 1, message, files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return new Blob([len, header, ...files]);
}

export function unpackHeritage(bytes: Uint8Array): { message: string; files: Attachment[] } {
  const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const h = JSON.parse(dec.decode(bytes.slice(4, 4 + n))) as { message: string; files: { name: string; type: string; size: number }[] };
  let o = 4 + n;
  const files = h.files.map((f) => {
    const data = bytes.slice(o, o + f.size);
    o += f.size;
    return { name: f.name, type: f.type, data };
  });
  return { message: h.message, files };
}

const innerKey = async (s: Uint8Array) => aes(await sha256(concat(enc.encode("ashkey-inner"), s)));

/** Sent by a heir to prove they hold a link. The canister stores sha256(proof). */
export const heirProof = (s: Uint8Array) => sha256(concat(enc.encode("ashkey-claim"), s));

export interface SealedHeir {
  label: string;
  secret: Uint8Array<ArrayBuffer>;
  claimHash: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
}

export async function newSwitchSecrets(publicKey: Uint8Array, labels: string[]) {
  const dpk = DerivedPublicKey.deserialize(publicKey);
  const ibeId = random(32);
  const identity = IbeIdentity.fromBytes(ibeId);
  const raw = random(32);
  const nonce = random(16);
  const heirs: SealedHeir[] = [];
  for (const label of labels) {
    const secret = random(32);
    const inner = await seal(await innerKey(secret), concat(raw, nonce));
    const wrappedKey = IbeCiphertext.encrypt(dpk, identity, inner, IbeSeed.random()).serialize() as Uint8Array<ArrayBuffer>;
    heirs.push({ label, secret, claimHash: await sha256(await heirProof(secret)), wrappedKey });
  }
  return { ibeId, key: await aes(raw), nonce, heirs };
}

export function newTransportKey(): TransportSecretKey {
  return TransportSecretKey.random();
}

/** Recovers the content key of a released switch, from what heir_open returned. */
export async function openSwitchKey(
  publicKey: Uint8Array,
  tsk: TransportSecretKey,
  opened: { ibe_id: Uint8Array; wrapped_key: Uint8Array; encrypted_key: Uint8Array },
  secret: Uint8Array
): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const dpk = DerivedPublicKey.deserialize(publicKey);
  // decryptAndVerify checks this really is the subnet's key for this switch.
  const vetKey = EncryptedVetKey.deserialize(opened.encrypted_key).decryptAndVerify(tsk, dpk, opened.ibe_id);
  const inner = IbeCiphertext.deserialize(opened.wrapped_key).decrypt(vetKey);
  const kn = await unseal(await innerKey(secret), inner);
  return { key: await aes(kn.slice(0, 32)), nonce: kn.slice(32) };
}

/**
 * On mainnet the heritage public key is also derived offline from the IC's
 * published master key, so the browser never encrypts to a key the canister
 * merely claims is right.
 */
export function checkHeritageKey(keyName: string, context: Uint8Array, canisterId: string, key: Uint8Array) {
  const master = keyName === "key_1" ? MasterPublicKeyId.KEY_1 : keyName === "test_key_1" ? MasterPublicKeyId.TEST_KEY_1 : null;
  if (!master) return; // local test key: nothing published to compare with
  const expected = MasterPublicKey.productionKey(master)
    .deriveCanisterKey(Principal.fromText(canisterId).toUint8Array())
    .deriveSubKey(context)
    .publicKeyBytes();
  if (expected.length !== key.length || expected.some((b, i) => b !== key[i])) {
    throw new Error("The service returned an unexpected encryption key. Nothing was encrypted.");
  }
}
