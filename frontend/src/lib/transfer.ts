import { ok } from "./result";
import { chunkCount, decryptChunk, encryptChunk } from "./crypto";

const PARALLEL = 3;

async function pool(n: number, work: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, n) }, async () => {
      while (next < n) await work(next++);
    })
  );
}

/** Encrypts `data` chunk by chunk and uploads it with `put`. */
export async function uploadChunks(
  data: Blob,
  key: CryptoKey,
  nonce: Uint8Array,
  put: (i: number, bytes: Uint8Array) => Promise<{ __kind__: "Ok"; Ok: null } | { __kind__: "Err"; Err: string }>,
  progress: (done: number, total: number) => void
) {
  const total = chunkCount(data.size);
  let done = 0;
  await pool(total, async (i) => {
    const box = await encryptChunk(key, nonce, data, i);
    let tries = 0;
    for (;;) {
      try {
        ok(await put(i, box));
        break;
      } catch (e) {
        if (++tries >= 3) throw e;
      }
    }
    progress(++done, total);
  });
}

/** Downloads and decrypts `chunks` chunks fetched with `get`. */
export async function downloadChunks(
  chunks: number,
  key: CryptoKey,
  nonce: Uint8Array,
  get: (i: number) => Promise<{ __kind__: "Ok"; Ok: Uint8Array } | { __kind__: "Err"; Err: string }>,
  progress: (done: number, total: number) => void
): Promise<Uint8Array<ArrayBuffer>[]> {
  const parts: Uint8Array<ArrayBuffer>[] = new Array(chunks);
  let done = 0;
  await pool(chunks, async (i) => {
    parts[i] = await decryptChunk(key, nonce, ok(await get(i)), i);
    progress(++done, chunks);
  });
  return parts;
}

export function saveAs(parts: BlobPart[], name: string, type: string) {
  const url = URL.createObjectURL(new Blob(parts, { type: type || "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

