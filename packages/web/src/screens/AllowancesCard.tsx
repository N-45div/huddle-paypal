import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote, Hint, Link } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useResource } from "../hooks.ts";
import { href } from "../router.ts";
import type { AllowanceView } from "../types.ts";
import { cents, money } from "../wallet.ts";

const amount = (value: string, currency: string) => {
  const inCents = cents(value);
  return inCents === null ? value : money(inCents, currency);
};

/** Where an allowance is, in a few words, and its badge's tone. */
function allowanceState(allowance: AllowanceView): { readonly words: string; readonly tone: "ok" | "waiting" | "failed" | "off" } {
  if (allowance.status === "active") return { words: "Active", tone: "ok" };
  if (allowance.status === "waiting") return { words: "Waiting for your board", tone: "waiting" };
  if (allowance.status === "signed") return { words: "Signed; at the shop", tone: "waiting" };
  if (allowance.status === "stopped") return { words: "Stopped", tone: "off" };
  if (allowance.status === "expired") return { words: "Ended", tone: "off" };
  if (allowance.status === "declined") return { words: "You said no", tone: "off" };
  return { words: "Didn't go through", tone: "failed" };
}

/**
 * Allowances: say what Huddle may spend on its own ("groceries up to $20 each, $50 a week"), your board shows the
 * exact limits and signs them, and from then on carts that fit are paid without asking. Each shows what's gone out
 * under it this day, week or month, and stops with one tap.
 */
export function AllowancesCard() {
  const { authVersion, info } = useApp();
  const allowances = useResource(() => api.allowances(), [authVersion]);
  const [said, setSaid] = useState("");
  const [exact, setExact] = useState({ for: "Groceries", each: "20.00", total: "50.00", per: "week" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChanges((change) => {
    if (change.kind === "sign" || change.kind === "resync") void allowances.reload();
  });

  const words = info?.allowanceWords ?? false;
  const set = async () => {
    setBusy("set");
    setError(null);
    try {
      await api.setAllowance(words && said.trim() ? { said: said.trim() } : { ...exact, days: 30 });
      setSaid("");
      void allowances.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };
  const stop = async (allowance: AllowanceView) => {
    setBusy(allowance.id);
    setError(null);
    try {
      await api.stopAllowance(allowance.id);
      void allowances.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="wallet-allowances">
      <h2 id="wallet-allowances" className="section-title">
        Allowances
      </h2>
      <Hint>Your board signs an allowance once; after that, Huddle pays for carts that fit it without asking, and anything bigger still comes to your board. The shop holds Huddle to the same limits.</Hint>
      <form
        className="card add-device"
        onSubmit={(event) => {
          event.preventDefault();
          void set();
        }}
      >
        {words ? (
          <div className="field field-grow">
            <label htmlFor="allowance-said">Say what Huddle may spend</label>
            <input id="allowance-said" value={said} placeholder="Groceries up to $20 each, $50 a week" autoComplete="off" onChange={(event) => setSaid(event.target.value)} />
          </div>
        ) : (
          <div className="allowance-fields">
            <div className="field">
              <label htmlFor="allowance-for">For</label>
              <input id="allowance-for" value={exact.for} onChange={(event) => setExact({ ...exact, for: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="allowance-each">A time, at most</label>
              <input id="allowance-each" inputMode="decimal" value={exact.each} onChange={(event) => setExact({ ...exact, each: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="allowance-total">In all, at most</label>
              <input id="allowance-total" inputMode="decimal" value={exact.total} onChange={(event) => setExact({ ...exact, total: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="allowance-per">Per</label>
              <select id="allowance-per" value={exact.per} onChange={(event) => setExact({ ...exact, per: event.target.value })}>
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
            </div>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy === "set" || (words && !said.trim())}>
          {busy === "set" ? "Writing it…" : "Send to my board"}
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
      {allowances.error && <ErrorNote message={allowances.error} onRetry={() => void allowances.reload()} />}
      {allowances.data && allowances.data.length > 0 && (
        <ul className="note-list">
          {allowances.data.slice(0, 8).map((allowance) => {
            const state = allowanceState(allowance);
            const spent = allowance.spent === null ? null : (cents(allowance.spent) ?? 0) / Math.max(cents(allowance.total) ?? 1, 1);
            return (
              <li key={allowance.id} className="note-item allowance-item">
                <div className="note-text">
                  <p>
                    {allowance.for} at {allowance.shop.name} <span className={`badge tone-${state.tone}`}>{state.words}</span>
                  </p>
                  <p className="note-meta">
                    Up to {amount(allowance.each, allowance.currency)} a time and {amount(allowance.total, allowance.currency)} a {allowance.per}, until{" "}
                    <time dateTime={allowance.expires} title={fullTime(allowance.expires)}>
                      {allowance.expires.slice(0, 10)}
                    </time>
                  </p>
                  {allowance.status === "active" && allowance.spent !== null && (
                    <>
                      <div className="allowance-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((spent ?? 0) * 100)} aria-label="Spent this period">
                        <span style={{ width: `${Math.min(100, Math.round((spent ?? 0) * 100))}%` }} />
                      </div>
                      <p className="note-meta">
                        {amount(allowance.spent, allowance.currency)} of {amount(allowance.total, allowance.currency)} this {allowance.per}
                      </p>
                    </>
                  )}
                  {allowance.status === "waiting" && (
                    <p className="note-meta">
                      Sign it on your board, or the virtual one in <Link to={href.devices()}>Devices</Link>. {ago(allowance.createdAt)}
                    </p>
                  )}
                  {allowance.error && <p className="note-meta danger-text">{allowance.error}</p>}
                </div>
                {(allowance.status === "active" || allowance.status === "waiting") && (
                  <div className="note-actions">
                    <button type="button" className="btn btn-sm btn-ghost danger-text" disabled={busy === allowance.id} onClick={() => void stop(allowance)}>
                      {busy === allowance.id ? "Stopping…" : "Stop"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
