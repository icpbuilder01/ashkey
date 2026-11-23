import { Link, XmrLogo } from "../components/ui";
import { bytes, xmr } from "../lib/format";
import { useSession } from "../lib/session";

const TIERS = [
  { name: "Ember", note: "Documents, keys, scans" },
  { name: "Hearth", note: "A life's paperwork, photos", hot: true },
  { name: "Forge", note: "Archives and backups" },
];

export default function Home() {
  const { info } = useSession();
  const prices = info?.vault_prices ?? [30_000_000_000n, 100_000_000_000n, 350_000_000_000n];
  const sizes = info?.tier_bytes ?? [1_000_000_000n, 5_000_000_000n, 20_000_000_000n];
  const heritage = info?.heritage_price ?? 50_000_000_000n;
  const conf = info?.min_confirmations ?? 10;

  return (
    <div className="wrap">
      <section className="hero">
        <div>
          <div className="eyebrow">
            <XmrLogo size={16} /> Paid in XMR · No email · No KYC
          </div>
          <h1>
            A vault with <em>no name</em> on it.
          </h1>
          <p className="lede">
            Ashkey is encrypted storage and a dead man's switch that you pay for in Monero. No email, no phone, no ID: you get a
            random account number, like Mullvad. Your files are encrypted in your browser before they leave it.
          </p>
          <div className="cta">
            <Link to="/start" className="btn primary">
              Get an account number
            </Link>
            <a href="#how" className="btn ghost">
              How it works
            </a>
          </div>
          <ul className="ticks">
            <li>Your account number never leaves your device</li>
            <li>Payments checked on-chain by the canister, with a view key only</li>
            <li>Open source, reproducible builds, verifiable hashes</li>
          </ul>
        </div>
        <figure className="acct-demo-wrap">
          <div className="acct-demo" role="img" aria-label="Example of an Ashkey account, not a real one">
            <span className="demo-tag">Example</span>
            <span className="demo-mark" aria-hidden="true">SAMPLE</span>
            <div className="label">What an account looks like</div>
            <div className="num">XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX</div>
            <div className="row">
              <span>Name</span>
              <b>— none</b>
            </div>
            <div className="row">
              <span>Email</span>
              <b>— none</b>
            </div>
            <div className="row">
              <span>Vault</span>
              <b>5 GB · encrypted</b>
            </div>
            <div className="row">
              <span>Paid with</span>
              <b>0.1 XMR</b>
            </div>
            <div className="row">
              <span>Heritage switch</span>
              <b>armed · 90 days</b>
            </div>
          </div>
          <figcaption>
            Illustration only. Your real account number is 28 random characters, generated in your browser when you sign up and
            shown only to you.
          </figcaption>
        </figure>
      </section>

      <section>
        <div className="section-head">
          <h2>What Ashkey knows about you</h2>
          <p>Not much. We built it so that a subpoena, a leak or a curious operator gets as little as possible.</p>
        </div>
        <div className="card">
          <table className="cmp">
            <thead>
              <tr>
                <th>About you</th>
                <th>What the service sees</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Name, email, phone</td>
                <td className="yes">Nothing. We never ask.</td>
              </tr>
              <tr>
                <td>Your account number</td>
                <td className="yes">Never received. Only a public key derived from it.</td>
              </tr>
              <tr>
                <td>Your files and their names</td>
                <td>Encrypted blobs, their sizes and upload times.</td>
              </tr>
              <tr>
                <td>Your Monero wallet</td>
                <td>That an amount arrived at a one-time subaddress. Not where it came from.</td>
              </tr>
              <tr>
                <td>Your IP address</td>
                <td>Like any website, the nodes serving the page can see it. Use Tor if that matters to you.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="pricing">
        <div className="section-head">
          <h2>Vault: encrypted storage</h2>
          <p>
            Drop files in, they are encrypted with a key derived from your account number, then stored on the Internet Computer.
            Pay per year in XMR. No auto-renewal, no card on file, nothing to cancel.
          </p>
        </div>
        <div className="grid g3">
          {TIERS.map((t, i) => (
            <div key={t.name} className={`card price${t.hot ? " hot" : ""}`}>
              <div className="row between">
                <span className="tier">{t.name}</span>
                {t.hot && <span className="badge">Popular</span>}
              </div>
              <div className="size">{bytes(sizes[i])}</div>
              <div className="amt">
                <XmrLogo size={17} /> {xmr(prices[i])} XMR <small>/ year</small>
              </div>
              <ul>
                <li>{t.note}</li>
                <li>Encrypted in your browser</li>
                <li>Self-destructs if you stop paying</li>
                <li>Pay 1, 2 or 3 years at once</li>
              </ul>
              <Link to={`/start?p=v${i + 1}`} className={`btn ${t.hot ? "primary" : ""} block`}>
                Choose {bytes(sizes[i])}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="card heritage-card">
          <div>
            <div className="eyebrow">Heritage switch</div>
            <h2>If you disappear, the right people get the keys.</h2>
            <p>
              Write a letter, attach documents and important information, and name up to five heirs. Each heir gets a private
              link. The content stays locked until you stop checking in: then, and only then, the Internet Computer releases the
              key. Until that moment, nobody can open it, including the people you chose.
            </p>
            <div className="row">
              <span className="amt" style={{ color: "var(--ember2)", fontWeight: 600, fontSize: 18 }}>
                <XmrLogo size={17} /> {xmr(heritage)} XMR / year
              </span>
              <span className="muted">· up to 10 MB · 5 heirs · 3 switches</span>
            </div>
            <div className="cta">
              <Link to="/start?p=h" className="btn primary">
                Set up a switch
              </Link>
            </div>
          </div>
          <div className="steps">
            <div className="card">
              <h3>You write it, it's sealed</h3>
              <p>Encrypted twice in your browser: once for the heir links, once to a key the network only reveals on release.</p>
            </div>
            <div className="card">
              <h3>You check in</h3>
              <p>Every 30, 90, 180 or 365 days, a single click: "still here". Signing in does it too.</p>
            </div>
            <div className="card">
              <h3>You go silent, it opens</h3>
              <p>Past the deadline, each heir opens their link and reads the content. No account, no login, no wallet needed.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="how">
        <div className="section-head">
          <XmrLogo size={44} />
          <h2 style={{ marginTop: 14 }}>Paying is a Monero transaction. That's it.</h2>
          <p>No payment processor, no exchange, no middleman holding your money. The canister checks the blockchain itself.</p>
        </div>
        <div className="grid g4">
          <div className="card feature">
            <div className="ico">①</div>
            <h3>Pick a plan</h3>
            <p>Your browser generates a 128-bit account number. Write it down: it is your only login.</p>
          </div>
          <div className="card feature">
            <div className="ico">②</div>
            <h3>Send XMR</h3>
            <p>To a fresh subaddress made for your order, from any wallet: Feather, Cake, the CLI.</p>
          </div>
          <div className="card feature">
            <div className="ico">③</div>
            <h3>Paste the TXID</h3>
            <p>The canister asks two independent Monero nodes and checks the outputs with a view key.</p>
          </div>
          <div className="card feature">
            <div className="ico">④</div>
            <h3>{conf} confirmations</h3>
            <p>About {conf * 2} minutes later, your account is active. The XMR never passes through anyone else.</p>
          </div>
        </div>
      </section>

      <section>
        <div className="grid g3">
          <div className="card feature">
            <div className="ico">🔥</div>
            <h3>Stop paying, it burns</h3>
            <p>
              Unpaid vaults are destroyed automatically {info ? Number(info.vault_grace_sec) / 86400 : 7} days after expiry. No
              dormant copy kept "just in case".
            </p>
          </div>
          <div className="card feature">
            <div className="ico">⛓</div>
            <h3>No server to seize</h3>
            <p>
              Ashkey runs as smart contracts on the Internet Computer, replicated across independent node providers. There is no
              VPS, no hosting account, no admin panel with your data.
            </p>
          </div>
          <div className="card feature">
            <div className="ico">🔍</div>
            <h3>Verify, don't trust</h3>
            <p>
              The code is open source and the build is reproducible: compile it yourself and compare the hash with the live one.{" "}
              <Link to="/trust">See the proofs →</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="narrow">
        <h2>Questions</h2>
        <details>
          <summary>I lost my account number. Can you recover it?</summary>
          <p>
            No. We never had it. That's the point: nobody can be forced to hand over what they don't have. Keep it on paper, in
            your password manager, or both.
          </p>
        </details>
        <details>
          <summary>Can you read my files?</summary>
          <p>
            The service stores encrypted chunks and encrypted file names. The key comes from your account number, which is never
            sent. What you do trust is the web page code itself, served by the canister: that is why it is open source and
            hash-verifiable. Details on the <Link to="/trust">trust page</Link>.
          </p>
        </details>
        <details>
          <summary>Why does the canister need a view key? Can it take my money?</summary>
          <p>
            A view key can only see incoming payments to the service wallet; it cannot spend anything. It lets the canister confirm
            your payment by itself, without a payment processor. Your XMR goes straight to the operator's wallet, which the
            canister cannot touch.
          </p>
        </details>
        <details>
          <summary>What happens when my plan expires?</summary>
          <p>
            Vault: read-only for {info ? Number(info.vault_grace_sec) / 86400 : 7} days so you can download or renew, then
            everything is deleted. Heritage: your switches keep working and you can still check in, but if you don't renew within{" "}
            {info ? Number(info.heritage_grace_sec) / 86400 : 30} days they release to your heirs rather than being destroyed:
            heirs come first. Released switches are deleted 180 days later.
          </p>
        </details>
        <details>
          <summary>Can I pay from an exchange?</summary>
          <p>
            Technically yes, but an exchange knows who you are and where the coins went. Pay from a wallet you control. Exchanges
            also often don't show a transaction ID you can paste.
          </p>
        </details>
        <details>
          <summary>What if Ashkey's operator disappears?</summary>
          <p>
            The canisters keep running as long as they have cycles (the Internet Computer's gas). The plan is to make the service
            autonomous and give up control once the code has proven itself. Until then, keep your own copies of what matters: no
            single place should hold the only one.
          </p>
        </details>
        <details>
          <summary>Is there anything I can't store?</summary>
          <p>
            Anything illegal. We can't see your files, but the rules still apply to you. See the <Link to="/terms">terms</Link>.
          </p>
        </details>
      </section>

      <section className="card" style={{ textAlign: "center", padding: "46px 24px" }}>
        <h2>Ready when you are.</h2>
        <p>One account number. One Monero transaction. Nothing else.</p>
        <div className="cta" style={{ justifyContent: "center" }}>
          <Link to="/start" className="btn primary">
            Get an account number
          </Link>
          <Link to="/login" className="btn ghost">
            I already have one
          </Link>
        </div>
      </section>
    </div>
  );
}
