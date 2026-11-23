import { useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={`#${to}`} className={className}>
      {children}
    </a>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small ghost"
      onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

export function QR({ text, size = 200 }: { text: string; size?: number }) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
  return (
    <svg className="qr" width={size} height={size} viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="QR code">
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="#fff" />
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress" aria-label={label}>
      <div style={{ width: `${Math.round(value * 100)}%` }} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "err" | "ok"; children: ReactNode }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}


/** The Monero symbol (© The Monero Project, CC BY-SA 4.0), used to show XMR is accepted. */
export function XmrLogo({ size = 18 }: { size?: number }) {
  return <img src="/monero.png" alt="Monero" width={size} height={size} className="xmr-logo" />;
}
