import { useState } from "react";
import { Notice, Progress, Spinner } from "../components/ui";
import { useAction, useLoad } from "../lib/hooks";
import { checkHeritageKey, fromB64Url, heirProof, newTransportKey, openSwitchKey, unpackHeritage, type Attachment } from "../lib/crypto";
import { backendId, getActor, ok } from "../lib/env";
import { bytes, dateTime, until } from "../lib/format";
import { useSession } from "../lib/session";
import { downloadChunks, saveAs } from "../lib/transfer";

/** The page a heir opens from their link. No account, no login. */
export default function Open({ id, secret }: { id: bigint; secret: string }) {
  const { info, toast } = useSession();
  const api = getActor();
  const { data: view, error } = useLoad(async () => {
    const proof = await heirProof(fromB64Url(secret));
    return { proof, v: ok(await api.heir_lookup(id, proof)) };
  }, [id, secret]);
  const [content, setContent] = useState<{ message: string; files: Attachment[] } | null>(null);
  const [job, setJob] = useState<number | null>(null);
  const { busy, run } = useAction((m) => toast(m, "err"));

  const open = () =>
    run(async () => {
      if (!view || !info) return;
      const pk = info.heritage_public_key;
      if (!pk) throw new Error("The service key is not available yet. Try again later.");
      checkHeritageKey(info.key_name, info.heritage_context, backendId, pk);
      const tsk = newTransportKey();
      const opened = ok(await api.heir_open(id, view.proof, tsk.publicKeyBytes()));
      const { key, nonce } = await openSwitchKey(pk, tsk, opened, fromB64Url(secret));
      setJob(0);
      const parts = await downloadChunks(view.v.chunks, key, nonce, (i) => api.heir_chunk(id, view.proof, i), (d, t) => setJob(d / t));
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      setContent(unpackHeritage(all));
    }).finally(() => setJob(null));

  return (
    <div className="wrap narrow">
      <h1 style={{ fontSize: 40 }}>A message left for you</h1>
      <p>Someone used Ashkey to leave you something, to be opened only if they stopped checking in. This page decrypts it in your browser.</p>
      {error && <Notice kind="err">{error}</Notice>}
      {!view && !error && <Spinner />}
      {view && !content && (
        <div className="card">
          {view.v.released ? (
            <>
              <Notice kind="info">
                This switch has been released. Opening it uses one of your link's openings: {view.v.opens_left} left. Save what you
                need once it is open.
              </Notice>
              <p className="muted">Content: {bytes(view.v.size)}, encrypted.</p>
              {job !== null && <Progress value={job} label="Downloading and decrypting" />}
              <button type="button" className="btn primary" disabled={busy || view.v.opens_left === 0} onClick={open}>
                {busy ? "Opening…" : "Open it"}
              </button>
            </>
          ) : (
            <Notice kind="info">
              Not now. This switch is still armed: its owner has been checking in. It can only open after {dateTime(view.v.deadline)} (
              {until(view.v.deadline)}), and only if they stop. Keep this link safe and private.
            </Notice>
          )}
        </div>
      )}
      {content && (
        <div className="card">
          <div className="message">{content.message}</div>
          {content.files.length > 0 && (
            <>
              <h3 style={{ marginTop: 20 }}>Attachments</h3>
              {content.files.map((f, i) => (
                <div key={i} className="row between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                  <span>
                    {f.name} <span className="muted">{bytes(f.data.length)}</span>
                  </span>
                  <button type="button" className="btn small" onClick={() => saveAs([f.data as Uint8Array<ArrayBuffer>], f.name, f.type)}>
                    Save
                  </button>
                </div>
              ))}
            </>
          )}
          <Notice kind="warn">
            <span style={{ display: "block", marginTop: 4 }}>Copy or save this now. The link can only be opened a few times and the content is deleted 180 days after release.</span>
          </Notice>
        </div>
      )}
    </div>
  );
}
