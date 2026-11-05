import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, type Finding, mock, NEMOTRON, parseFlow, PayPal, type Run, shopClient, Store, TOKEN_FACTORY_URL } from "@huddle/core";
import { readCatalog, ShopStore, shopApp } from "@huddle/shop";
import { createApp } from "../src/app.ts";
import { Auditor, disputeTemplate, disputeWriter } from "../src/auditor.ts";

/**
 * The auditor against PayPal's sandbox: a payment your board signed passes, and a charge made behind the board's
 * back (straight to PayPal, as a shop that's been broken into could) is flagged, with a dispute drafted. Needs
 * PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID; catching the charge behind the board's back
 * also needs a webhook on the app (npm run paypal:webhook), since only PayPal's events show it. Drafting with
 * Nemotron needs NEBIUS_API_KEY.
 */
const SHOP_URL = "http://localhost:7700/shop";
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const paypal = vaultId ? PayPal.fromEnv(process.env) : null;
const noPayPal = !paypal && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to audit PayPal's sandbox";

const rogue: Finding = {
  charge: { captureId: "3C679366HH908993F", orderId: "5O190127TN364715T", invoiceId: "rogue-0001", amount: "99.00", currency: "USD", status: "COMPLETED", at: "2026-11-06T10:01:00Z" },
  verdict: "unsigned",
  why: "PayPal took $99.00 (capture 3C679366HH908993F), but no board of yours signed a payment by the id it was charged with (rogue-0001).",
  signId: null,
};

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

describe("a dispute for a flagged charge", () => {
  it("says the merchant, the date, the amount and PayPal's transaction id, and what's wrong", () => {
    assert.equal(
      disputeTemplate({ merchant: "Bean & Leaf", finding: rogue }),
      "I'm disputing a charge of $99.00 by Bean & Leaf on 2026-11-06 (PayPal transaction 3C679366HH908993F, order 5O190127TN364715T). I didn't authorize it: every purchase I make there is signed on my own device first, and no signature of mine is behind this charge. Please reverse the charge.",
    );
    const mismatch: Finding = { ...rogue, verdict: "mismatch", why: "PayPal took $99.00 (capture 3C679366HH908993F), but what was signed was $14.00." };
    assert.match(disputeTemplate({ merchant: "Bean & Leaf", finding: mismatch }), /The amount doesn't match what I authorized: what was signed was \$14\.00\. Please reverse/);
  });

  it("is drafted by Nemotron from the facts alone", { skip: !process.env.NEBIUS_API_KEY?.trim() && "set NEBIUS_API_KEY to draft with Nemotron on Token Factory" }, async () => {
    const write = disputeWriter({ url: TOKEN_FACTORY_URL, model: NEMOTRON.super, key: process.env.NEBIUS_API_KEY!.trim() });
    const draft = await write({ merchant: "Bean & Leaf", finding: rogue });
    assert.ok(draft.includes("3C679366HH908993F") && draft.includes("99.00") && draft.includes("Bean & Leaf"), draft);
    assert.notEqual(draft, disputeTemplate({ merchant: "Bean & Leaf", finding: rogue }), "the model's own words, not the template");
    assert.doesNotMatch(draft, /\[|\{\{|Dear|Sincerely/, "no placeholders, greeting or sign-off");
  });
});

describe("the auditor in the API", () => {
  it("says what it needs when PayPal isn't set up", async () => {
    const store = new Store();
    const app = createApp({ store, engine: new Engine(store, { mock }), version: "test", publicUrl: "http://huddle.test" });
    assert.equal((await app.request("/api/audit")).status, 501);
    assert.match(((await (await app.request("/api/audit", { method: "POST" })).json()) as { error: string }).error, /PAYPAL_CLIENT_ID/);
  });
});

describe("the auditor at PayPal's sandbox", () => {
  it("passes a payment your board signed, and flags a charge made behind its back", { skip: noPayPal }, async () => {
    const shopStore = new ShopStore();
    const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal, publicUrl: SHOP_URL });
    const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
    const store = new Store();
    const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach) });
    const mine = board();
    store.addSigner({ key: mine.key, name: "Desk button" });
    shopStore.saveCustomer(mine.key, vaultId!, "buyer@example.com");

    // A payment the board signs, paid for real.
    const run = await engine.start(parseFlow({ name: "Filters", assistants: [{ id: "beans", connector: "shop", url: SHOP_URL }], steps: [{ id: "pay", type: "pay", shop: "beans", cart: '[{"sku":"filters","qty":1}]' }] }), "");
    const request = store.waitingSignRequests()[0]!;
    engine.sign(request.id, mine.sign(request.text), mine.key);
    let settled: Run = store.run(run.id)!;
    for (let tries = 0; tries < 300 && (settled.state === "waiting" || settled.state === "running"); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = store.run(run.id)!;
    }
    assert.equal(settled.state, "done", settled.error ?? "");
    const signedCapture = (settled.context.steps.pay!.data as { paypal: { captureId: string } }).paypal.captureId;

    // A charge straight to the saved PayPal, with no board's signature: what a shop that's been broken into could do.
    const behind = await paypal!.charge({ vaultId: vaultId!, currency: "USD", invoiceId: `rogue-${randomUUID().slice(0, 8)}`, items: [{ name: "Gift card", quantity: 1, unitAmount: "2.00" }] });

    const withWebhook = (await paypal!.webhooks()).length > 0;
    const auditor = new Auditor(store, paypal!, { merchant: "Bean & Leaf" });
    let view = await auditor.run();
    // PayPal makes its events within moments; a few more looks, when there's a webhook to make them for.
    for (let tries = 0; withWebhook && tries < 12 && !view.findings.some((one) => one.charge.captureId === behind.captureId); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      view = await auditor.run();
    }
    const passed = view.findings.find((one) => one.charge.captureId === signedCapture);
    assert.equal(passed?.verdict, "signed", JSON.stringify(view.findings));
    assert.equal(passed?.flagged, false);
    if (withWebhook) {
      assert.equal(view.events, true);
      const caught = view.findings.find((one) => one.charge.captureId === behind.captureId);
      assert.equal(caught?.verdict, "unsigned");
      assert.equal(caught?.flagged, true);
      assert.ok(caught?.draft?.includes(behind.captureId ?? "-"), "a dispute is drafted for it");
    } else {
      assert.equal(view.events, false);
      assert.match(view.note ?? "", /needs a webhook/);
    }
    await paypal!.refund(signedCapture, { note: "Huddle's auditor test" });
    await paypal!.refund(behind.captureId!, { note: "Huddle's auditor test" });
  });
});
