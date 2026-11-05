import { useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../app-context.ts";
import { Empty, ErrorNote, Hint, Link, Loading } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useResource } from "../hooks.ts";
import { href } from "../router.ts";
import { AllowancesCard } from "./AllowancesCard.tsx";
import { AuditCard } from "./AuditCard.tsx";
import { cents, itemsLine, linkedShops, money, paymentOf, paymentState, spentSince, startOfMonth, startOfWeek, type WalletPayment } from "../wallet.ts";

type Filter = "all" | "paid" | "open" | "not";
const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "open", label: "Waiting" },
  { id: "not", label: "Not paid" },
];

function fits(payment: WalletPayment, filter: Filter): boolean {
  const tone = paymentState(payment).tone;
  if (filter === "paid") return tone === "ok";
  if (filter === "open") return tone === "waiting";
  if (filter === "not") return tone === "failed" || tone === "off";
  return true;
}

/**
 * Your wallet: every payment your boards were asked to sign and what PayPal did with it, what's gone out this
 * week and month, and where each board is linked. Nothing here was paid without a board's signature, and each
 * payment shows the exact text its board signed.
 */
export function WalletScreen() {
  const { authVersion } = useApp();
  const signs = useResource(() => api.payments(), [authVersion]);
  const links = useResource(() => api.links(), [authVersion]);
  const boards = useResource(() => api.signers(), [authVersion]);
  const [filter, setFilter] = useState<Filter>("all");

  useChanges((change) => {
    if (change.kind === "sign" || change.kind === "resync") {
      void signs.reload();
      void links.reload();
      void boards.reload();
    }
  });

  const payments = (signs.data ?? []).flatMap((sign) => paymentOf(sign) ?? []);
  const now = new Date();
  const waiting = payments.filter((payment) => payment.status === "waiting").length;
  const shops = linkedShops(links.data ?? []);
  const linkedBoards = (boards.data ?? []).filter((board) => shops.has(board.key)).length;
  const shown = payments.filter((payment) => fits(payment, filter));

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Wallet</h1>
          <p className="lede">Every payment your boards were asked to sign, and what PayPal did with it. A shop charges your PayPal only for a cart one of your boards signed.</p>
        </div>
      </header>

      <section className="wallet-stats" aria-label="At a glance">
        <div className="wallet-stat">
          <p className="wallet-stat-label">This week</p>
          <p className="wallet-stat-value">{spentSince(payments, startOfWeek(now))}</p>
        </div>
        <div className="wallet-stat">
          <p className="wallet-stat-label">This month</p>
          <p className="wallet-stat-value">{spentSince(payments, startOfMonth(now))}</p>
        </div>
        <div className="wallet-stat">
          <p className="wallet-stat-label">Waiting for a board</p>
          <p className="wallet-stat-value">{waiting}</p>
          {waiting > 0 && (
            <Link to={href.devices()} className="wallet-stat-link">
              Sign in Devices
            </Link>
          )}
        </div>
        <div className="wallet-stat">
          <p className="wallet-stat-label">Boards linked</p>
          <p className="wallet-stat-value">
            {linkedBoards} <span className="wallet-stat-of">of {boards.data?.length ?? 0}</span>
          </p>
        </div>
      </section>

      <section aria-labelledby="wallet-boards">
        <h2 id="wallet-boards" className="section-title">
          Your boards
        </h2>
        {boards.error && <ErrorNote message={boards.error} onRetry={() => void boards.reload()} />}
        {boards.data && boards.data.length === 0 && (
          <Empty title="No boards yet.">
            <p className="hint">
              Open <Link to={href.devices()}>Devices</Link>: the virtual button there is a board as soon as it connects, and the Huddle button is one once it says its key.
            </p>
          </Empty>
        )}
        {boards.data && boards.data.length > 0 && (
          <ul className="note-list">
            {boards.data.map((board) => {
              const linked = shops.get(board.key) ?? [];
              return (
                <li key={board.key} className="note-item">
                  <div className="note-text">
                    <p>
                      {board.name} <code className="wallet-print">{board.fingerprint}</code>
                    </p>
                    <p className="note-meta">
                      {linked.length > 0 ? <>Linked at {linked.map((one) => `${one.shop}${one.paypal ? ` (${one.paypal})` : ""}`).join(", ")}</> : "Not linked at a shop yet, so it can't pay anywhere."}
                    </p>
                  </div>
                  <div className="note-actions">
                    <Link to={href.devices()} className="btn btn-sm">
                      {linked.length > 0 ? "Link another shop" : "Link at a shop"}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AllowancesCard />

      <AuditCard />

      <section aria-labelledby="wallet-payments">
        <div className="wallet-payments-head">
          <h2 id="wallet-payments" className="section-title">
            Payments
          </h2>
          <div className="segmented" role="group" aria-label="Show">
            {FILTERS.map((one) => (
              <button key={one.id} type="button" className={filter === one.id ? "segment active" : "segment"} aria-pressed={filter === one.id} onClick={() => setFilter(one.id)}>
                {one.label}
              </button>
            ))}
          </div>
        </div>
        {signs.error && <ErrorNote message={signs.error} onRetry={() => void signs.reload()} />}
        {signs.loading && !signs.data && <Loading label="Loading payments…" />}
        {signs.data && payments.length === 0 && (
          <Empty title="No payments yet.">
            <p className="hint">A flow's Pay step asks your board to sign a cart; try the Coffee run example.</p>
          </Empty>
        )}
        {payments.length > 0 && shown.length === 0 && <p className="hint">None of these.</p>}
        {shown.length > 0 && (
          <ul className="wallet-list">
            {shown.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </ul>
        )}
        <Hint>Each payment keeps the exact text its board signed and the signature, so anyone with the board's key can check it was signed, and what for.</Hint>
      </section>
    </div>
  );
}

function PaymentRow({ payment }: { readonly payment: WalletPayment }) {
  const state = paymentState(payment);
  const total = cents(payment.total);
  const when = payment.sign.signedAt ?? payment.sign.createdAt;
  return (
    <li className="wallet-item">
      <details>
        <summary>
          <span className="wallet-item-main">
            <span className="row-title">{payment.shop.name}</span>
            <span className="row-sub wallet-item-sub">{itemsLine(payment.items)}</span>
          </span>
          <span className="wallet-item-side">
            <span className="wallet-amount">{total === null ? payment.total : money(total, payment.currency)}</span>
            <span className={`badge tone-${state.tone}`}>{state.words}</span>
            <time className="wallet-when" dateTime={when} title={fullTime(when)}>
              {ago(when)}
            </time>
          </span>
        </summary>
        <div className="wallet-detail">
          <table className="payment-lines">
            <tbody>
              {payment.items.map((item, index) => (
                <tr key={index}>
                  <td className="num">{item.qty}×</td>
                  <td>{item.name}</td>
                  <td className="num">{cents(item.price) === null ? item.price : money(cents(item.price)!, payment.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="wallet-facts">
            <dt>Shop</dt>
            <dd>
              {payment.shop.name} <span className="hint">{payment.shop.id}</span>
            </dd>
            <dt>Signed by</dt>
            <dd>{payment.allow ? <>Huddle, under your allowance (your board signed that once)</> : payment.sign.board ? <code>{payment.sign.board}</code> : "No board yet"}</dd>
            {payment.order?.paypal.orderId && (
              <>
                <dt>PayPal order</dt>
                <dd>
                  <code>{payment.order.paypal.orderId}</code>
                </dd>
              </>
            )}
            {payment.order?.paypal.captureId && (
              <>
                <dt>PayPal capture</dt>
                <dd>
                  <code>{payment.order.paypal.captureId}</code>
                </dd>
              </>
            )}
            {payment.order && (
              <>
                <dt>Shop's order</dt>
                <dd>
                  <code>{payment.order.id}</code>
                </dd>
              </>
            )}
            {payment.sign.runId && (
              <>
                <dt>Run</dt>
                <dd>
                  <Link to={href.run(payment.sign.runId)}>Open the run</Link>
                </dd>
              </>
            )}
            {(payment.sign.error ?? payment.order?.error) && (
              <>
                <dt>Why</dt>
                <dd className="danger-text">{payment.sign.error ?? payment.order?.error}</dd>
              </>
            )}
          </dl>
          <p className="wallet-signed-label">{payment.allow ? "Exactly what Huddle signed, under your allowance" : "Exactly what the board signed"}</p>
          <pre className="wallet-signed">{payment.sign.text}</pre>
          {payment.sign.signature && (
            <p className="hint wallet-signature">
              {payment.allow ? "Huddle's signature" : "Signature"} (P-256): <code>{payment.sign.signature}</code>
            </p>
          )}
        </div>
      </details>
    </li>
  );
}
