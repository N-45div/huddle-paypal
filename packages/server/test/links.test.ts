import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, type LinkResult, mock, parseSignable, shopClient, Store } from "@huddle/core";
import { demoShop } from "@huddle/shop";

/**
 * Linking a board to your PayPal at a shop, against Bean & Leaf itself (the demo shop, in this process). With
 * PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET set (the sandbox's), the shop asks PayPal's sandbox for its page to
 * save your PayPal with; without them, the shop says it can't take PayPal yet, and the PayPal test is skipped.
 */
const SHOP_URL = "http://localhost:7700/shop";
const live = Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim());

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(options: { readonly paypal?: boolean; readonly now?: () => number } = {}) {
  const env = options.paypal ? { HUDDLE_SHOP: "on", PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT: "sandbox" } : { HUDDLE_SHOP: "on" };
  const shop = demoShop(env, { publicUrl: SHOP_URL, db: ":memory:" })!;
  // Huddle reaches the shop over HTTP as it would anywhere; here the address is answered by the shop in this process.
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.app.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach), ...(options.now ? { now: options.now } : {}) });
  const mine = board();
  store.addSigner({ key: mine.key, name: "Desk button", deviceId: "device_1" });
  return { store, engine, mine };
}

describe("linking a board at a shop", () => {
  it("is written by the shop for one of your boards, and waits for that board like a payment", async () => {
    const { store, engine, mine } = setUp();
    const link = await engine.startLink(SHOP_URL, mine.key, "http://huddle.test/devices");
    const signable = parseSignable(link.text);
    assert.equal(signable.kind, "link");
    assert.equal(signable.id, link.id);
    assert.deepEqual(signable.shop, { id: "localhost:7700", name: "Bean & Leaf" });
    assert.deepEqual([link.kind, link.status, link.runId, link.shop], ["link", "waiting", null, SHOP_URL]);
    assert.deepEqual(link.result as LinkResult, { key: mine.key, returnUrl: "http://huddle.test/devices" });
    assert.deepEqual(store.waitingSignRequests().map((one) => one.id), [link.id]);
    await assert.rejects(engine.startLink(SHOP_URL, board().key), /isn't one of your boards'/);
  });

  it("takes only the signature of the board it's for, of exactly its text", async () => {
    const { store, engine, mine } = setUp();
    const other = board();
    store.addSigner({ key: other.key, name: "Virtual board" });
    const link = await engine.startLink(SHOP_URL, mine.key);
    await assert.rejects(engine.signLink(link.id, other.sign(link.text), other.key), /for another of your boards, not Virtual board/);
    await assert.rejects(engine.signLink(link.id, mine.sign(link.text.replace("Bean & Leaf", "Bean and Leaf")), mine.key), /isn't your board's signature of this link/);
    const stranger = board();
    await assert.rejects(engine.signLink(link.id, stranger.sign(link.text), stranger.key), /isn't one of your boards'/);
    assert.equal(store.signRequest(link.id)?.status, "waiting");
    assert.throws(() => engine.sign(link.id, other.sign(link.text), other.key), /for another of your boards/, "the board hears straight away too");
  });

  it("isn't taken once it's expired, so linking starts again", async () => {
    let clock = Date.now();
    const { store, engine, mine } = setUp({ now: () => clock });
    const link = await engine.startLink(SHOP_URL, mine.key);
    clock += 11 * 60_000;
    await assert.rejects(engine.signLink(link.id, mine.sign(link.text), mine.key), /expired before your board signed it/);
    assert.equal(store.signRequest(link.id)?.status, "expired");
  });

  it("fails with the shop's reason when the shop can't take PayPal", async () => {
    const { store, engine, mine } = setUp();
    const link = await engine.startLink(SHOP_URL, mine.key);
    await assert.rejects(engine.signLink(link.id, mine.sign(link.text), mine.key), /can't take PayPal yet/);
    const failed = store.signRequest(link.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /PAYPAL_CLIENT_ID/);
    assert.equal(failed.signature !== null, true, "the board's signature is kept with it");
  });

  it("is handed to PayPal's sandbox, whose page saves your PayPal with the shop", { skip: !live && "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) to link at PayPal" }, async () => {
    const { store, engine, mine } = setUp({ paypal: true });
    const link = await engine.startLink(SHOP_URL, mine.key, "http://huddle.test/devices");
    // Over the board's own path: the signature is taken at once, and the shop is asked in the background.
    assert.equal(engine.sign(link.id, mine.sign(link.text), mine.key), "");
    let signed = store.signRequest(link.id)!;
    for (let tries = 0; tries < 200 && !(signed.result as LinkResult).approveUrl && signed.status !== "failed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      signed = store.signRequest(link.id)!;
    }
    assert.equal(signed.error, null);
    assert.equal(signed.status, "signed");
    const held = signed.result as LinkResult;
    assert.match(held.approveUrl ?? "", /^https:\/\/www\.sandbox\.paypal\.com\//);
    assert.deepEqual([held.key, held.returnUrl], [mine.key, "http://huddle.test/devices"]);
    // Not linked until you've said yes on PayPal's page.
    assert.equal((await engine.checkLink(link.id)).status, "signed");
  });
});
