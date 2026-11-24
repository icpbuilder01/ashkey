// End-to-end test against the LOCAL network only (icp network start -d && icp deploy -y).
// Same crypto code the browser runs, real vetKD (dfx_test_key), real canister.
// Takes a little over a minute: it waits for a heritage switch to be released.
//
//   cd frontend && npx tsx test/e2e.ts
import { execSync } from "node:child_process";
import { HttpAgent } from "@icp-sdk/core/agent";
import { createActor } from "../src/bindings/ashkey/ashkey";
import { deriveAccount, newAccountNumber, parseAccountNumber } from "../src/lib/account";
import {
  checkHeritageKey,
  chunkCount,
  cipherSize,
  fromB64Url,
  heirProof,
  newFileSecrets,
  newSwitchSecrets,
  newTransportKey,
  openJson,
  openSwitchKey,
  packHeritage,
  openThumb,
  readFileMeta,
  sealJson,
  sealThumb,
  toB64Url,
  unpackHeritage,
} from "../src/lib/crypto";
import { ok } from "../src/lib/result";
import { downloadChunks, uploadChunks } from "../src/lib/transfer";

const HOST = "http://localhost:8180";
const sh = (cmd: string) => execSync(cmd, { cwd: `${import.meta.dirname}/../..`, encoding: "utf-8" }).trim();
const ID = sh("icp canister status ashkey -i");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}
const isErr = (r: { __kind__: string }, text?: string) =>
  r.__kind__ === "Err" && (!text || (r as unknown as { Err: string }).Err.toLowerCase().includes(text.toLowerCase()));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function login(number?: string) {
  const n = number ?? (await newAccountNumber());
  const { raw, text } = await parseAccountNumber(n);
  const keys = await deriveAccount(raw, text);
  const agent = await HttpAgent.create({ host: HOST, identity: keys.identity, shouldFetchRootKey: true });
  return { number: text, keys, principal: keys.identity.getPrincipal(), api: createActor(ID, { agent }) };
}

console.log("== account numbers");
const n1 = await newAccountNumber();
check("format: 7 groups, 28 characters", /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/.test(n1), n1);
check("typo detected by checksum", await parseAccountNumber(n1.slice(0, 5) + (n1[5] === "A" ? "B" : "A") + n1.slice(6)).then(() => false, () => true));
check("lowercase / no dashes accepted", (await parseAccountNumber(n1.toLowerCase().replace(/-/g, ""))).text === n1);
const alice = await login(n1);
const again = await login(n1.toLowerCase());
check("same number → same principal", alice.principal.toText() === again.principal.toText());
const bob = await login();
check("different numbers → different principals", bob.principal.toText() !== alice.principal.toText());

