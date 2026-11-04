import { fullTime } from "../format.ts";

interface Line {
  readonly name: string;
  readonly qty: number;
  readonly price: string;
}

interface Shown {
  readonly shop: { readonly id: string; readonly name: string };
  readonly items: readonly Line[];
  readonly total: string;
  readonly currency: string;
  readonly expires: string;
}

interface Linking {
  readonly shop: { readonly id: string; readonly name: string };
  readonly expires: string;
}

/** An allowance: Huddle may pay at this shop on its own, up to `each` a time and `total` a `per`, until it expires. */
interface Allowing {
  readonly shop: { readonly id: string; readonly name: string };
  readonly for: string;
  readonly each: string;
  readonly total: string;
  readonly per: string;
  readonly currency: string;
  readonly expires: string;
}

/** What a text a board signs says: a payment ({"kind":"buy", ...}) or linking at a shop ({"kind":"link", ...}); null for anything else. */
export function signableIn(text: string): ({ readonly kind: "buy" } & Shown) | ({ readonly kind: "link" } & Linking) | ({ readonly kind: "allow" } & Allowing) | null {
  try {
    const value = JSON.parse(text) as Partial<Shown> & Partial<Allowing> & { readonly kind?: unknown };
    if (!value.shop || typeof value.shop.name !== "string" || typeof value.shop.id !== "string" || typeof value.expires !== "string") return null;
    if (value.kind === "link") return { kind: "link", shop: value.shop, expires: value.expires };
    if (value.kind === "allow") {
      if (typeof value.for !== "string" || typeof value.each !== "string" || typeof value.total !== "string" || typeof value.per !== "string" || typeof value.currency !== "string") return null;
      return { kind: "allow", shop: value.shop, for: value.for, each: value.each, total: value.total, per: value.per, currency: value.currency, expires: value.expires };
    }
    if (value.kind !== "buy" || !Array.isArray(value.items) || typeof value.total !== "string" || typeof value.currency !== "string") return null;
    return value as { readonly kind: "buy" } & Shown;
  } catch {
    return null;
  }
}

/** The payment in a text a board signs, when it is one; null for anything else. */
function paymentIn(text: string): Shown | null {
  const signable = signableIn(text);
  return signable?.kind === "buy" ? signable : null;
}

export const money = (value: string, currency: string) => (currency === "USD" ? `$${value}` : `${value} ${currency}`);

/**
 * A payment waiting for your board, as the board will show it: the shop (its name and its own address), each
 * line, the total, and until when the signature can be given. Read from the very text the board signs.
 */
export function PaymentSummary({ text }: { readonly text: string }) {
  const payment = paymentIn(text);
  if (!payment) return null;
  return (
    <div className="payment">
      <p className="payment-shop">
        <strong>{payment.shop.name}</strong> <span className="hint">{payment.shop.id}</span>
      </p>
      <table className="payment-lines">
        <tbody>
          {payment.items.map((item, index) => (
            <tr key={index}>
              <td className="num">{item.qty}×</td>
              <td>{item.name}</td>
              <td className="num">{money(item.price, payment.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>Total</td>
            <td className="num">{money(payment.total, payment.currency)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="hint">
        Your board shows these same lines. It can sign until <time dateTime={payment.expires}>{fullTime(payment.expires)}</time>; after that the run asks again.
      </p>
    </div>
  );
}
