import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { type Allowance, amountText, expired, fingerprint, parseSignable, PERIODS } from "./countersign.ts";
import { cents, decimal } from "./paypal.ts";
import type { SignRequest, Store } from "./store.ts";

/**
 * Allowances on Huddle's side. Your board signs an allowance once; after that Huddle pays for a cart that fits it
 * on its own, signing the payment with its own key (made the first time, kept in Huddle's settings). The shop
 * holds Huddle to the same limits, so a Huddle that's been broken into can spend no more than you allowed, and
 * only until the allowance ends or you stop it.
 */

/** Huddle's own signing key: its public half (raw P-256, base64url) goes in each allowance it's given. */
export interface AgentKey {
  readonly key: string;
  readonly fingerprint: string;
  /** Huddle's signature of exactly this text: ECDSA P-256 over SHA-256, r‖s, base64url, as a board signs. */
  sign(text: string): string;
}

const AGENT_KEY = "allowance.agent-key";

export function agentKey(store: Store): AgentKey {
  const pem = store.settingOr(AGENT_KEY, () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  const privateKey = createPrivateKey(pem);
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, fingerprint: fingerprint(key), sign: (text) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

/** An allowance your board signed and the shop took, with what's been paid under it in its current day, week or month. */
export interface ActiveAllowance {
  readonly request: SignRequest;
  readonly allowance: Allowance;
  /** In cents. */
  readonly spent: number;
}

/** Payments under an allowance since a time, in cents: paid, or signed and still with the shop. */
export function spentUnder(store: Store, allowanceId: string, since: number): number {
  return store
    .signRequests(500, "buy")
    .filter((request) => (request.status === "paid" || request.status === "signed") && Date.parse(request.signedAt ?? request.createdAt) >= since)
    .reduce((sum, request) => {
      try {
        const payment = parseSignable(request.text);
        return payment.kind === "buy" && payment.allow === allowanceId ? sum + (cents(payment.total) ?? 0) : sum;
      } catch {
        return sum;
      }
    }, 0);
}

/** Your allowances the shops took and you haven't stopped, newest first, each with what's been spent in its window. */
export function activeAllowances(store: Store, now = Date.now()): ActiveAllowance[] {
  return store.signRequests(200, "allow").flatMap((request) => {
    if (request.status !== "active") return [];
    const allowance = parseSignable(request.text) as Allowance;
    if (expired(allowance, now)) return [];
    return [{ request, allowance, spent: spentUnder(store, allowance.id, now - PERIODS[allowance.per]) }];
  });
}

/**
 * The allowance a cart at this shop fits, if one does: the shop's own, in its currency, with the total no more
 * than its each, and no more than what's left of its total. The one with the most left goes first.
 */
export function allowanceFor(store: Store, shopUrl: string, total: string, currency: string, now = Date.now()): ActiveAllowance | null {
  const amount = cents(total);
  if (amount === null) return null;
  const fits = activeAllowances(store, now).filter(({ request, allowance, spent }) => request.shop === shopUrl && allowance.currency === currency && amount <= (cents(allowance.each) ?? 0) && spent + amount <= (cents(allowance.total) ?? 0));
  return fits.sort((a, b) => (cents(b.allowance.total) ?? 0) - b.spent - ((cents(a.allowance.total) ?? 0) - a.spent))[0] ?? null;
}

/** "$12.00 of $50.00 this week", for the log and the Wallet. */
export function allowanceUse(active: ActiveAllowance): string {
  return `${amountText(decimal(active.spent), active.allowance.currency)} of ${amountText(active.allowance.total, active.allowance.currency)} this ${active.allowance.per}`;
}
