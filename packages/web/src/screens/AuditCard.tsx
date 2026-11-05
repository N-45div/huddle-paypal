import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote, Hint } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useResource } from "../hooks.ts";
import type { AuditView } from "../types.ts";
import { cents, money } from "../wallet.ts";

type Found = AuditView["findings"][number];

const amount = (finding: Found) => {
  const inCents = cents(finding.charge.amount);
  return inCents === null ? finding.charge.amount : money(inCents, finding.charge.currency || "USD");
};

/**
 * The auditor: PayPal's own record of the shop's charges, each checked against what your boards (or allowances)
 * signed. A charge with no signature behind it is flagged, with a dispute drafted to send PayPal.
 */
export function AuditCard() {
  const { authVersion, info } = useApp();
  const on = info?.auditor ?? false;
  const view = useResource(() => (on ? api.audit() : Promise.resolve(null)), [authVersion, on]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useChanges((change) => {
    if (on && (change.kind === "audit" || change.kind === "resync")) void view.reload();
  });

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      await api.runAudit();
      void view.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setChecking(false);
    }
  };
  const copy = async (finding: Found) => {
    try {
      await navigator.clipboard.writeText(finding.draft ?? "");
      setCopied(finding.charge.captureId);
    } catch {
      setError("This browser didn't let the page copy; select the text instead.");
    }
  };

  const findings = view.data?.findings ?? [];
  const flagged = findings.filter((finding) => finding.flagged);
  const fine = findings.filter((finding) => !finding.flagged);

  return (
    <section aria-labelledby="wallet-audit">
      <div className="wallet-payments-head">
        <h2 id="wallet-audit" className="section-title">
          Audit
        </h2>
        {on && (
          <button type="button" className="btn btn-sm" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking PayPal…" : "Check now"}
          </button>
        )}
      </div>
      {!on && <Hint>The auditor checks PayPal's own record of the shop's charges against what your boards signed. It needs the shop's PayPal app: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.</Hint>}
      {view.error && <ErrorNote message={view.error} onRetry={() => void view.reload()} />}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {on && view.data && (
        <div className={flagged.length ? "card audit-summary audit-bad" : "card audit-summary"}>
          <p className="audit-headline">
            {findings.length === 0
              ? "No charges at PayPal to check yet."
              : flagged.length === 0
                ? `All ${findings.length} of PayPal's charges were signed by your board or an allowance.`
                : `${flagged.length} of ${findings.length} charges at PayPal ${flagged.length === 1 ? "has" : "have"} no signature of yours behind ${flagged.length === 1 ? "it" : "them"}.`}
          </p>
          <p className="hint">
            {view.data.checkedAt ? (
              <>
                Checked{" "}
                <time dateTime={view.data.checkedAt} title={fullTime(view.data.checkedAt)}>
                  {ago(view.data.checkedAt)}
                </time>
                , {view.data.events ? "from PayPal's own record of every charge" : "from each order Huddle paid"}.
              </>
            ) : (
              "Not checked yet."
            )}{" "}
            {view.data.note}
          </p>
        </div>
      )}
      {flagged.length > 0 && (
        <ul className="audit-list">
          {flagged.map((finding) => (
            <li key={finding.charge.captureId} className="card audit-flag">
              <p className="audit-flag-head">
                <strong>{amount(finding)}</strong> <span className={`badge tone-failed`}>{finding.verdict === "mismatch" ? "Not what was signed" : "No signature"}</span>{" "}
                <span className="hint">{finding.charge.at.slice(0, 10)}</span>
              </p>
              <p className="note-meta">{finding.why}</p>
              {finding.draft && (
                <>
                  <p className="wallet-signed-label">A dispute to send PayPal</p>
                  <p className="audit-draft">{finding.draft}</p>
                  <button type="button" className="btn btn-sm" onClick={() => void copy(finding)}>
                    {copied === finding.charge.captureId ? "Copied" : "Copy it"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {fine.length > 0 && (
        <details className="audit-fine">
          <summary>
            {fine.length} more: {fine.some((finding) => finding.verdict === "signed" || finding.verdict === "allowed") ? "signed" : ""}
            {fine.some((finding) => finding.verdict === "signed" || finding.verdict === "allowed") && fine.some((finding) => finding.verdict !== "signed" && finding.verdict !== "allowed") ? ", or " : ""}
            {fine.some((finding) => finding.verdict !== "signed" && finding.verdict !== "allowed") ? "refunded" : ""}
          </summary>
          <ul className="note-list">
            {fine.slice(0, 20).map((finding) => (
              <li key={finding.charge.captureId} className="note-item">
                <div className="note-text">
                  <p>
                    {amount(finding)}{" "}
                    {finding.verdict === "signed" || finding.verdict === "allowed" ? (
                      <span className="badge tone-ok">{finding.verdict === "allowed" ? "Allowance" : "Signed"}</span>
                    ) : (
                      <span className="badge">No signature, money back</span>
                    )}
                    {finding.charge.status !== "COMPLETED" && (finding.verdict === "signed" || finding.verdict === "allowed") && <span className="badge">{finding.charge.status.toLowerCase()}</span>}
                  </p>
                  <p className="note-meta">
                    {finding.why} <code>{finding.charge.captureId}</code>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
