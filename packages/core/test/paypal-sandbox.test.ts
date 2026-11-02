import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PayPal, PayPalError } from "../src/paypal.ts";

/**
 * The PayPal client against PayPal's sandbox itself. Needs a sandbox app (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
 * the charges need a payer's PayPal saved with that app too (PAYPAL_SANDBOX_VAULT_ID): link a board at the demo
 * shop with a sandbox Personal account, and the shop keeps it. Each charge is refunded straight after.
 */
const env = process.env;
const paypal = env.PAYPAL_ENVIRONMENT?.trim() === "live" ? null : PayPal.fromEnv(env);
const vaultId = env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const noApp = !paypal && "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox app)";
const noSaved = (noApp || (!vaultId && "set PAYPAL_SANDBOX_VAULT_ID: a payer's PayPal saved with the app")) as string | false;

describe("PayPal's sandbox", () => {
  it("gives a page for a payer to save their PayPal with the shop", { skip: noApp }, async () => {
    const started = await paypal!.startSaving({ returnUrl: "https://huddle.example/shop/links/x/back", cancelUrl: "https://huddle.example/shop/links/x/back?cancelled=1", brand: "Bean & Leaf", description: "Test: carts your board signs" });
    assert.match(started.setupTokenId, /^[A-Z0-9]{10,}$/);
    assert.match(started.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it("charges a saved PayPal for exactly its items, once per invoice id, and refunds it", { skip: noSaved }, async () => {
    const invoiceId = `pay_test_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const order = { vaultId: vaultId!, currency: "USD", invoiceId, items: [{ name: "Test: espresso", quantity: 2, unitAmount: "0.25" }, { name: "Test: biscuit", quantity: 1, unitAmount: "0.10" }], description: "Huddle's PayPal test" };
    const charged = await paypal!.charge(order);
    assert.equal(charged.status, "COMPLETED");
    assert.equal(charged.captureStatus, "COMPLETED");
    assert.deepEqual(charged.amount, { currency_code: "USD", value: "0.60" });
    assert.ok(charged.captureId);
    // The same invoice sent again (a retry after a timeout, say) is the same order, not a second charge.
    const again = await paypal!.charge(order);
    assert.equal(again.orderId, charged.orderId);
    assert.equal(again.captureId, charged.captureId);
    const refunded = await paypal!.refund(charged.captureId!, { note: "Huddle's PayPal test" });
    assert.equal(refunded.status, "COMPLETED");
  });

  it("says plainly why it can't charge a PayPal that isn't saved, without the secret", { skip: noApp }, async () => {
    const error = await paypal!
      .charge({ vaultId: "NOTAVAULTID123", currency: "USD", invoiceId: `pay_test_${randomUUID().slice(0, 8)}`, items: [{ name: "Test", quantity: 1, unitAmount: "0.10" }] })
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof PayPalError, String(error));
    assert.ok(error.status >= 400 && error.status < 500);
    assert.ok(error.debugId, "PayPal's debug id, for asking PayPal about it");
    assert.ok(!error.message.includes(env.PAYPAL_CLIENT_SECRET!));
  });
});
