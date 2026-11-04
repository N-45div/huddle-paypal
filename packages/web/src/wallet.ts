import type { SignView } from "./types.ts";

/**
 * The Wallet's sums and words, from what your boards signed (GET /api/signs). Amounts are added in cents, the
 * way the shop and PayPal count them, never as floating point.
 */

export interface PaymentLine {
  readonly name: string;
  readonly qty: number;
  readonly price: string;
}

/** What the shop answered, once it took a payment: its order, and PayPal's ids for it. */
export interface PaidOrder {
  readonly id: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly paypal: { readonly orderId: string | null; readonly captureId: string | null };
  readonly error: string | null;
}

export interface WalletPayment {
  readonly id: string;
  readonly shop: { readonly id: string; readonly name: string };
  readonly items: readonly PaymentLine[];
  readonly total: string;
  readonly currency: string;
  readonly status: SignView["status"];
  readonly order: PaidOrder | null;
  /** The allowance it was paid under, when Huddle paid it on its own; null when a board signed it. */
  readonly allow: string | null;
  readonly sign: SignView;
}

/** A payment from what a board was asked to sign; null when its text isn't one. */
export function paymentOf(sign: SignView): WalletPayment | null {
  if (sign.kind !== "buy") return null;
  let value: { shop?: { id?: unknown; name?: unknown }; items?: unknown; total?: unknown; currency?: unknown; allow?: unknown };
  try {
    value = JSON.parse(sign.text) as typeof value;
  } catch {
    return null;
  }
  if (typeof value.shop?.id !== "string" || typeof value.shop.name !== "string" || !Array.isArray(value.items) || typeof value.total !== "string" || typeof value.currency !== "string") return null;
  const result = sign.result as Partial<PaidOrder> | null;
  const order = result && typeof result.id === "string" && typeof result.status === "string" ? (result as PaidOrder) : null;
  return { id: sign.id, shop: { id: value.shop.id, name: value.shop.name }, items: value.items as PaymentLine[], total: value.total, currency: value.currency, status: sign.status, order, allow: typeof value.allow === "string" ? value.allow : null, sign };
}

/** "12.50" as 1250; null when it isn't an amount. */
export function cents(amount: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(amount);
  return match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : null;
}

/** An amount the way a person reads it: "$12.50", or "12.50 EUR". */
export function money(cents: number, currency: string): string {
  const value = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  return currency === "USD" ? `$${value}` : `${value} ${currency}`;
}

/** Whether PayPal took it: paid, or still reviewing it (pending), and not refunded or reversed since. */
export function wentThrough(payment: WalletPayment): boolean {
  return payment.status === "paid" && (payment.order?.status === "paid" || payment.order?.status === "pending");
}

/** What was paid since `since`, per currency ("$41.00", or "$41.00 + 12.00 EUR"); "$0.00" when nothing was. */
export function spentSince(payments: readonly WalletPayment[], since: Date): string {
  const totals = new Map<string, number>();
  for (const payment of payments) {
    if (!wentThrough(payment) || Date.parse(payment.sign.signedAt ?? payment.sign.createdAt) < since.getTime()) continue;
    totals.set(payment.currency, (totals.get(payment.currency) ?? 0) + (cents(payment.total) ?? 0));
  }
  if (totals.size === 0) return money(0, "USD");
  return [...totals].map(([currency, sum]) => money(sum, currency)).join(" + ");
}

/** Monday at midnight, this week, in this browser's time. */
export function startOfWeek(now: Date): Date {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Where a payment is, in a few words, and how it's shown (a badge's tone). */
export function paymentState(payment: WalletPayment): { readonly words: string; readonly tone: "ok" | "waiting" | "failed" | "off" } {
  switch (payment.status) {
    case "waiting":
      return { words: "Waiting for your board", tone: "waiting" };
    case "signed":
      return { words: "Signed; at the shop", tone: "waiting" };
    case "paid":
      if (payment.order?.status === "pending") return { words: "PayPal is reviewing it", tone: "waiting" };
      if (payment.order?.status === "refunded") return { words: "Refunded", tone: "off" };
      if (payment.order?.status === "reversed") return { words: "Reversed", tone: "failed" };
      return { words: "Paid", tone: "ok" };
    case "declined":
      return { words: "You said no", tone: "off" };
    case "expired":
      return { words: "Expired unsigned", tone: "off" };
    default:
      return { words: "Didn't go through", tone: "failed" };
  }
}

/** "2× House blend; 1× Mug", short enough for one line. */
export function itemsLine(items: readonly PaymentLine[], room = 60): string {
  const line = items.map((item) => `${item.qty}× ${item.name}`).join("; ");
  return line.length > room ? `${line.slice(0, room - 1)}…` : line;
}

/** Each board's shops: where it's linked, with the PayPal saved there, from the latest link per shop. */
export function linkedShops(links: readonly SignView[]): Map<string, { readonly shop: string; readonly paypal: string | null }[]> {
  const byBoard = new Map<string, { shop: string; paypal: string | null }[]>();
  for (const link of links) {
    if (link.kind !== "link" || link.status !== "linked") continue;
    const result = (link.result ?? {}) as { key?: unknown; paypal?: unknown };
    if (typeof result.key !== "string") continue;
    let shop = link.shop;
    try {
      const name = (JSON.parse(link.text) as { shop?: { name?: unknown } }).shop?.name;
      if (typeof name === "string") shop = name;
    } catch {
      // The shop's address, then.
    }
    const shops = byBoard.get(result.key) ?? [];
    if (!shops.some((one) => one.shop === shop)) shops.push({ shop, paypal: typeof result.paypal === "string" ? result.paypal : null });
    byBoard.set(result.key, shops);
  }
  return byBoard;
}
