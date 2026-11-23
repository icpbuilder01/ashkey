import { CanisterStatus, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { Copy, Notice, Spinner } from "../components/ui";
import { useLoad } from "../lib/hooks";
import { backendId, frontendId, isLocal, rootKey } from "../lib/env";
import { useSession } from "../lib/session";

const REPO = "https://github.com/icpbuilder01/ashkey";

function hex(b: unknown): string {
  if (b instanceof ArrayBuffer) b = new Uint8Array(b);
  if (b instanceof Uint8Array) return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return String(b ?? "—");
}

async function status(id: string) {
  const agent = await HttpAgent.create({ host: isLocal ? location.origin : "https://icp-api.io", rootKey, shouldFetchRootKey: false });
  const r = await CanisterStatus.request({ canisterId: Principal.fromText(id), agent, paths: ["module_hash", "controllers"] });
  const controllers = (r.get("controllers") as Principal[] | undefined)?.map((p) => p.toText()) ?? [];
  return { hash: hex(r.get("module_hash")), controllers };
}

export default function Trust() {
  const { info } = useSession();
  const { data: back, error: e1 } = useLoad(() => status(backendId), []);
  const { data: front, error: e2 } = useLoad(() => status(frontendId), []);

  return (
    <div className="wrap narrow">
      <h1 style={{ fontSize: 40 }}>Verify, don't trust</h1>
      <p>
        Everything below is read live from the Internet Computer, certified by the network, not by this website. Compare it with
        what you build yourself from the source code.
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Live canisters</h3>
        {(e1 || e2) && <Notice kind="warn">{e1 || e2}</Notice>}
        <dl className="kv">
          <dt>Backend</dt>
          <dd className="mono">{backendId}</dd>
          <dt>Backend module hash</dt>
          <dd className="mono">{back ? back.hash : <Spinner />}</dd>
          <dt>Backend controllers</dt>
          <dd className="mono">{back ? back.controllers.join(", ") || "none (blackholed)" : <Spinner />}</dd>
          <dt>Website</dt>
          <dd className="mono">{frontendId}</dd>
          <dt>Website controllers</dt>
          <dd className="mono">{front ? front.controllers.join(", ") || "none (blackholed)" : <Spinner />}</dd>
          <dt>Version</dt>
          <dd>{info?.version ?? "…"}</dd>
          <dt>Monero nodes used</dt>
          <dd className="mono">{info?.nodes.join(", ") || "—"}</dd>
        </dl>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Rebuild it yourself</h3>
        <p>The backend build is reproducible: same source, same toolchain, same bytes, on any machine.</p>
        <pre className="addr" style={{ whiteSpace: "pre-wrap" }}>
          {`git clone ${REPO}
cd ashkey
./scripts/build-backend.sh      # prints the SHA-256
icp canister status ${backendId} -e ic   # compare "Module hash"`}
        </pre>
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn small" href={REPO} target="_blank" rel="noopener noreferrer">
            Source code
          </a>
          <Copy text={backendId} label="Copy backend ID" />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>How your data is protected</h3>
        <ul style={{ color: "var(--ink2)", paddingLeft: 20, display: "grid", gap: 8 }}>
          <li>
            Your <b>account number</b> (128 random bits) is turned, in your browser, into an Ed25519 signing key and an AES-256
            key (HKDF-SHA-256). The canister only sees the public key's principal.
          </li>
          <li>
            <b>Vault files</b> are split in 1 MiB chunks, each encrypted with AES-256-GCM under a random per-file key. File names
            and keys are encrypted with your account key.
          </li>
          <li>
            <b>Heritage switches</b> use two independent locks: an inner AES layer whose key only exists in the heir's link, and a
            vetKeys identity-based encryption layer that the subnet only opens after release. The public key is checked against
            the Internet Computer's published master key before anything is encrypted.
          </li>
          <li>
            <b>Payments</b> are verified by the canister with the service wallet's view key, against two independent Monero
            nodes, after {info?.min_confirmations ?? 10} confirmations. The canister cannot spend.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>What you still have to trust</h3>
        <ul style={{ color: "var(--ink2)", paddingLeft: 20, display: "grid", gap: 8 }}>
          <li>
            <b>The website code.</b> It runs in your browser and handles your keys. While the website canister has a controller,
            its code could be changed. Check its controllers above; the goal is to remove them once the code is stable.
          </li>
          <li>
            <b>The Internet Computer subnet</b> for heritage releases: a majority of its nodes would have to collude to release a
            key early.
          </li>
          <li>
            <b>Availability.</b> Canisters run on cycles. Keep your own copy of anything irreplaceable.
          </li>
          <li>
            <b>The Monero nodes</b> for payment checks: two independent nodes must agree, and the transaction must hash to its ID.
          </li>
        </ul>
      </div>
    </div>
  );
}
