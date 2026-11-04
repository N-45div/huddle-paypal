import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, mock, NEMOTRON, parseSignable, shopClient, Store, TOKEN_FACTORY_URL } from "@huddle/core";
import { readCatalog, ShopStore, shopApp } from "@huddle/shop";
import { limitsFrom, limitsWriter } from "../src/allowance-words.ts";
import { createApp } from "../src/app.ts";
import { DeviceHub, type ToDevice } from "../src/devices.ts";

/**
 * Allowances from outside the engine: the limits a model writes from what you say, the API that sets, lists and
 * stops them, and the board that shows one and hears it's set. Against Bean & Leaf answering in this process; the
 * model test asks Nemotron on Token Factory with NEBIUS_API_KEY, and is skipped without it.
 */
const SHOP_URL = "http://localhost:7700/shop";
const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body: unknown) => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp() {
  const shopStore = new ShopStore();
  const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal: null, publicUrl: SHOP_URL });
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach) });
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, shop: SHOP_URL });
  const mine = board();
  store.addSigner({ key: mine.key, name: "Desk button", deviceId: "device_1" });
  shopStore.saveCustomer(mine.key, "VAULT-NOT-CHARGED", "buyer@example.com");
  return { store, engine, app, shopStore, mine };
}

describe("an allowance's limits from what you say", () => {
  it("are amounts, a period and a length Huddle allows, filled in where they weren't said", () => {
    assert.deepEqual(limitsFrom({ for: "Groceries", each: "20", total: 50, per: "week", days: 30 }), { for: "Groceries", each: "20.00", total: "50.00", per: "week", days: 30 });
    assert.deepEqual(limitsFrom({ each: "$15.00", per: "day" }), { for: "Shopping", each: "15.00", total: "15.00", per: "day", days: 30 }, "one amount is both");
    assert.equal(limitsFrom({ each: "80.00", total: "50.00", per: "week" }).each, "50.00", "one payment is never allowed more than all of them");
    assert.equal(limitsFrom({ each: "5.00", per: "week", days: 400 }).days, 31);
    assert.throws(() => limitsFrom({ for: "Coffee", per: "week" }), /needs amounts/);
    assert.throws(() => limitsFrom({ each: "5.00", per: "year" }), /per day, week or month/);
  });

  it("are written by Nemotron from a sentence", { skip: !process.env.NEBIUS_API_KEY?.trim() && "set NEBIUS_API_KEY to write limits with Nemotron on Token Factory" }, async () => {
    const write = limitsWriter({ url: TOKEN_FACTORY_URL, model: NEMOTRON.super, key: process.env.NEBIUS_API_KEY!.trim() });
    const weekly = await write("groceries up to $20 each, $50 a week");
    assert.deepEqual([weekly.each, weekly.total, weekly.per], ["20.00", "50.00", "week"]);
    assert.match(weekly.for, /grocer/i);
    const daily = await write("let it spend 15 dollars a day on coffee for the next two weeks");
    assert.deepEqual([daily.total, daily.per, daily.days], ["15.00", "day", 14]);
  });
});

describe("allowances in the API", () => {
  it("are set for your board to sign, signed, listed with what's spent, and stopped", async () => {
    const { app, mine, shopStore } = setUp();
    assert.equal(((await (await app.request("/api/info", { headers: auth })).json()) as { allowanceWords: boolean }).allowanceWords, false);
    assert.equal((await app.request("/api/allowances", post({ said: "groceries up to $20 each" }))).status, 501, "words need a model");
    const set = await app.request("/api/allowances", post({ for: "Groceries", each: "20.00", total: "50.00", per: "week", days: 7 }));
    assert.equal(set.status, 201);
    const view = (await set.json()) as { id: string; status: string; text: string; shop: { name: string; url: string }; spent: string | null };
    assert.deepEqual([view.status, view.shop.name, view.shop.url, view.spent], ["waiting", "Bean & Leaf", SHOP_URL, null]);
    const signed = await app.request(`/api/signs/${view.id}`, post({ signature: mine.sign(view.text), key: mine.key }));
    assert.equal(signed.status, 200);
    const [listed] = (await (await app.request("/api/allowances", { headers: auth })).json()) as { status: string; spent: string; board: string; each: string; total: string; per: string }[];
    assert.deepEqual([listed!.status, listed!.spent, listed!.each, listed!.total, listed!.per], ["active", "0.00", "20.00", "50.00", "week"]);
    assert.equal(shopStore.allowance(view.id)?.status, "active");
    const stopped = (await (await app.request(`/api/allowances/${view.id}/stop`, post({}))).json()) as { status: string };
    assert.equal(stopped.status, "stopped");
    assert.equal(shopStore.allowance(view.id)?.status, "stopped");
    assert.equal((await app.request("/api/allowances", post({ for: "Groceries", each: "20.00", per: "week", shop: "https://elsewhere.example/shop" }))).status, 400);
    assert.equal((await app.request("/api/allowances")).status, 401, "behind the Huddle token");
  });
});

describe("an allowance on the board", () => {
  it("is shown with its limits, and the board hears when it's set", async () => {
    const { store, engine, mine } = setUp();
    const hub = new DeviceHub(store, engine);
    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test", deviceId: "device_1" });
    session.receive(JSON.stringify({ type: "hello", audio: false, key: mine.key }));
    const request = await engine.startAllowance(SHOP_URL, mine.key, { for: "Groceries", each: "20.00", total: "50.00", per: "week", days: 7 });
    const shown = sent.findLast((message) => message.type === "sign");
    assert.ok(shown?.type === "sign");
    assert.equal(shown.kind, "allow");
    assert.match(shown.line, /^Let Huddle spend up to \$20\.00 a time and \$50\.00 a week at Bean & Leaf, for Groceries, until \d{4}-\d{2}-\d{2}$/);
    assert.equal(parseSignable(shown.text).kind, "allow");
    session.receive(JSON.stringify({ type: "sign", id: request.id, signature: mine.sign(request.text) }));
    for (let tries = 0; tries < 100 && !sent.some((message) => message.type === "payment"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.findLast((message) => message.type === "payment"), { type: "payment", id: request.id, status: "set", line: "Allowance set: Huddle may spend up to $20.00 a time and $50.00 a week at Bean & Leaf." });
  });
});
