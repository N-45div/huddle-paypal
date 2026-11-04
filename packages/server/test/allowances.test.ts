import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { activeAllowances, agentKey, Engine, mock, parseFlow, parseSignable, type Payment, PayPal, type Run, shopClient, signedBy, Store } from "@huddle/core";
import { readCatalog, ShopStore, shopApp } from "@huddle/shop";

/**
 * Allowances, Huddle's side, against Bean & Leaf answering in this process: your board signs one, the shop takes
 * it, and Huddle pays for carts that fit it with its own key; anything else still goes to your board. Paying for
 * real runs against PayPal's sandbox with PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID, and
 * is skipped without them.
 */
const SHOP_URL = "http://localhost:7700/shop";
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const paypal = vaultId ? PayPal.fromEnv(process.env) : null;
const LIMITS = { for: "Groceries", each: "20.00", total: "30.00", per: "week" as const, days: 7 };

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(withPayPal = false) {
  const shopStore = new ShopStore();
  const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal: withPayPal ? paypal : null, publicUrl: SHOP_URL });
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach) });
  const mine = board();
  store.addSigner({ key: mine.key, name: "Desk button" });
  // The board linked at the shop earlier (to the sandbox payer's saved PayPal, when there's one to charge).
  shopStore.saveCustomer(mine.key, vaultId ?? "VAULT-NOT-CHARGED", "buyer@example.com");
  const buy = (items: { sku: string; qty: number }[]) =>
    engine.start(parseFlow({ name: "Groceries", assistants: [{ id: "beans", connector: "shop", url: SHOP_URL }], steps: [{ id: "pay", type: "pay", shop: "beans", cart: JSON.stringify(items) }] }), "");
  return { store, engine, shopStore, mine, buy };
}

async function settled(store: Store, runId: string): Promise<Run> {
  for (let tries = 0; tries < 300; tries += 1) {
    const run = store.run(runId)!;
    if (run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never settled`);
}

/** Your board signs the allowance waiting for it, and the shop takes it. */
async function allow(setup: ReturnType<typeof setUp>) {
  const request = await setup.engine.startAllowance(SHOP_URL, setup.mine.key, LIMITS);
  return setup.engine.signAllowance(request.id, setup.mine.sign(request.text), setup.mine.key);
}

describe("an allowance in Huddle", () => {
  it("is written with Huddle's own key, signed once by your board, and taken by the shop", async () => {
    const setup = setUp();
    const request = await setup.engine.startAllowance(SHOP_URL, setup.mine.key, LIMITS);
    const allowance = parseSignable(request.text);
    assert.equal(allowance.kind, "allow");
    assert.equal(allowance.kind === "allow" && allowance.agent, agentKey(setup.store).key);
    assert.equal(agentKey(setup.store).key, agentKey(setup.store).key, "Huddle's key is made once and kept");
    assert.deepEqual([request.kind, request.status], ["allow", "waiting"]);
    await assert.rejects(setup.engine.signAllowance(request.id, board().sign(request.text), board().key), /isn't one of your boards'/);
    const active = await setup.engine.signAllowance(request.id, setup.mine.sign(request.text), setup.mine.key);
    assert.equal(active.status, "active");
    assert.equal(setup.shopStore.allowance(request.id)?.status, "active");
    assert.equal(activeAllowances(setup.store).length, 1);
    await assert.rejects(setup.engine.startAllowance(SHOP_URL, setup.mine.key, { ...LIMITS, days: 40 }), /from 1 to 31 days/);
  });

  it("pays for a cart that fits with Huddle's key, and leaves a bigger one for your board", async () => {
    const setup = setUp();
    const allowed = await allow(setup);
    // $24 is over the $20 a time: the board is asked, as ever.
    const big = await settled(setup.store, (await setup.buy([{ sku: "beans-house", qty: 2 }])).id);
    assert.equal(big.state, "waiting");
    assert.match(setup.store.waitingApproval(big.id)?.message ?? "", /^Pay \$24\.00 to Bean & Leaf/);
    // $12 fits: Huddle signs it itself and sends it to the shop (no PayPal here, so the shop stops there).
    const small = await settled(setup.store, (await setup.buy([{ sku: "beans-house", qty: 1 }])).id);
    const allowedLine = setup.store.logOf(small.id).find((line) => line.kind === "allowed");
    assert.ok(allowedLine, "paid under the allowance, not asked of the board");
    const request = setup.store.signRequest((allowedLine.detail as { sign: string }).sign)!;
    const payment = parseSignable(request.text) as Payment;
    assert.equal(payment.allow, allowed.id);
    assert.equal(signedBy(request.text, request.signature!, agentKey(setup.store).key), true);
    assert.match(small.error ?? "", /can't take PayPal yet/);
  });

  it("goes to your board when the shop won't take it under the allowance, and stops at the shop too", async () => {
    const setup = setUp();
    const allowed = await allow(setup);
    // Stopped at the shop by the board itself, out of Huddle's sight: the shop says no, and the board is asked.
    setup.shopStore.stopAllowance(allowed.id);
    const run = await settled(setup.store, (await setup.buy([{ sku: "filters", qty: 1 }])).id);
    assert.equal(run.state, "waiting");
    assert.match(JSON.stringify(setup.store.logOf(run.id).find((line) => line.kind === "over allowance")?.detail), /That allowance was stopped/);

    const other = await allow(setup);
    const stopped = await setup.engine.stopAllowance(other.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(setup.shopStore.allowance(other.id)?.status, "stopped", "Huddle told the shop, with its own key");
    assert.equal(activeAllowances(setup.store).some((one) => one.request.id === other.id), false);
  });

  it("pays PayPal's sandbox under it without your board, up to its total", { skip: !paypal && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to pay PayPal's sandbox" }, async () => {
    const setup = setUp(true);
    await allow(setup);
    const captures: string[] = [];
    // Two $14 carts fit the $30 a week; a third would make $42, so it goes to the board.
    for (const expected of ["done", "done", "waiting"]) {
      const run = await settled(setup.store, (await setup.buy([{ sku: "beans-decaf", qty: 1 }])).id);
      assert.equal(run.state, expected, run.error ?? "");
      const paid = run.context.steps.pay?.data as { paypal?: { captureId?: string }; allowance?: string } | undefined;
      if (paid?.paypal?.captureId) captures.push(paid.paypal.captureId);
      if (expected === "done") assert.match(run.context.steps.pay!.text, /^Paid \$14\.00 to Bean & Leaf with PayPal, under your allowance \(order /);
    }
    assert.equal(captures.length, 2);
    assert.equal(activeAllowances(setup.store)[0]?.spent, 2800);
    for (const capture of captures) await paypal!.refund(capture, { note: "Huddle's allowance test" });
  });
});
