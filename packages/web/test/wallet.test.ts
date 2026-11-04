import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SignView } from "../src/types.ts";
import { cents, itemsLine, linkedShops, money, paymentOf, paymentState, spentSince, startOfMonth, startOfWeek } from "../src/wallet.ts";

const SHOP = { id: "localhost:7700", name: "Bean & Leaf" };

function payment(id: string, total: string, status: SignView["status"], at: string, order: { status: string } | null = { status: "paid" }, currency = "USD"): SignView {
  return {
    id,
    kind: "buy",
    status,
    text: JSON.stringify({ v: 1, kind: "buy", id, shop: SHOP, cart: "cart_1", items: [{ name: "House blend beans, 1 lb", qty: 2, price: "12.00" }], total, currency, expires: at }),
    runId: "run_1",
    stepId: "pay",
    shop: "http://localhost:7700/shop",
    expires: at,
    board: "1A2B 3C4D 5E6F 7A8B",
    signature: null,
    result: order ? { id: `order_${id}`, status: order.status, total, currency, paypal: { orderId: "5O190127TN364715T", captureId: "3C679366HH908993F" }, error: null } : null,
    error: null,
    createdAt: at,
    signedAt: at,
  };
}

describe("the wallet's sums", () => {
  it("adds up what went through, in cents, from the start of the week or month", () => {
    const now = new Date(2026, 10, 4, 15, 0);
    const signs = [
      payment("pay_1", "24.00", "paid", new Date(2026, 10, 3, 9).toISOString()),
      payment("pay_2", "0.10", "paid", new Date(2026, 10, 4, 9).toISOString()),
      payment("pay_3", "0.20", "paid", new Date(2026, 10, 4, 10).toISOString(), { status: "pending" }),
      payment("pay_4", "9.99", "paid", new Date(2026, 10, 1, 9).toISOString(), { status: "refunded" }),
      payment("pay_5", "50.00", "failed", new Date(2026, 10, 4, 11).toISOString(), null),
      payment("pay_6", "7.00", "paid", new Date(2026, 9, 30, 9).toISOString()),
      payment("pay_7", "5.00", "paid", new Date(2026, 10, 2, 9).toISOString(), { status: "paid" }, "EUR"),
    ].map((sign) => paymentOf(sign)!);
    assert.equal(spentSince(signs, startOfWeek(now)), "$24.30 + 5.00 EUR", "0.10 + 0.20 is 0.30 exactly; a refund and a failure count for nothing");
    assert.equal(spentSince(signs, startOfMonth(now)), "$24.30 + 5.00 EUR");
    assert.equal(spentSince(signs, new Date(2026, 9, 1)), "$31.30 + 5.00 EUR");
    assert.equal(spentSince([], startOfWeek(now)), "$0.00");
  });

  it("starts the week on Monday", () => {
    assert.deepEqual(startOfWeek(new Date(2026, 10, 4, 15)), new Date(2026, 10, 2));
    assert.deepEqual(startOfWeek(new Date(2026, 10, 1, 8)), new Date(2026, 9, 26), "a Sunday belongs to the week before");
    assert.deepEqual(startOfWeek(new Date(2026, 10, 2, 0, 0)), new Date(2026, 10, 2));
  });

  it("reads amounts the way the shop writes them", () => {
    assert.equal(cents("12.5"), 1250);
    assert.equal(cents("0.07"), 7);
    assert.equal(cents("12"), 1200);
    assert.equal(cents("1e3"), null);
    assert.equal(money(2430, "USD"), "$24.30");
    assert.equal(money(5, "EUR"), "0.05 EUR");
  });
});

describe("the wallet's words", () => {
  it("says where each payment is", () => {
    const at = "2026-11-03T09:00:00Z";
    const said = (sign: SignView) => paymentState(paymentOf(sign)!).words;
    assert.equal(said(payment("pay_1", "1.00", "paid", at)), "Paid");
    assert.equal(said(payment("pay_1", "1.00", "paid", at, { status: "pending" })), "PayPal is reviewing it");
    assert.equal(said(payment("pay_1", "1.00", "paid", at, { status: "refunded" })), "Refunded");
    assert.equal(said(payment("pay_1", "1.00", "waiting", at, null)), "Waiting for your board");
    assert.equal(said(payment("pay_1", "1.00", "failed", at, null)), "Didn't go through");
    assert.equal(said(payment("pay_1", "1.00", "declined", at, null)), "You said no");
  });

  it("keeps the shop and lines from the very text the board signed", () => {
    const read = paymentOf(payment("pay_1", "24.00", "paid", "2026-11-03T09:00:00Z"))!;
    assert.deepEqual(read.shop, SHOP);
    assert.equal(read.order?.paypal.captureId, "3C679366HH908993F");
    assert.equal(itemsLine(read.items), "2× House blend beans, 1 lb");
    assert.equal(itemsLine([{ name: "x".repeat(80), qty: 1, price: "1.00" }]).length, 60);
    assert.equal(paymentOf({ ...payment("pay_1", "1.00", "paid", "2026-11-03T09:00:00Z"), text: "not json" }), null);
  });

  it("knows a payment Huddle made under an allowance from one a board signed", () => {
    const sign = payment("pay_1", "14.00", "paid", "2026-11-04T09:00:00Z");
    const under = { ...sign, text: sign.text.replace('"id":"pay_1",', '"id":"pay_1","allow":"allow_000000000001",') };
    assert.equal(paymentOf(under)?.allow, "allow_000000000001");
    assert.equal(paymentOf(sign)?.allow, null);
  });

  it("lists each board's shops from the links that went through", () => {
    const link = (key: string, status: SignView["status"], paypal: string | null): SignView => ({
      ...payment("link_1", "0", "waiting", "2026-11-03T09:00:00Z", null),
      kind: "link",
      status,
      text: JSON.stringify({ v: 1, kind: "link", id: "link_1", shop: SHOP, expires: "2026-11-03T09:10:00Z" }),
      result: { key, paypal },
    });
    const shops = linkedShops([link("key-a", "linked", "buyer@example.com"), link("key-a", "linked", "buyer@example.com"), link("key-b", "failed", null), link("key-c", "linked", null)]);
    assert.deepEqual(shops.get("key-a"), [{ shop: "Bean & Leaf", paypal: "buyer@example.com" }]);
    assert.equal(shops.get("key-b"), undefined);
    assert.deepEqual(shops.get("key-c"), [{ shop: "Bean & Leaf", paypal: null }]);
  });
});
