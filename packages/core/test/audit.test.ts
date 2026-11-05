import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { audit, auditCharge, chargesFromEvents, flagged, type PayPalCharge } from "../src/audit.ts";
import { type Allowance, type Payment, signableText } from "../src/countersign.ts";
import { Store } from "../src/store.ts";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

const SHOP = { id: "localhost:7700", name: "Bean & Leaf" };
const payment = (id: string, total: string, allow?: string): Payment => ({ v: 1, kind: "buy", id, ...(allow ? { allow } : {}), shop: SHOP, cart: "cart_1", items: [{ name: "Swiss water decaf beans, 12 oz", qty: 1, price: total }], total, currency: "USD", expires: "2026-11-06T10:10:00Z" });
const charge = (invoiceId: string | null, amount = "14.00", captureId = "3C679366HH908993F"): PayPalCharge => ({ captureId, orderId: "5O190127TN364715T", invoiceId, amount, currency: "USD", status: "COMPLETED", at: "2026-11-06T10:01:00Z" });

/** A payment a board signed and the shop was paid for, as Huddle keeps it. */
function signedPayment(store: Store, signer: { key: string; sign: (text: string) => string }, paid: Payment) {
  const text = signableText(paid);
  store.addSignRequest({ id: paid.id, kind: "buy", text, runId: null, stepId: null, shop: "http://localhost:7700/shop", expires: paid.expires });
  store.markSigned(paid.id, signer.sign(text), signer.key);
  store.moveSignRequest(paid.id, "signed", { status: "paid" });
}

describe("the auditor", () => {
  it("passes a charge your board signed, for exactly that amount", () => {
    const store = new Store();
    const board = keyPair();
    store.addSigner({ key: board.key, name: "Desk button" });
    signedPayment(store, board, payment("pay_000000000001", "14.00"));
    const found = auditCharge(store, charge("pay_000000000001"));
    assert.equal(found.verdict, "signed");
    assert.match(found.why, /^Signed by Desk button \([0-9A-F ]{19}\), for exactly this amount\.$/);
    assert.equal(flagged(found), false);
  });

  it("flags a charge no board signed, one for another amount, and one whose signature doesn't check out", () => {
    const store = new Store();
    const board = keyPair();
    store.addSigner({ key: board.key, name: "Desk button" });
    signedPayment(store, board, payment("pay_000000000002", "14.00"));
    const rogue = auditCharge(store, charge("rogue-0001", "99.00"));
    assert.equal(rogue.verdict, "unsigned");
    assert.equal(rogue.why, "PayPal took $99.00 (capture 3C679366HH908993F), but no board of yours signed a payment by the id it was charged with (rogue-0001).");
    assert.equal(auditCharge(store, charge(null)).verdict, "unsigned");
    const more = auditCharge(store, charge("pay_000000000002", "41.00"));
    assert.equal(more.verdict, "mismatch");
    assert.match(more.why, /PayPal took \$41\.00 .*but what was signed was \$14\.00\./);
    // A payment you declined, then charged anyway.
    const declined = payment("pay_000000000003", "14.00");
    store.addSignRequest({ id: declined.id, kind: "buy", text: signableText(declined), runId: null, stepId: null, shop: "http://localhost:7700/shop", expires: declined.expires });
    store.moveSignRequest(declined.id, "waiting", { status: "declined" });
    assert.match(auditCharge(store, charge(declined.id)).why, /for a payment no board signed: it was declined\./);
    // A signature that's someone else's.
    const forged = payment("pay_000000000004", "14.00");
    store.addSignRequest({ id: forged.id, kind: "buy", text: signableText(forged), runId: null, stepId: null, shop: "http://localhost:7700/shop", expires: forged.expires });
    store.markSigned(forged.id, keyPair().sign(signableText(forged)), board.key);
    assert.match(auditCharge(store, charge(forged.id)).why, /doesn't check out/);
  });

  it("passes a charge Huddle signed under an allowance your board signed, and flags one under an allowance it didn't", () => {
    const store = new Store();
    const board = keyPair();
    const agent = keyPair();
    store.addSigner({ key: board.key, name: "Desk button" });
    const allowance: Allowance = { v: 1, kind: "allow", id: "allow_000000000001", shop: SHOP, for: "Groceries", agent: agent.key, each: "20.00", total: "50.00", per: "week", currency: "USD", expires: "2026-12-06T10:00:00Z" };
    const allowText = signableText(allowance);
    store.addSignRequest({ id: allowance.id, kind: "allow", text: allowText, runId: null, stepId: null, shop: "http://localhost:7700/shop", expires: allowance.expires, result: { key: board.key } });
    store.markSigned(allowance.id, board.sign(allowText), board.key);
    store.moveSignRequest(allowance.id, "signed", { status: "active" });
    signedPayment(store, agent, payment("pay_000000000005", "14.00", allowance.id));
    const under = auditCharge(store, charge("pay_000000000005"));
    assert.deepEqual([under.verdict, under.why], ["allowed", "Huddle paid it under your Groceries allowance, which your board signed."]);
    // Huddle's key, under an allowance that names another key: not one your board gave it.
    signedPayment(store, keyPair(), payment("pay_000000000006", "14.00", allowance.id));
    assert.equal(auditCharge(store, charge("pay_000000000006")).verdict, "unsigned");
  });

  it("reads PayPal's events: each capture in its latest state, a refund marking its capture", () => {
    const capture = (id: string, invoice: string, type = "PAYMENT.CAPTURE.COMPLETED", at = "2026-11-06T10:01:00Z") => ({
      id: `WH-${id}-${type}`,
      type,
      at,
      resource: { id, status: "COMPLETED", invoice_id: invoice, amount: { currency_code: "USD", value: "14.00" }, create_time: at, supplementary_data: { related_ids: { order_id: `ORDER-${id}` } } },
    });
    const refund = { id: "WH-R1", type: "PAYMENT.CAPTURE.REFUNDED", at: "2026-11-06T11:00:00Z", resource: { id: "REFUND1", status: "COMPLETED", amount: { currency_code: "USD", value: "14.00" }, links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP1" }] } };
    const charges = chargesFromEvents([refund, capture("CAP1", "pay_1"), capture("CAP2", "pay_2"), { id: "WH-X", type: "CHECKOUT.ORDER.APPROVED", at: "2026-11-06T10:00:00Z", resource: {} }]);
    assert.deepEqual(
      charges.map((one) => [one.captureId, one.orderId, one.invoiceId, one.status]),
      [
        ["CAP1", "ORDER-CAP1", "pay_1", "REFUNDED"],
        ["CAP2", "ORDER-CAP2", "pay_2", "COMPLETED"],
      ],
    );
    const store = new Store();
    const found = audit(store, [...charges, charges[1]!]);
    assert.equal(found.length, 2, "a charge seen twice counts once");
    assert.deepEqual(
      found.map((one) => [one.charge.captureId, one.verdict, flagged(one)]).sort(),
      [
        ["CAP1", "unsigned", false],
        ["CAP2", "unsigned", true],
      ],
      "no signature behind either, but CAP1's money was given back",
    );
  });
});
