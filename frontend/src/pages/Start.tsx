import { useEffect, useState } from "react";
import { Copy, Link, Notice } from "../components/ui";
import { navigate, useAction } from "../lib/hooks";
import { newAccountNumber } from "../lib/account";
import { ok } from "../lib/env";
import { productOf, type Choice } from "../lib/plans";
import { useSession } from "../lib/session";
import PlanPicker from "../components/PlanPicker";


function initialChoice(): Choice {
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "").get("p");
  return p === "v1" || p === "v2" || p === "v3" || p === "h" ? p : "v2";
}

export default function Start() {
  const { info, account, api, signIn, toast } = useSession();
  const [choice, setChoice] = useState<Choice>(initialChoice);
  const [years, setYears] = useState(1);
  const [number, setNumber] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [stay, setStay] = useState(false);
  const { busy, run } = useAction((m) => toast(m, "err"));

  useEffect(() => {
    if (!account) newAccountNumber().then(setNumber);
  }, [account]);

  const order = () =>
    run(async () => {
      let a = api;
      if (!account) {
        if (!number || !saved) return;
        a = await signIn(number, stay);
      }
      const o = ok(await a.create_order(productOf(choice), years));
      navigate(`/pay/${o.id}`);
    });

  const download = () => {
    if (!number) return;
    const text = `Ashkey account number\n\n${number}\n\nThis number is your only login. It cannot be recovered.\nSign in at ${location.origin}/#/login\n`;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "ashkey-account.txt" });
    a.click();
  };

  return (
    <div className="wrap narrow">
      <h1 style={{ fontSize: 40 }}>{account ? "Add a plan" : "Get an account number"}</h1>
      <p>No email, no password, no personal details. Pick what you need, then pay in XMR.</p>

      {info && !info.payments_ready && <Notice kind="warn">Payments are not open yet. You can look around, but orders will be refused.</Notice>}
      {info?.paused && <Notice kind="warn">New orders are paused for maintenance. Existing accounts are not affected.</Notice>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>1. Choose a plan</h3>
        <PlanPicker choice={choice} setChoice={setChoice} years={years} setYears={setYears} />
      </div>

      {!account && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3>2. Save your account number</h3>
          <p>Generated in this browser just now. It is your login and your encryption key. Nobody else has it, so nobody can give it back to you.</p>
          <div className="bignum">{number ?? "…"}</div>
          <div className="row">
            {number && <Copy text={number} label="Copy" />}
            <button type="button" className="btn small ghost" onClick={download}>
              Download .txt
            </button>
            <button type="button" className="btn small ghost" onClick={() => newAccountNumber().then(setNumber)}>
              Generate another
            </button>
          </div>
          <label className="check" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I have written it down somewhere safe. I understand it cannot be recovered.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} />
            <span>Keep me signed in on this device (stores the number in this browser; don't use on a shared computer).</span>
          </label>
        </div>
      )}

      <button type="button" className="btn primary block" disabled={busy || (!account && !saved)} onClick={order}>
        {busy ? "Preparing your payment address…" : `${account ? "Continue" : "3. Continue"} to payment`}
      </button>
      {!account && (
        <p className="muted" style={{ marginTop: 14, textAlign: "center" }}>
          Already have a number? <Link to="/login">Sign in</Link>
        </p>
      )}
    </div>
  );
}
