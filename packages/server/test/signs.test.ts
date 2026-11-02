import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, mock, parseFlow, parseSignable, type Payment, type Run, type ShopClient, signedBy, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (body: unknown) => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const SHOP = { id: "shop.test", name: "Bean & Leaf" };

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

/** A shop that prices one thing and takes any signed payment. */
const shop: ShopClient = {
  url: "http://shop.test",
  about: async () => ({ shop: SHOP, currency: "USD", paypal: "sandbox", about: "" }),
  search: async () => ({ shop: SHOP, products: [] }),
  price: async (lines) => ({ id: "cart_1", shop: SHOP, items: lines.map((line) => ({ sku: line.sku, name: "Stoneware mug", qty: line.qty, price: "14.00" })), total: (14 * lines[0]!.qty).toFixed(2), currency: "USD", expires: "2099-01-01T00:00:00Z" }),
  checkout: async ({ text }) => {
    const payment = parseSignable(text) as Payment;
    return { id: "order_1", payment: payment.id, cart: payment.cart, board: "", status: "paid", total: payment.total, currency: "USD", paypal: { orderId: "PAYPAL-ORDER", captureId: "CAPTURE" }, error: null };
  },
  startLink: async () => ({ id: "", text: "", expires: "" }),
  signedLink: async () => ({ approveUrl: "" }),
  link: async () => ({ id: "", status: "", paypal: null, error: null }),
  board: async () => ({ linked: true, paypal: null }),
};

const mugs = parseFlow({
  name: "Mugs",
  assistants: [{ id: "beans", connector: "shop", url: "http://shop.test" }],
  steps: [{ id: "pay", type: "pay", shop: "beans", cart: '[{"sku":"mug","qty":2}]' }],
});

async function settle(store: Store, runId: string): Promise<Run> {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = store.run(runId);
    if (run && run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never settled`);
}

describe("payments in the API", () => {
  it("show the exact text to sign, turn a yes away, and take the board's signature", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock }, { shops: () => shop });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN });
    const mine = board();
    const signer = store.addSigner({ key: mine.key, name: "Desk button" });
    const run = await engine.start(mugs, "");

    const [waiting] = (await (await app.request("/api/approvals", { headers: auth })).json()) as { id: string; message: string; signs: { id: string; text: string } }[];
    assert.equal(waiting!.message, "Pay $28.00 to Bean & Leaf: 2× Stoneware mug");
    assert.equal((parseSignable(waiting!.signs.text) as Payment).total, "28.00");

    const yes = await app.request(`/api/approvals/${waiting!.id}`, json({ yes: true }));
    assert.equal(yes.status, 409);
    assert.match(((await yes.json()) as { error: string }).error, /needs your board's signature/);

    const stranger = board();
    const refused = await app.request(`/api/signs/${waiting!.signs.id}`, json({ signature: stranger.sign(waiting!.signs.text), key: stranger.key }));
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /isn't one of your boards'/);
    assert.equal((await app.request("/api/signs/pay_nothing", json({ signature: "x", key: "y" }))).status, 404);
    assert.equal((await app.request(`/api/signs/${waiting!.signs.id}`, json({ signature: 1 }))).status, 400);

    const taken = await app.request(`/api/signs/${waiting!.signs.id}`, json({ signature: mine.sign(waiting!.signs.text), key: mine.key }));
    assert.equal(taken.status, 202);
    assert.equal((await settle(store, run.id)).state, "done");

    const [paid] = (await (await app.request("/api/signs", { headers: auth })).json()) as { status: string; board: string; text: string; signature: string; result: { paypal: { orderId: string } } }[];
    assert.equal(paid!.status, "paid");
    assert.equal(paid!.board, signer.fingerprint);
    assert.equal(signedBy(paid!.text, paid!.signature, mine.key), true, "what the board signed, checkable by anyone with its key");
    assert.equal(((await (await app.request("/api/signs?kind=buy", { headers: auth })).json()) as unknown[]).length, 1);
    assert.deepEqual(await (await app.request("/api/signs?kind=link", { headers: auth })).json(), []);
    assert.equal(paid!.result.paypal.orderId, "PAYPAL-ORDER");
    assert.deepEqual(await (await app.request("/api/signs?status=waiting", { headers: auth })).json(), []);
    assert.equal((await app.request("/api/signs")).status, 401, "behind the Huddle token like the rest of /api");
  });
});

describe("your boards in the API", () => {
  it("lists them, takes a board in a browser by its key, and forgets one when it's removed", async () => {
    const store = new Store();
    const app = createApp({ store, engine: new Engine(store, { mock }), version: "test", publicUrl: "http://huddle.test", token: TOKEN });
    const virtual = board();
    const added = await app.request("/api/signers", json({ key: virtual.key, name: "My laptop" }));
    assert.equal(added.status, 201);
    const view = (await added.json()) as { key: string; fingerprint: string; name: string; deviceId: string | null };
    assert.deepEqual([view.key, view.name, view.deviceId], [virtual.key, "My laptop", null]);
    assert.equal((await app.request("/api/signers", json({ key: virtual.key }))).status, 409, "a key is kept once");
    assert.equal((await app.request("/api/signers", json({ key: "nope" }))).status, 400);
    const listed = (await (await app.request("/api/signers", { headers: auth })).json()) as { fingerprint: string }[];
    assert.deepEqual(listed.map((one) => one.fingerprint), [view.fingerprint]);
    assert.equal((await app.request(`/api/signers/${virtual.key}`, { method: "DELETE", headers: auth })).status, 204);
    assert.equal((await app.request(`/api/signers/${virtual.key}`, { method: "DELETE", headers: auth })).status, 404);
    assert.equal((await app.request("/api/signers")).status, 401, "behind the Huddle token");
  });

  it("forgets a gadget's key when the gadget is removed, so added again it can say a new one", async () => {
    const store = new Store();
    const app = createApp({ store, engine: new Engine(store, { mock }), version: "test", publicUrl: "http://huddle.test", token: TOKEN });
    const { device } = store.addDevice("Desk button");
    store.addSigner({ key: board().key, name: "Desk button", deviceId: device.id });
    assert.equal((await app.request(`/api/devices/${device.id}`, { method: "DELETE", headers: auth })).status, 204);
    assert.equal(store.signerForDevice(device.id), null);
    assert.deepEqual(store.signers(), []);
  });
});
