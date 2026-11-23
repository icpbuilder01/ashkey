const PICO = 1_000_000_000_000n;

/** 30_000_000_000n → "0.03" */
export function xmr(pico: bigint): string {
  const whole = pico / PICO;
  const frac = (pico % PICO).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function bytes(n: bigint | number): string {
  const v = Number(n);
  if (v >= 1e9) return `${v % 1e9 === 0 || v >= 1e10 ? Math.round(v / 1e9) : (v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} KB`;
  return `${v} B`;
}

export function date(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function dateTime(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DAY = 86_400;

export function days(sec: bigint | number): string {
  const d = Math.round(Number(sec) / DAY);
  if (d % 365 === 0) return `${d / 365} year${d === 365 ? "" : "s"}`;
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** Time from now until `ns`, in words. */
export function until(ns: bigint): string {
  const sec = Math.floor((Number(ns / 1_000_000n) - Date.now()) / 1000);
  if (sec <= 0) return "now";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  if (sec < 2 * DAY) return `${Math.round(sec / 3600)} h`;
  return `${Math.floor(sec / DAY)} days`;
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Agent errors are long; keep the canister's own sentence when there is one.
  const r = m.match(/Reject text: (.*)/) ?? m.match(/reject message[^:]*: (.*)/i);
  return (r ? r[1] : m).split("\n")[0];
}
