import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { type Allowance, type Payment, PayPal, signableText, signableTime } from "@huddle/core";
import { readCatalog } from "../src/catalog.ts";
import { shopApp } from "../src/shop.ts";
import { ShopStore } from "../src/store.ts";

/**
 * Allowances at the shop: a linked board signs once that Huddle's key may pay here within limits, and the shop
 * holds Huddle to them. Every refusal happens before PayPal is asked; the charge itself runs against PayPal's
 * sandbox with PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID (a payer's PayPal saved with
 * the app), and is skipped without them.
 */
const CATALOG = readCatalog(new URL("../catalog.json", import.meta.url));
const SHOP = { id: "shop.test", name: "Bean & Leaf" };
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const paypal = vaultId ? PayPal.fromEnv(process.env) : null;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(withPayPal = false) {
  const store = new ShopStore();
  const app = shopApp({ catalog: CATALOG, store, paypal: withPayPal ? paypal : null, publicUrl: "http://shop.test" });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const board = keyPair();
  const agent = keyPair();
  // The board linked here earlier (with the sandbox payer's saved PayPal, when there's one to charge).
  store.saveCustomer(board.key, vaultId ?? "VAULT-NOT-CHARGED", "buyer@example.com");
  const allowance = (change: Partial<Allowance> = {}): Allowance => ({
    v: 1,
    kind: "allow",
    id: `allow_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    shop: SHOP,
    for: "Groceries",
    agent: agent.key,
    each: "20.00",
    total: "50.00",
    per: "week",
    currency: "USD",
    expires: signableTime(Date.now() + 7 * 86_400_000),
    ...change,
  });
  const give = async (allowed: Allowance, signer = board) => {
    const text = signableText(allowed);
    return call("POST", "/allowances", { text, signature: signer.sign(text), key: signer.key });
  };
  /** A cart priced by the shop, as a payment under the allowance, signed by `signer` (Huddle's key, normally). */
  const payment = async (allow: string, items: { sku: string; qty: number }[], signer = agent) => {
    const priced = (await call("POST", "/carts", { items })).body.cart;
    const paying: Payment = { v: 1, kind: "buy", id: `pay_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`, allow, shop: SHOP, cart: priced.id, items: priced.items.map((line: { name: string; qty: number; price: string }) => ({ name: line.name, qty: line.qty, price: line.price })), total: priced.total, currency: "USD", expires: signableTime(Date.now() + 600_000) };
    const text = signableText(paying);
    return call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
  };
  return { store, call, board, agent, allowance, give, payment };
}

describe("an allowance at the shop", () => {
  it("is taken only from a linked board's own signature, for this shop, for a month at most", async () => {
    const { give, allowance, agent } = setUp();
    const stranger = keyPair();
    assert.match((await give(allowance(), stranger)).body.error, /isn't linked to a PayPal/);
    assert.equal((await give(allowance({ shop: { id: "elsewhere.test", name: "Bean & Leaf" } }))).status, 400);
    assert.equal((await give(allowance({ expires: signableTime(Date.now() + 40 * 86_400_000) }))).status, 400);
    assert.equal((await give(allowance({ expires: signableTime(Date.now() - 1_000) }))).status, 410);
    assert.equal((await give(allowance(), agent)).status, 401, "Huddle can't give itself an allowance");
    const given = await give(allowance({ id: "allow_000000000001" }));
    assert.equal(given.status, 201);
    assert.deepEqual([given.body.allowance.status, given.body.allowance.each, given.body.allowance.total, given.body.allowance.per, given.body.allowance.spent], ["active", "20.00", "50.00", "week", "0.00"]);
    assert.equal((await give(allowance({ id: "allow_000000000001" }))).status, 201, "the same one again is the one kept");
  });

  it("pays only with the key it names, one payment up to its each, all of them up to its total", async () => {
    const { store, give, allowance, payment, board, call } = setUp();
    const allowed = allowance({ id: "allow_000000000002" });
    await give(allowed);
    assert.match((await payment(allowed.id, [{ sku: "beans-house", qty: 1 }], board)).body.error, /Only the key the allowance names/, "even the board pays under it only through Huddle's key");
    assert.match((await payment(allowed.id, [{ sku: "beans-house", qty: 1 }], keyPair())).body.error, /Only the key the allowance names/);
    const each = await payment(allowed.id, [{ sku: "beans-house", qty: 2 }]);
    assert.equal(each.status, 403);
    assert.equal(each.body.error, "$24.00 is more than the $20.00 a time the allowance lets Huddle pay. Nothing was charged: your board can sign it instead.");
    // $40 already spent under it this week.
    store.startOrder({ paymentId: "pay_earlier00000001", cartId: "cart_earlier", fingerprint: "x", text: "{}", signature: "x", total: "40.00", currency: "USD", allowance: allowed.id });
    const total = await payment(allowed.id, [{ sku: "beans-house", qty: 1 }]);
    assert.equal(total.status, 403);
    assert.match(total.body.error, /would make \$52\.00 in a week under the allowance, more than its \$50\.00/);
    assert.equal((await call("GET", `/allowances/${allowed.id}`)).body.allowance.spent, "40.00");
    // Within both, it goes on to PayPal (none here, so it stops there).
    assert.equal((await payment(allowed.id, [{ sku: "filters", qty: 1 }])).status, 503);
    assert.match((await payment("allow_nothinghere01", [{ sku: "filters", qty: 1 }])).body.error, /no such allowance/);
  });

  it("stops at once, signed by the board or the key it names, and nothing more is paid under it", async () => {
    const { give, allowance, payment, call, agent, board } = setUp();
    const allowed = allowance({ id: "allow_000000000003" });
    await give(allowed);
    assert.equal((await call("POST", `/allowances/${allowed.id}/stop`, { signature: keyPair().sign(`stop ${allowed.id}`) })).status, 401);
    const stopped = await call("POST", `/allowances/${allowed.id}/stop`, { signature: agent.sign(`stop ${allowed.id}`) });
    assert.equal(stopped.body.allowance.status, "stopped");
    assert.match((await payment(allowed.id, [{ sku: "filters", qty: 1 }])).body.error, /^That allowance was stopped\. Nothing was charged/);
    const other = allowance({ id: "allow_000000000004" });
    await give(other);
    assert.equal((await call("POST", `/allowances/${other.id}/stop`, { signature: board.sign(`stop ${other.id}`) })).body.allowance.status, "stopped");
  });

  it("charges the board's PayPal for a payment Huddle's key signs under it", { skip: !paypal && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to charge PayPal's sandbox" }, async () => {
    const { give, allowance, payment, call } = setUp(true);
    const allowed = allowance({ id: `allow_${Date.now().toString(16)}aa` });
    await give(allowed);
    const paid = await payment(allowed.id, [{ sku: "filters", qty: 1 }]);
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.order.status, "paid");
    assert.equal(paid.body.order.allowance, allowed.id);
    assert.match(paid.body.order.paypal.captureId, /^[A-Z0-9]+$/);
    assert.equal((await call("GET", `/allowances/${allowed.id}`)).body.allowance.spent, paid.body.order.total);
    await paypal!.refund(paid.body.order.paypal.captureId, { note: "Huddle's allowance test" });
  });
});
