import { useState } from "react";
import { Copy, Link, Notice, Spinner } from "../components/ui";
import { navigate, useAction, useLoad } from "../lib/hooks";
import { ok } from "../lib/env";
import { bytes, date, until, xmr } from "../lib/format";
import { useSession } from "../lib/session";
import PlanPicker from "../components/PlanPicker";
import { productName, productOf, type Choice } from "../lib/plans";

export default function Account() {
  const { account, me, api, info, signOut, toast } = useSession();
  const { data: orders } = useLoad(() => api.my_orders(), [api]);
  const [show, setShow] = useState(false);
  const [choice, setChoice] = useState<Choice>("v2");
  const [years, setYears] = useState(1);
  const { busy, run } = useAction((m) => toast(m, "err"));

  if (!account || !me)
    return (
      <div className="wrap narrow">
        <Notice kind="info">
          <Link to="/login">Sign in</Link> to see your account.
        </Notice>
      </div>
    );

  const pending = (orders ?? []).filter((o) => !o.paid);
  const usedPct = me.quota > 0n ? Number((me.used * 1000n) / me.quota) / 10 : 0;

  const buy = () =>
    run(async () => {
      const o = ok(await api.create_order(productOf(choice), years));
      navigate(`/pay/${o.reference}`);
    });

  return (
    <div className="wrap" style={{ maxWidth: 960 }}>
      <div className="row between">
        <h1 style={{ fontSize: 40, margin: 0 }}>Your account</h1>
        <button type="button" className="btn small ghost" onClick={() => (signOut(), navigate("/"))}>
          Sign out
        </button>
      </div>
      <div className="card" style={{ margin: "20px 0" }}>
        <div className="row between">
          <div>
            <div className="muted">Account number</div>
            <div className="mono" style={{ fontSize: 18, color: "var(--ember2)" }}>{show ? account.text : account.text.replace(/[^-]/g, "•")}</div>
          </div>
          <div className="row">
            <button type="button" className="btn small ghost" onClick={() => setShow(!show)}>
              {show ? "Hide" : "Show"}
            </button>
            <Copy text={account.text} />
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <Notice kind="warn">
          Unpaid order{pending.length > 1 ? "s" : ""}:{" "}
          {pending.map((o) => (
            <Link key={o.reference} to={`/pay/${o.reference}`}>
              {o.reference} {productName(o, info?.tier_bytes)} ({xmr(o.amount - o.received)} XMR){" "}
            </Link>
          ))}
        </Notice>
      )}

      <div className="grid g2">
        <div className="card">
          <div className="row between">
            <h3>Vault</h3>
            {me.vault_active ? <span className="pill ok">active</span> : me.vault_tier > 0 ? <span className="pill err">expired</span> : <span className="pill">none</span>}
          </div>
          {me.vault_tier > 0 ? (
            <>
              <p>
                {bytes(me.quota)} plan · {me.vault_active ? `paid until ${date(me.vault_until)} (${until(me.vault_until)})` : `expired ${date(me.vault_until)}`}
              </p>
              <div className="meter">
                <div style={{ width: `${Math.min(100, usedPct)}%` }} />
              </div>
              <p className="muted">
                {bytes(me.used)} of {bytes(me.quota)} used
              </p>
              {me.vault_destroy_at !== undefined && (
                <Notice kind="err">Files will be destroyed {date(me.vault_destroy_at)} ({until(me.vault_destroy_at)}) unless you renew.</Notice>
              )}
              <Link to="/vault" className="btn primary">
                Open vault
              </Link>
            </>
          ) : (
            <p>No vault yet. Pick a size below.</p>
          )}
        </div>
        <div className="card">
          <div className="row between">
            <h3>Heritage</h3>
            {me.heritage_active ? <span className="pill ok">active</span> : me.heritage_until > 0n ? <span className="pill warn">lapsed</span> : <span className="pill">none</span>}
          </div>
          {me.heritage_until > 0n ? (
            <>
              <p>{me.heritage_active ? `Paid until ${date(me.heritage_until)} (${until(me.heritage_until)}).` : `Lapsed ${date(me.heritage_until)}. Armed switches release to heirs ${info ? Number(info.heritage_grace_sec) / 86400 : 30} days after lapsing.`}</p>
              <Link to="/heritage" className="btn primary">
                Open heritage
              </Link>
            </>
          ) : (
            <p>No heritage plan yet.</p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Renew, upgrade or add a plan</h3>
        <p className="muted">
          Renewing the same vault size adds time. Changing size converts your remaining time at the price ratio. Heritage adds a
          year from today or from its current end.
        </p>
        <PlanPicker choice={choice} setChoice={setChoice} years={years} setYears={setYears} />
        <button type="button" className="btn primary" disabled={busy} onClick={buy}>
          {busy ? <Spinner /> : "Continue to payment"}
        </button>
      </div>
    </div>
  );
}
