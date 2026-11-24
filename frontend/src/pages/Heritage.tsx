import { useState } from "react";
import type { SwitchView } from "../bindings/ashkey/ashkey";
import { Copy, Link, Notice, Progress, Spinner } from "../components/ui";
import { useAction, useLoad } from "../lib/hooks";
import { checkHeritageKey, chunkCount, cipherSize, newSwitchSecrets, openJson, packHeritage, sealJson, toB64Url } from "../lib/crypto";
import { backendId, ok } from "../lib/env";
import { bytes, date, dateTime, days, until } from "../lib/format";
import { heirLink } from "../lib/plans";
import { useSession } from "../lib/session";
import { uploadChunks } from "../lib/transfer";

interface OwnerNotes {
  v: 1;
  title: string;
  heirs: { label: string; s: string }[];
}

interface Row {
  s: SwitchView;
  notes: OwnerNotes | null;
}

const INTERVALS = [30, 90, 180, 365];

export default function Heritage() {
  const { account, me, api, info, toast, refresh } = useSession();
  const { data: rows, error, reload } = useLoad(async () => {
    if (!account) return [];
    const list = await api.my_switches();
    const out: Row[] = [];
    for (const s of list) out.push({ s, notes: await openJson<OwnerNotes>(account.vaultKey, s.meta).catch(() => null) });
    return out;
  }, [api, account]);
  const [creating, setCreating] = useState(false);
  const { busy, run } = useAction((m) => toast(m, "err"));

  if (!account || !me)
    return (
      <div className="wrap narrow">
        <Notice kind="info">
          <Link to="/login">Sign in</Link> to manage your heritage switches.
        </Notice>
      </div>
    );

  const checkIn = () =>
    run(async () => {
      const n = ok(await api.check_in());
      toast(n ? `Checked in. ${n} switch${n > 1 ? "es" : ""} pushed back.` : "Nothing armed to check in.", "ok");
      reload();
    });

  const armed = (rows ?? []).filter((r) => !r.s.released);

  return (
    <div className="wrap" style={{ maxWidth: 960 }}>
      <div className="row between">
        <h1 style={{ fontSize: 40, margin: 0 }}>Heritage</h1>
        {armed.length > 0 && (
          <button type="button" className="btn primary" disabled={busy} onClick={checkIn}>
            I'm still here
          </button>
        )}
      </div>
      <p style={{ marginTop: 10 }}>
        Each switch opens for your heirs if you stop checking in. Signing in counts as a check-in.
        {me.heritage_active ? ` Plan paid until ${date(me.heritage_until)}.` : ""}
      </p>
      {!me.heritage_active && me.heritage_until > 0n && (
        <Notice kind="warn">
          Your heritage plan lapsed {date(me.heritage_until)}. Armed switches will release to your heirs{" "}
          {info ? Number(info.heritage_grace_sec) / 86400 : 30} days after that date unless you <Link to="/account">renew</Link> or
          delete them.
        </Notice>
      )}
      {me.heritage_until === 0n && (
        <Notice kind="info">
          No heritage plan on this account. <Link to="/start?p=h">Add one</Link>.
        </Notice>
      )}
      {error && <Notice kind="err">{error}</Notice>}

      {!rows ? (
        <Spinner />
      ) : (
        rows.map((r) => <SwitchCard key={r.s.id.toString()} row={r} onChange={() => (reload(), refresh())} />)
      )}

      {me.heritage_active && rows && rows.length < (info?.max_switches ?? 3) && !creating && (
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          + New switch
        </button>
      )}
      {creating && (
        <NewSwitch
          onDone={() => {
            setCreating(false);
            reload();
          }}
          usedBytes={(rows ?? []).reduce((n, r) => n + r.s.size, 0n)}
        />
      )}
    </div>
  );
}

