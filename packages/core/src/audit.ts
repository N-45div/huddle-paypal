import { type Allowance, amountText, parseSignable, type Payment, signedBy } from "./countersign.ts";
import { cents, type PayPalEvent } from "./paypal.ts";
import type { SignRequest, Store } from "./store.ts";

/**
 * The auditor: PayPal's own record of the shop's charges, checked against what your boards signed. Every charge
 * should be a payment a board of yours signed, for exactly that amount, or one Huddle signed under an allowance a
 * board signed. One that isn't is flagged, with why, so a dispute can be drafted. PayPal's record comes from the
 * events it makes for the app's webhooks (every capture, however it was made) and from looking up each order
 * Huddle knows of.
 */

/** A charge as PayPal has it: the capture, its order, the invoice id it was made with, the amount and its state. */
export interface PayPalCharge {
  readonly captureId: string;
  readonly orderId: string | null;
  /** The shop sends each payment's own id (pay_…) as PayPal's invoice id. */
  readonly invoiceId: string | null;
  readonly amount: string;
  readonly currency: string;
  /** COMPLETED, PENDING, REFUNDED, REVERSED, DENIED or DECLINED. */
  readonly status: string;
  readonly at: string;
}

/** signed: a board of yours signed it. allowed: Huddle signed it under an allowance a board signed. unsigned and mismatch are flagged. */
export type Verdict = "signed" | "allowed" | "unsigned" | "mismatch";

export interface Finding {
  readonly charge: PayPalCharge;
  readonly verdict: Verdict;
  /** In a sentence: what checks out, or what doesn't. */
  readonly why: string;
  /** The payment it matches, by id, when there is one. */
  readonly signId: string | null;
}

const CAPTURE_STATES: Readonly<Record<string, string>> = {
  "PAYMENT.CAPTURE.COMPLETED": "COMPLETED",
  "PAYMENT.CAPTURE.PENDING": "PENDING",
  "PAYMENT.CAPTURE.DENIED": "DENIED",
  "PAYMENT.CAPTURE.DECLINED": "DECLINED",
  "PAYMENT.CAPTURE.REVERSED": "REVERSED",
};

/**
 * The charges in PayPal's events, each in its latest state. A capture event carries the capture itself; a refund
 * event carries the refund, which names its capture in its links, so the capture shows as refunded.
 */
export function chargesFromEvents(events: readonly PayPalEvent[]): PayPalCharge[] {
  const byCapture = new Map<string, PayPalCharge>();
  const refunded = new Set<string>();
  const oldestFirst = [...events].sort((a, b) => a.at.localeCompare(b.at));
  for (const event of oldestFirst) {
    const resource = event.resource as {
      id?: unknown;
      status?: unknown;
      invoice_id?: unknown;
      amount?: { value?: unknown; currency_code?: unknown };
      create_time?: unknown;
      supplementary_data?: { related_ids?: { order_id?: unknown } };
      links?: { rel?: unknown; href?: unknown }[];
    };
    if (event.type === "PAYMENT.CAPTURE.REFUNDED") {
      const up = resource.links?.find((link) => link.rel === "up")?.href;
      const capture = typeof up === "string" ? /\/captures\/([^/?]+)/.exec(up)?.[1] : undefined;
      if (capture) refunded.add(capture);
      continue;
    }
    const state = CAPTURE_STATES[event.type];
    if (!state || typeof resource.id !== "string") continue;
    const orderId = resource.supplementary_data?.related_ids?.order_id;
    byCapture.set(resource.id, {
      captureId: resource.id,
      orderId: typeof orderId === "string" ? orderId : null,
      invoiceId: typeof resource.invoice_id === "string" ? resource.invoice_id : null,
      amount: String(resource.amount?.value ?? ""),
      currency: String(resource.amount?.currency_code ?? ""),
      status: state,
      at: String(resource.create_time ?? event.at),
    });
  }
  return [...byCapture.values()].map((charge) => (refunded.has(charge.captureId) ? { ...charge, status: "REFUNDED" } : charge));
}

/** A board's signature that checks out: of exactly this text, by this key. */
function checks(request: SignRequest): boolean {
  return Boolean(request.signature && request.key && signedBy(request.text, request.signature, request.key));
}

/** One charge, checked against what your boards (and allowances) signed. */
export function auditCharge(store: Store, charge: PayPalCharge): Finding {
  const money = (value: string, currency: string) => amountText(value, currency || "USD");
  const took = `PayPal took ${money(charge.amount, charge.currency)} (capture ${charge.captureId})`;
  const request = charge.invoiceId ? store.signRequest(charge.invoiceId) : null;
  if (!request || request.kind !== "buy") return { charge, verdict: "unsigned", why: `${took}, but no board of yours signed a payment${charge.invoiceId ? ` by the id it was charged with (${charge.invoiceId})` : ""}.`, signId: null };
  if (!request.signature || !request.key) return { charge, verdict: "unsigned", why: `${took} for a payment no board signed: it was ${request.status === "declined" ? "declined" : request.status === "expired" ? "left to expire" : "never signed"}.`, signId: request.id };
  if (!checks(request)) return { charge, verdict: "unsigned", why: `${took}, but the signature Huddle holds for that payment doesn't check out.`, signId: request.id };
  const payment = parseSignable(request.text) as Payment;
  if (cents(charge.amount) !== cents(payment.total) || charge.currency !== payment.currency) {
    return { charge, verdict: "mismatch", why: `${took}, but what was signed was ${money(payment.total, payment.currency)}.`, signId: request.id };
  }
  if (payment.allow) {
    const given = store.signRequest(payment.allow);
    const board = (given?.result as { key?: unknown } | null)?.key;
    const allowance = given?.kind === "allow" ? (parseSignable(given.text) as Allowance) : null;
    if (!given || !allowance || !checks(given) || given.key !== board || allowance.agent !== request.key) {
      return { charge, verdict: "unsigned", why: `${took} under an allowance (${payment.allow}) that no board of yours signed for Huddle's key.`, signId: request.id };
    }
    if ((cents(payment.total) ?? 0) > (cents(allowance.each) ?? 0)) return { charge, verdict: "mismatch", why: `${took} under the ${allowance.for} allowance, more than its ${money(allowance.each, allowance.currency)} a time.`, signId: request.id };
    return { charge, verdict: "allowed", why: `Huddle paid it under your ${allowance.for} allowance, which your board signed.`, signId: request.id };
  }
  const board = store.signer(request.key);
  return { charge, verdict: "signed", why: `Signed by ${board ? `${board.name} (${board.fingerprint})` : "a board of yours"}, for exactly this amount.`, signId: request.id };
}

/** Every charge checked, newest first; a charge seen twice (in the events and by its order) counts once. */
export function audit(store: Store, charges: readonly PayPalCharge[]): Finding[] {
  const seen = new Map<string, PayPalCharge>();
  for (const charge of charges) if (!seen.has(charge.captureId) || charge.status !== "COMPLETED") seen.set(charge.captureId, charge);
  return [...seen.values()].sort((a, b) => b.at.localeCompare(a.at)).map((charge) => auditCharge(store, charge));
}

/** Whether a finding needs you: a charge no board signed, or one for a different amount than was signed. */
export function flagged(finding: Finding): boolean {
  return finding.verdict === "unsigned" || finding.verdict === "mismatch";
}