console.log("== plans");
const me0 = await alice.api.me();
check("new account has nothing", !me0.exists && !me0.vault_active);
const refused = await alice.api.file_begin(new Uint8Array([1]), 10n, 1);
check("upload refused without a plan", isErr(refused, "no vault plan"));
sh(`icp canister call ashkey admin_grant '(principal "${alice.principal.toText()}", variant { Vault = 1 : nat8 }, 1 : nat8)'`);
sh(`icp canister call ashkey admin_grant '(principal "${alice.principal.toText()}", variant { Heritage }, 1 : nat8)'`);
const me1 = await alice.api.me();
check("vault active, 1 GB quota", me1.vault_active && me1.quota === 1_000_000_000n);
check("heritage active", me1.heritage_active);
const orderTry = await bob.api.create_order({ __kind__: "Vault", Vault: 2 }, 1);
const rate = sh(`icp canister call ashkey admin_refresh_price '()'`);
check("price feed: sources agree on a rate", /opt \(?\d/.test(rate.replace(/_/g, "")), rate);
const info0 = await alice.api.get_info();
check("dollar prices quoted in XMR", info0.usd_vault_prices[0] === 1500n && info0.vault_prices[0] > 0n && info0.vault_prices[0] % 100_000_000n === 0n);
check("orders get a subaddress", orderTry.__kind__ === "Ok" && orderTry.Ok.address.length === 95 && /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(orderTry.Ok.reference), orderTry);
check("order keeps the dollar price and a 24 h quote", orderTry.__kind__ === "Ok" && orderTry.Ok.usd_cents === 4900n && orderTry.Ok.quote_until !== undefined && orderTry.Ok.amount === info0.vault_prices[1]);

console.log("== vault");
const bytes = new Uint8Array(2_500_000);
for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
const file = new File([bytes], "passport scan é.pdf", { type: "application/pdf" });
const { meta, info } = await newFileSecrets(alice.keys.vaultKey, file);
const fid = ok(await alice.api.file_begin(meta, BigInt(cipherSize(file.size)), chunkCount(file.size)));
await uploadChunks(file, info.key, info.nonce, (i, b) => alice.api.file_put(fid, i, b), () => {});
ok(await alice.api.file_commit(fid));
const list = await alice.api.file_list();
check("file listed, complete, 3 chunks", list.length === 1 && list[0].complete && list[0].chunks === 3, list);
const back = await readFileMeta(alice.keys.vaultKey, list[0].meta);
check("file name decrypts", back.name === "passport scan é.pdf" && back.type === "application/pdf");
const parts = await downloadChunks(list[0].chunks, back.key, back.nonce, (i) => alice.api.file_chunk(fid, i), () => {});
const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let o = 0;
for (const p of parts) (joined.set(p, o), (o += p.length));
check("2.5 MB round trip, byte for byte", same(joined, bytes));
const stored = ok(await alice.api.file_chunk(fid, 0));
check("stored chunk is not the plaintext", !same(stored.slice(12, 112), bytes.slice(0, 100)));
check("other account cannot read the chunk", isErr(await bob.api.file_chunk(fid, 0)));
check("other account does not see the file", (await bob.api.file_list()).length === 0);
const wrongKey = await readFileMeta(bob.keys.vaultKey, list[0].meta).then(() => false, () => true);
check("another account's key cannot decrypt the name", wrongKey);
const fakeThumb = crypto.getRandomValues(new Uint8Array(9000));
ok(await alice.api.file_set_thumb(fid, await sealThumb(back, fakeThumb)));
check("listing flags the preview", (await alice.api.file_list())[0].has_thumb);
check("preview decrypts with the file key", same(await openThumb(back, ok(await alice.api.file_thumb(fid))), fakeThumb));
check("other account cannot read the preview", isErr(await bob.api.file_thumb(fid)));
check("oversized preview refused", isErr(await alice.api.file_set_thumb(fid, new Uint8Array(60_000)), "invalid thumbnail"));
check("quota enforced", isErr(await alice.api.file_begin(meta, 2_000_000_000n, 2000), "not enough space"));
const used = (await alice.api.me()).used;
check("usage counted, preview included", used === BigInt(cipherSize(file.size) + 9000 + 28), used);
ok(await alice.api.file_delete(fid));
check("delete frees space", (await alice.api.me()).used === 0n && (await alice.api.file_list()).length === 0);

console.log("== heritage");
sh(`icp canister call ashkey admin_set_min_interval '(opt (60 : nat64))'`);
const pk = ok(await alice.api.heritage_public_key());
const cfg = await alice.api.get_info();
checkHeritageKey(cfg.key_name, cfg.heritage_context, ID, pk); // no-op locally, must not throw
check("vetKD public key", pk.length === 96);
const sec = await newSwitchSecrets(pk, ["Mum", "Sam"]);
const attachment = new File([new TextEncoder().encode("account list: …")], "instructions.txt", { type: "text/plain" });
const message = "If you read this, I'm gone. Look in the blue folder. — é€ ✓";
const pack = await packHeritage(message, [attachment]);
const notes = { v: 1, title: "For my family", heirs: sec.heirs.map((h) => ({ label: h.label, s: toB64Url(h.secret) })) };
const sid = ok(
  await alice.api.switch_create({
    meta: await sealJson(alice.keys.vaultKey, notes),
    ibe_id: sec.ibeId,
    size: BigInt(cipherSize(pack.size)),
    chunks: chunkCount(pack.size),
    interval_sec: 60n,
    heirs: sec.heirs.map((h) => ({ claim_hash: h.claimHash, wrapped_key: h.wrappedKey })),
  })
);
await uploadChunks(pack, sec.key, sec.nonce, (i, b) => alice.api.switch_put(sid, i, b), () => {});
ok(await alice.api.switch_commit(sid));
const mine = await alice.api.my_switches();
check("switch armed", mine.length === 1 && mine[0].complete && !mine[0].released);
const readBack = await openJson<typeof notes>(alice.keys.vaultKey, mine[0].meta);
check("owner can re-read heir links later", readBack.heirs[1].s === notes.heirs[1].s);
check("bob cannot create without a plan", isErr(await bob.api.switch_create({ meta: new Uint8Array(), ibe_id: sec.ibeId, size: 10n, chunks: 1, interval_sec: 60n, heirs: [] }), "no heritage plan"));

const heir = await HttpAgent.create({ host: HOST, shouldFetchRootKey: true }).then((agent) => createActor(ID, { agent }));
const s = fromB64Url(notes.heirs[0].s);
const proof = await heirProof(s);
const look = ok(await heir.heir_lookup(sid, proof));
check("heir sees: not released yet", !look.released && look.opens_left === 3);
check("heir cannot open early", isErr(await heir.heir_open(sid, proof, newTransportKey().publicKeyBytes()), "not been released"));
check("heir cannot fetch content early", isErr(await heir.heir_chunk(sid, proof, 0), "not been released"));
check("bad link rejected", isErr(await heir.heir_lookup(sid, await heirProof(new Uint8Array(32))), "not valid"));
check("check-in works", ok(await alice.api.check_in()) === 1);

console.log("   waiting 65 s for the switch to release…");
await new Promise((r) => setTimeout(r, 65_000));
const look2 = ok(await heir.heir_lookup(sid, proof));
check("released after silence", look2.released);
check("owner can no longer check in a released switch", ok(await alice.api.check_in()) === 0);
const tsk = newTransportKey();
const opened = ok(await heir.heir_open(sid, proof, tsk.publicKeyBytes()));
const { key, nonce } = await openSwitchKey(pk, tsk, opened, s);
const hp = await downloadChunks(look2.chunks, key, nonce, (i) => heir.heir_chunk(sid, proof, i), () => {});
const all = new Uint8Array(hp.reduce((n, p) => n + p.length, 0));
o = 0;
for (const p of hp) (all.set(p, o), (o += p.length));
const got = unpackHeritage(all);
check("heir reads the message", got.message === message, got.message);
check("heir gets the attachment", got.files.length === 1 && got.files[0].name === "instructions.txt" && new TextDecoder().decode(got.files[0].data) === "account list: …");
const wrongHeir = await openSwitchKey(pk, tsk, { ...opened }, fromB64Url(notes.heirs[1].s)).then(() => false, () => true);
check("another heir's secret cannot unwrap this heir's key", wrongHeir);
check("opens are counted", ok(await heir.heir_lookup(sid, proof)).opens_left === 2);

sh(`icp canister call ashkey admin_set_min_interval '(null)'`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
