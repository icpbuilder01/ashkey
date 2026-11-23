import { useEffect, useRef, useState } from "react";
import type { FileView } from "../bindings/ashkey/ashkey";
import { Link, Notice, Progress, Spinner } from "../components/ui";
import { useAction, useLoad } from "../lib/hooks";
import { cipherSize, chunkCount, newFileSecrets, readFileMeta, type FileInfo } from "../lib/crypto";
import { ok } from "../lib/env";
import { bytes, date, until } from "../lib/format";
import { useSession } from "../lib/session";
import { downloadChunks, saveAs, uploadChunks } from "../lib/transfer";

interface Row {
  f: FileView;
  info: FileInfo | null; // null if the name could not be decrypted
}

export default function Vault() {
  const { account, me, api, refresh, toast } = useSession();
  const { data: files, error, reload } = useLoad(async () => {
    if (!account) return [];
    const list = await api.file_list();
    const rows: Row[] = [];
    for (const f of list) rows.push({ f, info: await readFileMeta(account.vaultKey, f.meta).catch(() => null) });
    return rows.sort((a, b) => Number(b.f.created - a.f.created));
  }, [api, account]);
  const [job, setJob] = useState<{ label: string; value: number } | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction((m) => toast(m, "err"));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account || !me)
    return (
      <div className="wrap narrow">
        <Notice kind="info">
          <Link to="/login">Sign in</Link> to open your vault.
        </Notice>
      </div>
    );

  const upload = (list: FileList | File[]) =>
    run(async () => {
      for (const file of Array.from(list)) {
        const total = cipherSize(file.size);
        if (me.used + BigInt(total) > me.quota) throw new Error(`Not enough space for ${file.name}.`);
        const { meta, info } = await newFileSecrets(account.vaultKey, file);
        const id = ok(await api.file_begin(meta, BigInt(total), chunkCount(file.size)));
        setJob({ label: `Encrypting and uploading ${file.name}`, value: 0 });
        await uploadChunks(file, info.key, info.nonce, (i, b) => api.file_put(id, i, b), (d, t) =>
          setJob({ label: `Encrypting and uploading ${file.name} · ${d}/${t}`, value: d / t })
        );
        ok(await api.file_commit(id));
        await refresh();
        reload();
      }
      setJob(null);
      toast("Uploaded and encrypted.", "ok");
    }).finally(() => setJob(null));

  const download = (r: Row) =>
    run(async () => {
      if (!r.info) throw new Error("This file's name could not be decrypted.");
      const info = r.info;
      const parts = await downloadChunks(r.f.chunks, info.key, info.nonce, (i) => api.file_chunk(r.f.id, i), (d, t) =>
        setJob({ label: `Downloading and decrypting ${info.name} · ${d}/${t}`, value: d / t })
      );
      saveAs(parts, info.name, info.type);
    }).finally(() => setJob(null));

  const remove = (r: Row) =>
    run(async () => {
      if (!confirm(`Delete ${r.info?.name ?? "this file"} for good?`)) return;
      ok(await api.file_delete(r.f.id));
      await refresh();
      reload();
    });

  const pct = me.quota > 0n ? Number((me.used * 1000n) / me.quota) / 10 : 0;

  return (
    <div className="wrap" style={{ maxWidth: 960 }}>
      <div className="row between">
        <h1 style={{ fontSize: 40, margin: 0 }}>Vault</h1>
        <span className="muted">
          {bytes(me.used)} / {bytes(me.quota)}
        </span>
      </div>
      <div className="meter" style={{ margin: "14px 0 22px" }}>
        <div style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      {me.vault_tier === 0 && (
        <Notice kind="info">
          No vault plan on this account. <Link to="/account">Add one</Link>.
        </Notice>
      )}
      {me.vault_tier > 0 && !me.vault_active && (
        <Notice kind="err">
          Your plan expired {date(me.vault_until)}. Files are read-only and will be destroyed{" "}
          {me.vault_destroy_at !== undefined ? `${date(me.vault_destroy_at)} (${until(me.vault_destroy_at)})` : "soon"}.{" "}
          <Link to="/account">Renew now</Link> or download what you need.
        </Notice>
      )}

      {me.vault_active && (
        <div
          className={`drop${over ? " over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) upload(e.dataTransfer.files);
          }}
        >
          <b>Drop files here</b> or click to choose.
          <br />
          <span className="muted">Encrypted in this browser before upload. File names too.</span>
          <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      )}

      {job && (
        <div style={{ margin: "16px 0" }}>
          <Progress value={job.value} label={job.label} />
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        {error && <Notice kind="err">{error}</Notice>}
        {!files ? (
          <Spinner />
        ) : files.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No files yet.
          </p>
        ) : (
          <div className="files">
            {files.map((r) => (
              <div className="file" key={r.f.id.toString()}>
                <div>
                  <div className="name">{r.info?.name ?? "(name unreadable)"}</div>
                  <div className="muted">
                    {date(r.f.created)}
                    {!r.f.complete && " · upload interrupted"}
                  </div>
                </div>
                <span className="muted size">{bytes(r.info?.size ?? r.f.size)}</span>
                <div className="row">
                  {r.f.complete && (
                    <button type="button" className="btn small" disabled={busy} onClick={() => download(r)}>
                      Download
                    </button>
                  )}
                  <button type="button" className="btn small ghost danger" disabled={busy} onClick={() => remove(r)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Keep your own copies of anything irreplaceable. Encryption protects your files from others; it cannot protect them from a
        lost account number.
      </p>
    </div>
  );
}
