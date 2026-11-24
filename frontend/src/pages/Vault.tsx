import { useEffect, useRef, useState } from "react";
import type { FileView } from "../bindings/ashkey/ashkey";
import { Link, Notice, Progress, Spinner } from "../components/ui";
import { cipherSize, chunkCount, decryptChunk, makePreview, newFileSecrets, openThumb, previewKind, readFileMeta, sealThumb, type FileInfo, type PreviewKind } from "../lib/crypto";
import { ok } from "../lib/env";
import { bytes, date, until } from "../lib/format";
import { useAction, useLoad } from "../lib/hooks";
import { useSession } from "../lib/session";
import { downloadChunks, saveAs, uploadChunks } from "../lib/transfer";

interface Row {
  f: FileView;
  info: FileInfo | null; // null if the name could not be decrypted
}

const kindOf = (r: Row): PreviewKind | null => (r.info ? previewKind(r.info.type, r.info.name) : null);
const TEXT_VIEW_MAX = 5_000_000; // larger text files are downloaded instead of shown

type Thumb = { img: string } | { text: string };
type Viewing = { row: Row; url: string; kind: PreviewKind; text?: string };

export default function Vault() {
  const { account, me, api, refresh, toast } = useSession();
  const { data: files, error, reload } = useLoad(async () => {
    if (!account) return [];
    // The canister returns files page by page (400 at a time).
    const list: FileView[] = [];
    for (let after: bigint | null = null; ; ) {
      const page = await api.file_list(after);
      list.push(...page);
      if (page.length < 400) break;
      after = page[page.length - 1].id;
    }
    const rows: Row[] = [];
    for (const f of list) rows.push({ f, info: await readFileMeta(account.vaultKey, f.meta).catch(() => null) });
    return rows.sort((a, b) => Number(b.f.created - a.f.created));
  }, [api, account]);
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const [job, setJob] = useState<{ label: string; value: number } | null>(null);
  const [over, setOver] = useState(false);
  const [view, setView] = useState<Viewing | null>(null);
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
    // Stored previews, plus text files without one: their first lines are read
    // straight from the (decrypted) first chunk.
    const todo = files.filter((r) => r.info && r.f.complete && (r.f.has_thumb || kindOf(r) === "text") && !thumbs[r.f.id.toString()]);
    (async () => {
      for (let i = 0; i < todo.length && alive; i += 4) {
        const batch = await Promise.all(
          todo.slice(i, i + 4).map(async (r) => {
            try {
              const info = r.info!;
              if (kindOf(r) === "text") {
                const plain = r.f.has_thumb
                  ? await openThumb(info, ok(await api.file_thumb(r.f.id)))
                  : await decryptChunk(info.key, info.nonce, ok(await api.file_chunk(r.f.id, 0)), 0);
                return [r.f.id.toString(), { text: new TextDecoder("utf-8", { fatal: false }).decode(plain.slice(0, 6000)).slice(0, 1200) } as Thumb] as const;
              }
              const plain = await openThumb(info, ok(await api.file_thumb(r.f.id)));
              const t: Thumb = { img: URL.createObjectURL(new Blob([plain], { type: "image/webp" })) };
              return [r.f.id.toString(), t] as const;
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
        const thumb = await makePreview(file, file.type, file.name);
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
      const kind = kindOf(r);
      if (!kind || (kind === "text" && (r.info?.size ?? 0) > TEXT_VIEW_MAX)) return download(r);
      const parts = await fetchFile(r);
      const blob = new Blob(parts, { type: r.info!.type || (kind === "text" ? "text/plain" : "") });
      const text = kind === "text" ? new TextDecoder("utf-8", { fatal: false }).decode(await blob.arrayBuffer()) : undefined;
      setView({ row: r, url: URL.createObjectURL(blob), kind, text });
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
        const info = r.info!;
        // Text previews only need the first chunk; images and videos need the whole file.
        const parts =
          kindOf(r) === "text" ? [await decryptChunk(info.key, info.nonce, ok(await api.file_chunk(r.f.id, 0)), 0)] : await fetchFile(r);
        const thumb = await makePreview(new Blob(parts, { type: info.type }), info.type, info.name);
        if (thumb) await api.file_set_thumb(r.f.id, await sealThumb(r.info!, thumb));
        n++;
      }
      await refresh();
      reload();
    }).finally(() => setJob(null));

  const q = query.trim().toLowerCase();
  const shown = (files ?? []).filter((r) => !q || (r.info?.name ?? "").toLowerCase().includes(q));
  const tiles = shown.filter((r) => kindOf(r) !== null && r.f.complete);
  const others = shown.filter((r) => !tiles.includes(r));
  const missing = tiles.filter((r) => !r.f.has_thumb && kindOf(r) !== "text");
  const pct = me.quota > 0n ? Number((me.used * 1000n) / me.quota) / 10 : 0;

  return (
    <div className="wrap" style={{ maxWidth: 1040 }}>
      <div className="row between">
        <h1 style={{ fontSize: 40, margin: 0 }}>
          <span aria-hidden="true">🔐</span> Vault
        </h1>
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
          <span className="muted">Encrypted in this browser before upload. File names and previews too.</span>
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

          {tiles.length > 0 && (
            <div className="gallery">
              {tiles.map((r) => {
                const t = thumbs[r.f.id.toString()];
                const kind = kindOf(r);
                return (
                  <button type="button" key={r.f.id.toString()} className={`tile tile-${kind}`} disabled={busy} onClick={() => open(r)} title={r.info?.name}>
                    {t && "img" in t ? (
                      <img src={t.img} alt={r.info?.name ?? ""} loading="lazy" />
                    ) : t && "text" in t ? (
                      <pre className="tile-text">{t.text}</pre>
                    ) : (
                      <span className="tile-ph">{r.f.has_thumb ? <Spinner /> : kind === "video" ? "🎬" : kind === "text" ? "📄" : "🖼"}</span>
                    )}
                    {kind === "video" && t && "img" in t && <span className="tile-play" aria-hidden="true">▶</span>}
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
          {view.kind === "image" && <img src={view.url} alt={view.row.info?.name ?? ""} onClick={(e) => e.stopPropagation()} />}
          {view.kind === "video" && <video src={view.url} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />}
          {view.kind === "text" && (
            <pre className="lightbox-text" onClick={(e) => e.stopPropagation()}>
              {view.text}
            </pre>
          )}
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
