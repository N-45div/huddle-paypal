import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, fingerprint, mock, parseFlow, parseSignable, type Payment, type ShopClient, ShopError, Store } from "@huddle/core";
import { DeviceHub, type ToDevice } from "../src/devices.ts";

/** A board as the ESP32 makes one: its raw P-256 point, and r‖s signatures. */
export function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function setUp() {
  const store = new Store();
  const hub = new DeviceHub(store, new Engine(store, { mock }));
  const { device } = store.addDevice("Desk button");
  const connect = (key: string | null, deviceId: string | null = device.id) => {
    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: deviceId ? "Desk button" : "Virtual button", version: "test", deviceId });
    session.receive(JSON.stringify({ type: "hello", audio: false, ...(key === null ? {} : { key }) }));
    return { sent, session, signer: () => sent.findLast((message) => message.type === "signer") };
  };
  return { store, device, connect };
}

describe("a board's signing key", () => {
  it("is kept the first time the board says it, with a fingerprint to compare in Devices", () => {
    const { store, device, connect } = setUp();
    const mine = board();
    const first = connect(mine.key);
    assert.deepEqual(first.signer(), { type: "signer", ok: true, fingerprint: fingerprint(mine.key), name: "Desk button" });
    assert.equal(store.signerForDevice(device.id)?.key, mine.key);
    // Coming back with the same key is the same board.
    assert.equal(connect(mine.key).signer()?.type === "signer" && connect(mine.key).signer()?.ok, true);
    assert.equal(store.signers().length, 1);
  });

  it("is refused when the same gadget comes back with another key, so a swapped board can't pay as yours", () => {
    const { store, device, connect } = setUp();
    const mine = board();
    connect(mine.key);
    const swapped = connect(board().key).signer();
    assert.equal(swapped?.type === "signer" && swapped.ok, false);
    assert.match(swapped?.type === "signer" ? (swapped.problem ?? "") : "", /key changed since it was added/);
    assert.equal(store.signerForDevice(device.id)?.key, mine.key, "the first key stays the board's");
  });

  it("is kept by the key itself for a board in a browser, which has no device", () => {
    const { store, connect } = setUp();
    const virtual = board();
    const shown = connect(virtual.key, null).signer();
    assert.equal(shown?.type === "signer" && shown.name, "Virtual board");
    assert.equal(store.signer(virtual.key)?.deviceId, null);
  });

  it("isn't needed by a button that doesn't sign, and a key that isn't one is said so", () => {
    const { store, connect } = setUp();
    assert.equal(connect(null).signer(), undefined);
    assert.equal(store.signers().length, 0);
    const bad = connect("not-a-key");
    assert.match(bad.sent.findLast((message) => message.type === "error")?.type === "error" ? (bad.sent.findLast((message) => message.type === "error") as { message: string }).message : "", /isn't one Huddle can use/);
  });
});

const SHOP = { id: "shop.test", name: "Bean & Leaf" };
/** A shop that prices a mug and takes any payment it's sent, or says no when told to. */
function shopClient(refuse = false): ShopClient {
  return {
    url: "http://shop.test",
    about: async () => ({ shop: SHOP, currency: "USD", paypal: "sandbox", about: "" }),
    search: async () => ({ shop: SHOP, products: [] }),
    price: async (lines) => ({ id: "cart_1", shop: SHOP, items: lines.map((line) => ({ sku: line.sku, name: "Stoneware mug", qty: line.qty, price: "14.00" })), total: (14 * lines[0]!.qty).toFixed(2), currency: "USD", expires: "2099-01-01T00:00:00Z" }),
    checkout: async ({ text }) => {
      if (refuse) throw new ShopError("The shop didn't take the payment: This board isn't linked to a PayPal at Bean & Leaf. Link it first.", 401);
      const payment = parseSignable(text) as Payment;
      return { id: "order_1", payment: payment.id, cart: payment.cart, board: "", status: "paid", total: payment.total, currency: "USD", paypal: { orderId: "PAYPAL-ORDER", captureId: "CAPTURE" }, error: null };
    },
    startLink: async () => ({ id: "", text: "", expires: "" }),
    signedLink: async () => ({ approveUrl: "" }),
    link: async () => ({ id: "", status: "", paypal: null, error: null }),
    board: async () => ({ linked: true, paypal: null }),
  };
}

const MUGS = parseFlow({
  name: "Mugs",
  assistants: [{ id: "beans", connector: "shop", url: "http://shop.test" }],
  steps: [{ id: "pay", type: "pay", shop: "beans", cart: '[{"sku":"mug","qty":2}]' }],
});

async function paying(refuse = false) {
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: () => shopClient(refuse) });
  const hub = new DeviceHub(store, engine);
  const { device } = store.addDevice("Desk button");
  const mine = board();
  const sent: ToDevice[] = [];
  const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test", deviceId: device.id });
  const run = await engine.start(MUGS, "");
  return { store, engine, mine, sent, session, run };
}