function SwitchCard({ row, onChange }: { row: Row; onChange: () => void }) {
  const { api, toast } = useSession();
  const { busy, run } = useAction((m) => toast(m, "err"));
  const { s, notes } = row;
  const [interval, setIntervalDays] = useState(Number(s.interval_sec) / 86400);

  const del = () =>
    run(async () => {
      if (!confirm("Delete this switch and its content for good? Heirs will never be able to open it.")) return;
      ok(await api.switch_delete(s.id));
      onChange();
    });
  const setIv = () =>
    run(async () => {
      ok(await api.switch_set_interval(s.id, BigInt(interval * 86400)));
      toast("Interval updated, and checked in.", "ok");
      onChange();
    });

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between">
        <h3 style={{ margin: 0 }}>{notes?.title ?? "(title unreadable)"}</h3>
        {s.released ? <span className="pill err">released</span> : !s.complete ? <span className="pill warn">incomplete</span> : <span className="pill ok">armed</span>}
      </div>
      <p className="muted" style={{ margin: "6px 0 14px" }}>
        {bytes(s.size)} · created {date(s.created)} · last check-in {dateTime(s.last_check_in)} · every {days(s.interval_sec)}
      </p>
      {s.released ? (
        <Notice kind="err">Released {dateTime(s.deadline)}. Heirs can open it until {date(s.destroy_at)}, then it is destroyed.</Notice>
      ) : (
        <Notice kind="info">
          Opens for your heirs {dateTime(s.deadline)} ({until(s.deadline)}) if you don't check in before.
        </Notice>
      )}
      {!s.complete && <Notice kind="warn">The upload did not finish. Delete this switch and create it again.</Notice>}

      {notes && (
        <>
          <h3 style={{ fontSize: 16, marginTop: 16 }}>Heir links</h3>
          <p className="muted">Give each heir their link privately (paper, password manager, a sealed letter). A link opens at most 3 times.</p>
          {notes.heirs.map((h, i) => (
            <div key={i} className="row" style={{ marginBottom: 10 }}>
              <span style={{ minWidth: 120 }}>
                <b>{h.label || `Heir ${i + 1}`}</b> <span className="muted">({s.heir_opens[i] ?? 0} opens)</span>
              </span>
              <span className="addr" style={{ flex: 1, padding: "6px 10px", fontSize: 12.5 }}>
                {heirLink(s.id, h.s)}
              </span>
              <Copy text={heirLink(s.id, h.s)} />
            </div>
          ))}
        </>
      )}
      {!s.released && (
        <div className="row" style={{ marginTop: 14 }}>
          <select value={interval} onChange={(e) => setIntervalDays(Number(e.target.value))} style={{ width: "auto" }}>
            {INTERVALS.map((d) => (
              <option key={d} value={d}>
                every {days(d * 86400)}
              </option>
            ))}
          </select>
          <button type="button" className="btn small" disabled={busy || interval * 86400 === Number(s.interval_sec)} onClick={setIv}>
            Change interval
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn small ghost danger" disabled={busy} onClick={del}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function NewSwitch({ onDone, usedBytes }: { onDone: () => void; usedBytes: bigint }) {
  const { account, api, info, toast } = useSession();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [heirs, setHeirs] = useState<string[]>([""]);
  const [interval, setIntervalDays] = useState(90);
  const [job, setJob] = useState<number | null>(null);
  const { busy, run } = useAction((m) => toast(m, "err"));

  const limit = info?.heritage_max_bytes ?? 10_500_000n;
  const plainSize = 4 + 200 + new TextEncoder().encode(message).length + files.reduce((n, f) => n + f.size, 0);
  const tooBig = BigInt(cipherSize(plainSize)) + usedBytes > limit;

  const create = () =>
    run(async () => {
      if (!account || !info) return;
      if (!title.trim() || !message.trim()) throw new Error("Give it a title and write something.");
      if (heirs.some((h) => !h.trim())) throw new Error("Name every heir (a first name or a nickname is enough).");
      const pk = info.heritage_public_key ?? ok(await api.heritage_public_key());
      checkHeritageKey(info.key_name, info.heritage_context, backendId, pk);
      const sec = await newSwitchSecrets(pk, heirs);
      const pack = await packHeritage(message, files);
      const notes: OwnerNotes = { v: 1, title: title.trim(), heirs: sec.heirs.map((h) => ({ label: h.label.trim(), s: toB64Url(h.secret) })) };
      const id = ok(
        await api.switch_create({
          meta: await sealJson(account.vaultKey, notes),
          ibe_id: sec.ibeId,
          size: BigInt(cipherSize(pack.size)),
          chunks: chunkCount(pack.size),
          interval_sec: BigInt(interval * 86400),
          heirs: sec.heirs.map((h) => ({ claim_hash: h.claimHash, wrapped_key: h.wrappedKey })),
        })
      );
      setJob(0);
      await uploadChunks(pack, sec.key, sec.nonce, (i, b) => api.switch_put(id, i, b), (d, t) => setJob(d / t));
      ok(await api.switch_commit(id));
      toast("Switch armed. Copy the heir links below.", "ok");
      onDone();
    }).finally(() => setJob(null));

  return (
    <div className="card">
      <h3>New switch</h3>
      <label className="field">
        Title (only you see it)
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For my family" maxLength={120} />
      </label>
      <label className="field">
        Message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What they should know, where things are, who to call…" />
      </label>
      <p className="muted" style={{ marginTop: -4 }}>
        Tip: add your account number to the message and your heirs can also sign in to your vault and download your files. Keep
        the vault prepaid for longer than your check-in interval.
      </p>
      <label className="field">
        Attachments (optional)
        <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      </label>
      <p className={tooBig ? "" : "muted"} style={tooBig ? { color: "var(--err)" } : undefined}>
        {bytes(cipherSize(plainSize))} of {bytes(limit - usedBytes)} available.
      </p>
      <div className="field" style={{ display: "grid", gap: 8 }}>
        <span style={{ fontSize: 14, color: "var(--ink2)" }}>Heirs (a label for you; heirs never see each other)</span>
        {heirs.map((h, i) => (
          <div key={i} className="row">
            <input type="text" value={h} placeholder={`Heir ${i + 1}`} style={{ flex: 1 }} maxLength={60} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? e.target.value : x)))} />
            {heirs.length > 1 && (
              <button type="button" className="btn small ghost" onClick={() => setHeirs(heirs.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        {heirs.length < (info?.max_heirs ?? 5) && (
          <button type="button" className="btn small ghost" style={{ justifySelf: "start" }} onClick={() => setHeirs([...heirs, ""])}>
            + Add heir
          </button>
        )}
      </div>
      <label className="field">
        Opens if I don't check in for
        <select value={interval} onChange={(e) => setIntervalDays(Number(e.target.value))}>
          {INTERVALS.map((d) => (
            <option key={d} value={d}>
              {days(d * 86400)}
            </option>
          ))}
        </select>
      </label>
      {job !== null && <Progress value={job} label="Encrypting and uploading" />}
      <div className="row" style={{ marginTop: 16 }}>
        <button type="button" className="btn primary" disabled={busy || tooBig} onClick={create}>
          {busy ? "Sealing…" : "Seal and arm"}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
