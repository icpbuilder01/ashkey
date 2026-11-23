import { useState } from "react";
import { Link } from "../components/ui";
import { navigate, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";

export default function Login() {
  const { signIn, toast } = useSession();
  const [number, setNumber] = useState("");
  const [stay, setStay] = useState(false);
  const { busy, run } = useAction((m) => toast(m, "err"));

  const go = () =>
    run(async () => {
      await signIn(number, stay);
      navigate("/account");
    });

  return (
    <div className="wrap narrow" style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: 40 }}>Sign in</h1>
      <p>Type your account number. It never leaves this browser: it is turned into a signing key and an encryption key right here.</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <label className="field">
          Account number
          <input
            type="password"
            className="acct-input"
            autoComplete="current-password"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            autoFocus
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} />
          <span>Keep me signed in on this device</span>
        </label>
        <button className="btn primary block" disabled={busy || number.replace(/[\s-]/g, "").length < 28}>
          {busy ? "Deriving keys…" : "Sign in"}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 16, textAlign: "center" }}>
        No number yet? <Link to="/start">Get one</Link>. There is no "forgot password": a lost number cannot be recovered.
      </p>
    </div>
  );
}