describe("a payment on the board", () => {
  it("is shown with the exact text to sign, ahead of any approval, and not as a yes or no", async () => {
    const { store, sent } = await paying();
    const shown = sent.findLast((message) => message.type === "sign");
    assert.ok(shown?.type === "sign");
    assert.equal(shown.line, "Pay $28.00 to Bean & Leaf: 2× Stoneware mug");
    assert.equal(shown.flow, "Mugs");
    assert.equal(shown.text, store.waitingSignRequests()[0]!.text);
    assert.ok(!sent.some((message) => message.type === "approval"), "its approval isn't offered as a yes");
  });

  it("is paid once the board signs it with the key Huddle holds for it, and the board hears what came of it", async () => {
    const { store, mine, sent, session, run } = await paying();
    session.receive(JSON.stringify({ type: "hello", audio: false, key: mine.key }));
    const request = store.waitingSignRequests()[0]!;
    session.receive(JSON.stringify({ type: "sign", id: request.id, signature: mine.sign(request.text) }));
    assert.ok(sent.some((message) => message.type === "signed" && message.id === request.id));
    await settle();
    assert.equal(store.run(run.id)?.state, "done");
    assert.deepEqual(sent.findLast((message) => message.type === "payment"), { type: "payment", id: request.id, status: "paid", line: "Paid $28.00 to Bean & Leaf with PayPal." });
    assert.equal(sent.findLast((message) => message.type === "idle" || message.type === "sign")?.type, "idle", "nothing left to sign");
  });

  it("hears why when the shop turns the signed payment down", async () => {
    const { store, mine, sent, session } = await paying(true);
    session.receive(JSON.stringify({ type: "hello", audio: false, key: mine.key }));
    const request = store.waitingSignRequests()[0]!;
    session.receive(JSON.stringify({ type: "sign", id: request.id, signature: mine.sign(request.text) }));
    await settle();
    const told = sent.findLast((message) => message.type === "payment");
    assert.equal(told?.type === "payment" && told.status, "failed");
    assert.match(told?.type === "payment" ? told.line : "", /isn't linked to a PayPal at Bean & Leaf/);
  });

  it("can't be signed before the board says its key, or with a signature of anything else", async () => {
    const { store, mine, sent, session } = await paying();
    const request = store.waitingSignRequests()[0]!;
    session.receive(JSON.stringify({ type: "sign", id: request.id, signature: mine.sign(request.text) }));
    assert.match((sent.findLast((message) => message.type === "error") as { message: string }).message, /hasn't said its key/);
    session.receive(JSON.stringify({ type: "hello", audio: false, key: mine.key }));
    session.receive(JSON.stringify({ type: "sign", id: request.id, signature: mine.sign(request.text.replace("28.00", "2.80")) }));
    assert.match((sent.findLast((message) => message.type === "error") as { message: string }).message, /isn't your board's signature of this payment/);
    assert.equal(store.signRequest(request.id)?.status, "waiting");
  });

  it("is declined by a tap, and the run ends as declined", async () => {
    const { store, sent, session, run } = await paying();
    const request = store.waitingSignRequests()[0]!;
    session.receive(JSON.stringify({ type: "decline", id: request.id }));
    await settle();
    assert.ok(sent.some((message) => message.type === "answered" && message.id === request.id && !message.yes));
    assert.equal(store.run(run.id)?.state, "declined");
    assert.equal(store.signRequest(request.id)?.status, "declined");
  });
});
