import { SUPPORT_CHAT, SUPPORT_ISSUES } from "../lib/links";

/** Where to get help, and what never to share. */
export default function Support({ context }: { context?: "payment" }) {
  return (
    <p className="muted" style={{ marginTop: 14 }}>
      Need help?{" "}
      {SUPPORT_CHAT && (
        <>
          <a href={SUPPORT_CHAT} target="_blank" rel="noopener noreferrer">
            Ask on OpenChat
          </a>{" "}
          or{" "}
        </>
      )}
      <a href={SUPPORT_ISSUES} target="_blank" rel="noopener noreferrer">
        open a GitHub issue
      </a>
      .{context === "payment" ? " Give your order reference and the transaction ID." : ""} Never share your account number: nobody
      from Ashkey will ever ask for it.
    </p>
  );
}
