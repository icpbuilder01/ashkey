import { useEffect, useRef, useState } from "react";
import type { PaymentStatus } from "../bindings/ashkey/ashkey";
import { Copy, Link, Notice, QR, Spinner, XmrLogo } from "../components/ui";
import { useAction, useLoad } from "../lib/hooks";
import { ok } from "../lib/env";
import { dateTime, usd, xmr } from "../lib/format";
import { productName } from "../lib/plans";
import { useSession } from "../lib/session";

const RETRY_SEC = 90;

export default function Pay({ id }: { id: bigint }) {
  const { api, account, info, refresh, toast } = useSession();
  const { data: orders, error, reload } = useLoad(() => api.my_orders(), [api]);
  const [txid, setTxid] = useState("");
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [auto, setAuto] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const { busy, run } = useAction((m) => toast(m, "err"));
  const timer = useRef<number | null>(null);

  const order = orders?.find((o) => o.id === id) ?? null;

  const check = () =>
    run(async () => {
      const s = ok(await api.submit_payment(id, txid.trim()));
      setStatus(s);
      if (s.__kind__ === "Credited") {
        setAuto(false);
        await refresh();
        reload();
        setTxid("");
      } else {
        setAuto(true);
        setCountdown(RETRY_SEC);
      }
    });

  // While waiting for confirmations, re-check on a timer.
  useEffect(() => {
    if (!auto) return;
    timer.current = window.setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto]);
  useEffect(() => {
    if (auto && countdown <= 0 && !busy && txid) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  if (!account)
    return (
      <div className="wrap narrow">
        <Notice kind="warn">
          Sign in with the account number that created this order. <Link to="/login">Sign in</Link>
        </Notice>
      </div>
    );
  if (error) return <div className="wrap narrow"><Notice kind="err">{error}</Notice></div>;
  if (!orders) return <div className="wrap narrow"><Spinner /></div>;
  if (!order) return <div className="wrap narrow"><Notice kind="err">Order not found on this account.</Notice></div>;

  const left = order.amount - order.received;
  const uri = `monero:${order.address}?tx_amount=${xmr(left)}&tx_description=${encodeURIComponent(`Ashkey order ${order.id}`)}`;

  if (order.paid)
    return (
      <div className="wrap narrow">
        <h1 style={{ fontSize: 40 }}>Paid. Thank you.</h1>
        <Notice kind="ok">
          {productName(order, info?.tier_bytes)} for {order.years} year{order.years > 1 ? "s" : ""} is active on your account.
        </Notice>
        <div className="row">
          <Link to={order.product.__kind__ === "Heritage" ? "/heritage" : "/vault"} className="btn primary">
            Open {order.product.__kind__ === "Heritage" ? "Heritage" : "my vault"}
          </Link>
          <Link to="/account" className="btn ghost">
            Account
          </Link>
        </div>
      </div>
    );

  return (
    <div className="wrap" style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: 40 }} className="row">
        <XmrLogo size={38} /> Pay with Monero
      </h1>
      <p>
        Order #{order.id.toString()} · {productName(order, info?.tier_bytes)} · {order.years} year{order.years > 1 ? "s" : ""} · created{" "}
        {dateTime(order.created)}
      </p>

      <div className="card pay" style={{ marginBottom: 20 }}>
        <QR text={uri} size={210} />
        <div>
          <div className="muted">Send exactly</div>
          <div className="row" style={{ margin: "4px 0 14px" }}>
            <span style={{ fontSize: 30, fontWeight: 700, color: "var(--ember2)" }}>{xmr(left)} XMR</span>
            <Copy text={xmr(left)} />
          </div>
          {order.usd_cents !== undefined && (
            <p className="muted" style={{ marginTop: -6 }}>
              {usd(order.usd_cents)} at the rate locked for this order
              {order.quote_until !== undefined && ` until ${dateTime(order.quote_until)}`}. After that, the amount is recalculated at the
              current rate when you submit your payment.
            </p>
          )}
          {order.received > 0n && <Notice kind="info">Already received {xmr(order.received)} XMR. Send the rest to the same address.</Notice>}
          <div className="muted">to this subaddress (made for this order only)</div>
          <div className="addr" style={{ margin: "6px 0 10px" }}>{order.address}</div>
          <div className="row">
            <Copy text={order.address} label="Copy address" />
            <a className="btn small ghost" href={uri}>
              Open in wallet
            </a>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Then paste the transaction ID</h3>
        <p>
          In your wallet's history, open the payment and copy its <b>transaction ID</b> (64 characters). The canister fetches it
          from two independent Monero nodes and checks it with its view key. Your account is credited after{" "}
          {info?.min_confirmations ?? 10} confirmations, about {(info?.min_confirmations ?? 10) * 2} minutes.
        </p>
        <div className="row" style={{ alignItems: "stretch" }}>
          <input type="text" className="mono" style={{ flex: 1, minWidth: 260 }} placeholder="transaction ID" value={txid} onChange={(e) => setTxid(e.target.value)} />
          <button type="button" className="btn primary" disabled={busy || txid.trim().length !== 64} onClick={check}>
            {busy ? <Spinner /> : "Check payment"}
          </button>
        </div>
        {status && <StatusLine s={status} needed={info?.min_confirmations ?? 10} countdown={auto ? countdown : null} />}
        {order.txs.length > 0 && (
          <p className="muted" style={{ marginTop: 14 }}>
            Credited transactions: {order.txs.map((t) => t.slice(0, 10) + "…").join(", ")}
          </p>
        )}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        You can close this page and come back later from your <Link to="/account">account</Link>; the order keeps its address.
        Unpaid orders are removed after 30 days.
      </p>
    </div>
  );
}

function StatusLine({ s, needed, countdown }: { s: PaymentStatus; needed: number; countdown: number | null }) {
  const again = countdown !== null ? ` Checking again in ${Math.max(0, countdown)} s.` : "";
  switch (s.__kind__) {
    case "NotFound":
      return <Notice kind="warn">Not seen by the nodes yet. If you just sent it, give it a minute.{again}</Notice>;
    case "InPool":
      return <Notice kind="info">Seen in the mempool, waiting to be mined (about 2 minutes).{again}</Notice>;
    case "Waiting":
      return (
        <Notice kind="info">
          Mined in block {s.Waiting.height.toString()}. Waiting for {needed} confirmations.{again}
        </Notice>
      );
    case "Credited":
      return (
        <Notice kind="ok">
          Received {xmr(s.Credited.amount)} XMR.{" "}
          {s.Credited.order.paid ? "Order paid, your plan is active." : `Still missing ${xmr(s.Credited.order.amount - s.Credited.order.received)} XMR.`}
        </Notice>
      );
  }
}

