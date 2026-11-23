export default function Terms() {
  return (
    <div className="wrap narrow">
      <h1 style={{ fontSize: 40 }}>Terms</h1>
      <p>Short, because there is not much we can promise or see.</p>
      <div className="card" style={{ display: "grid", gap: 14 }}>
        <p>
          <b>What you get.</b> Encrypted storage space and/or heritage switches for the period you paid for, provided by smart
          contracts running on the Internet Computer. No warranty: software has bugs and networks have outages. Keep your own
          copies of anything irreplaceable.
        </p>
        <p>
          <b>Your account number is your only key.</b> It is never sent to us and cannot be recovered. Losing it means losing
          access to everything on the account.
        </p>
        <p>
          <b>Payments.</b> Prices are in XMR per year. Payments are final: no refunds, and no account recovery. Send the exact
          amount to the address shown for your order; amounts sent elsewhere cannot be matched to your account.
        </p>
        <p>
          <b>Expiry.</b> Vault files are deleted automatically a few days after the paid period ends. Unrenewed heritage switches
          release to their heirs after a grace period, and released switches are deleted 180 days later.
        </p>
        <p>
          <b>Your responsibility.</b> You may not use Ashkey to store or share anything illegal where you live or under the laws
          that apply to the service. We cannot see your content, but that does not make illegal use legal.
        </p>
        <p>
          <b>Changes.</b> The code is open source. While the canisters still have a controller, the service may be updated; the
          trust page shows the live code hash and controllers at any time.
        </p>
      </div>
    </div>
  );
}
