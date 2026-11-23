import { useEffect, useRef, useState } from "react";
import type { FileView } from "../bindings/ashkey/ashkey";
import { Link, Notice, Progress, Spinner } from "../components/ui";
import { cipherSize, chunkCount, makeThumb, newFileSecrets, openThumb, readFileMeta, sealThumb, type FileInfo } from "../lib/crypto";
import { ok } from "../lib/env";
import { bytes, date, until } from "../lib/format";
import { useAction, useLoad } from "../lib/hooks";
import { useSession } from "../lib/session";
import { downloadChunks, saveAs, uploadChunks } from "../lib/transfer";

interface Row {
  f: FileView;
  info: FileInfo | null; // null if the name could not be decrypted
}

const isImage = (r: Row) => !!r.info && r.info.type.startsWith("image/") && r.info.type !== "image/svg+xml";

export default function Vault() {
  const { account, me, api, refresh, toast } = useSession();
  const { data: files, error, reload } = useLoad(async () => {
    if (!account) return [];
    const list = await api.file_list();
    const rows: Row[] = [];
    for (const f of list) rows.push({ f, info: await readFileMeta(account.vaultKey, f.meta).catch(() => null) });
    return rows.sort((a, b) => Number(b.f.created - a.f.created));
  }, [api, account]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [job, setJob] = useState<{ label: string; value: number } | null>(null);
  const [over, setOver] = useState(false);
  const [view, setView] = useState<{ row: Row; url: string } | null>(null);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction((m) => toast(m, "err"));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch and decrypt thumbnails, a few at a time.
  useEffect(() => {
    if (!files) return;
    let alive = true;
    const todo = files.filter((r) => r.f.has_thumb && r.info && !thumbs[r.f.id.toString()]);
    (async () => {
      for (let i = 0; i < todo.length && alive; i += 4) {
        const batch = await Promise.all(
          todo.slice(i, i + 4).map(async (r) => {
            try {
              const plain = await openThumb(r.info!, ok(await api.file_thumb(r.f.id)));
              return [r.f.id.toString(), URL.createObjectURL(new Blob([plain], { type: "image/webp" }))] as const;
            } catch {
              return null;
            }
          })
        );
        if (alive) setThumbs((t) => ({ ...t, ...Object.fromEntries(batch.filter((x) => x !== null)) }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, api]);

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
        const thumb = await makeThumb(file);
        if (thumb) await api.file_set_thumb(id, await sealThumb(info, thumb)); // a missing preview is not an error
        await refresh();
        reload();
      }
      setJob(null);
      toast("Uploaded and encrypted.", "ok");
    }).finally(() => setJob(null));

  const fetchFile = async (r: Row) => {
    if (!r.info) throw new Error("This file's name could not be decrypted.");
    const info = r.info;
    return downloadChunks(r.f.chunks, info.key, info.nonce, (i) => api.file_chunk(r.f.id, i), (d, t) =>
      setJob({ label: `Downloading and decrypting ${info.name} · ${d}/${t}`, value: d / t })
    );
  };

  const download = (r: Row) =>
    run(async () => {
      saveAs(await fetchFile(r), r.info!.name, r.info!.type);
    }).finally(() => setJob(null));

  const open = (r: Row) =>
    run(async () => {
      const parts = await fetchFile(r);
      setView({ row: r, url: URL.createObjectURL(new Blob(parts, { type: r.info!.type })) });
    }).finally(() => setJob(null));

  const remove = (r: Row) =>
    run(async () => {
      if (!confirm(`Delete ${r.info?.name ?? "this file"} for good?`)) return;
      ok(await api.file_delete(r.f.id));
      setView(null);
      await refresh();
      reload();
    });

  /** Images uploaded before previews existed: make their thumbnails now. */
  const makePreviews = (rows: Row[]) =>
    run(async () => {
      let n = 0;
      for (const r of rows) {
        setJob({ label: `Creating previews · ${n + 1}/${rows.length}`, value: n / rows.length });
        const parts = await fetchFile(r);
        const thumb = await makeThumb(new Blob(parts, { type: r.info!.type }));
        if (thumb) await api.file_set_thumb(r.f.id, await sealThumb(r.info!, thumb));
        n++;
      }
      await refresh();
      reload();
    }).finally(() => setJob(null));

  const q = query.trim().toLowerCase();
  const shown = (files ?? []).filter((r) => !q || (r.info?.name ?? "").toLowerCase().includes(q));
  const images = shown.filter((r) => isImage(r) && r.f.complete);
  const others = shown.filter((r) => !images.includes(r));
  const missing = images.filter((r) => !r.f.has_thumb);
  const pct = me.quota > 0n ? Number((me.used * 1000n) / me.quota) / 10 : 0;

  return (
    <div className="wrap" style={{ maxWidth: 1040 }}>
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
          <span className="muted">Encrypted in this browser before upload. File names and image previews too.</span>
          <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      )}

      {job && (
        <div style={{ margin: "16px 0" }}>
          <Progress value={job.value} label={job.label} />
        </div>
      )}

      {error && <Notice kind="err">{error}</Notice>}
      {!files ? (
        <div className="card" style={{ marginTop: 20 }}>
          <Spinner />
        </div>
      ) : files.length === 0 ? (
        <div className="card" style={{ marginTop: 20 }}>
          <p className="muted" style={{ margin: 0 }}>
            No files yet.
          </p>
        </div>
      ) : (
        <>
          <div className="row between" style={{ margin: "22px 0 12px" }}>
            <input type="text" placeholder={`Search ${files.length} file${files.length > 1 ? "s" : ""}…`} value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320 }} />
            {missing.length > 0 && me.vault_active && (
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => makePreviews(missing)}>
                Create {missing.length} missing preview{missing.length > 1 ? "s" : ""}
              </button>
            )}
          </div>

          {images.length > 0 && (
            <div className="gallery">
              {images.map((r) => {
                const url = thumbs[r.f.id.toString()];
                return (
                  <button type="button" key={r.f.id.toString()} className="tile" disabled={busy} onClick={() => open(r)} title={r.info?.name}>
                    {url ? <img src={url} alt={r.info?.name ?? ""} loading="lazy" /> : <span className="tile-ph">{r.f.has_thumb ? <Spinner /> : "🖼"}</span>}
                    <span className="tile-name">{r.info?.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          {others.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="files">
                {others.map((r) => (
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
            </div>
          )}
          {shown.length === 0 && <p className="muted">Nothing matches "{query}".</p>}
        </>
      )}

      {view && (
        <div
          className="lightbox"
          role="dialog"
          aria-label={view.row.info?.name}
          onClick={() => (URL.revokeObjectURL(view.url), setView(null))}
        >
          <img src={view.url} alt={view.row.info?.name ?? ""} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span className="name">
              {view.row.info?.name} <span className="muted">· {bytes(view.row.info?.size ?? 0)} · {date(view.row.f.created)}</span>
            </span>
            <span className="row">
              <a className="btn small" href={view.url} download={view.row.info?.name ?? "image"}>
                Download
              </a>
              <button type="button" className="btn small ghost danger" onClick={() => remove(view.row)}>
                Delete
              </button>
              <button type="button" className="btn small ghost" onClick={() => (URL.revokeObjectURL(view.url), setView(null))}>
                Close
              </button>
            </span>
          </div>
        </div>
      )}

      <p className="muted" style={{ marginTop: 20 }}>
        Keep your own copies of anything irreplaceable. Encryption protects your files from others; it cannot protect them from a
        lost account number.
      </p>
    </div>
  );
}
