import { XmrLogo } from "./ui";
import { bytes, usd, xmr } from "../lib/format";
import type { Choice } from "../lib/plans";
import { useSession } from "../lib/session";

export default function PlanPicker({ choice, setChoice, years, setYears }: { choice: Choice; setChoice: (c: Choice) => void; years: number; setYears: (y: number) => void }) {
  const { info } = useSession();
  if (!info) return null;
  const price = (c: Choice) => (c === "h" ? info.heritage_price : info.vault_prices[Number(c[1]) - 1]);
  const dollars = (c: Choice) => (c === "h" ? info.usd_heritage_price : info.usd_vault_prices[Number(c[1]) - 1]);
  const options: { c: Choice; title: string; sub: string }[] = [
    { c: "v1", title: `Vault ${bytes(info.tier_bytes[0])}`, sub: "Encrypted storage" },
    { c: "v2", title: `Vault ${bytes(info.tier_bytes[1])}`, sub: "Encrypted storage" },
    { c: "v3", title: `Vault ${bytes(info.tier_bytes[2])}`, sub: "Encrypted storage" },
    { c: "h", title: "Heritage switch", sub: "Up to 3 switches, 10 MB, 5 heirs each" },
  ];
  return (
    <>
      <div className="opt">
        {options.map((o) => (
          <label key={o.c} className={choice === o.c ? "on" : ""}>
            <input type="radio" name="plan" checked={choice === o.c} onChange={() => setChoice(o.c)} />
            <span className="grow">
              <b>{o.title}</b>
              <br />
              <span className="muted">{o.sub}</span>
            </span>
            <span className="p">
              {usd(dollars(o.c))} / yr
              {price(o.c) > 0n && (
                <>
                  <br />
                  <small className="muted">≈ {xmr(price(o.c))} XMR</small>
                </>
              )}
            </span>
          </label>
        ))}
      </div>
      <div className="row between" style={{ margin: "18px 0" }}>
        <div className="seg" role="group" aria-label="Years">
          {[1, 2, 3].map((y) => (
            <button key={y} type="button" className={years === y ? "on" : ""} onClick={() => setYears(y)}>
              {y} year{y > 1 ? "s" : ""}
            </button>
          ))}
        </div>
        <div>
          Total: <b style={{ color: "var(--ember2)" }}>{usd(dollars(choice) * BigInt(years))}</b>
          {price(choice) > 0n && (
            <span className="muted">
              {" "}
              ≈ <XmrLogo size={14} /> {xmr(price(choice) * BigInt(years))} XMR at today's rate
            </span>
          )}
        </div>
      </div>
    </>
  );
}

