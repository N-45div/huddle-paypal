import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine, mock, NEMOTRON, parseSignable, type Payment, Router, shopClient, Store, TOKEN_FACTORY_URL } from "@huddle/core";
import { demoShop } from "@huddle/shop";
import { Asker, type Choices, planFrom, type Planner, planner } from "../src/just-ask.ts";

/**
 * Just ask, buying: "buy two bags of house blend" becomes a cart at one of your shops, which waits for your board
 * to sign it. Against Bean & Leaf itself (the demo shop, answering in this process); the planning test asks
 * Nemotron on Token Factory with NEBIUS_API_KEY, and is skipped without it.
 */
const SHOP_URL = "http://localhost:7700/shop";
const BY = { name: "Canvas", tier: "owner", via: "canvas" } as const;
const CHOICES: Choices = {
  flows: [],
  assistants: [],
  shops: [{ id: SHOP_URL, name: "Bean & Leaf", products: [{ sku: "beans-house", name: "House blend beans, 1 lb", price: "12.00", currency: "USD" }] }],
};

function setUp(plan: Planner) {
  const shop = demoShop({ HUDDLE_SHOP: "on" }, { publicUrl: SHOP_URL, db: ":memory:" })!;
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.app.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach) });
  return { store, asker: new Asker(store, engine, new Router(store, engine, null), plan, { shop: SHOP_URL }) };
}

/** Waits for a run to stop running: a cart stops at the payment, waiting for your board. */
async function stopped(store: Store, runId: string) {
  for (let tries = 0; tries < 200 && store.run(runId)?.state === "running"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return store.run(runId)!;
}

describe("a plan that buys", () => {
  it("is a cart at one of your shops, of products it lists, run as a pay step", () => {
    const plan = planFrom({ use: "buy", shop: SHOP_URL, items: [{ sku: "beans-house", qty: 2 }], say: "Two bags of house blend from Bean & Leaf, for you to sign." }, "Buy two bags of house blend", CHOICES);
    assert.equal(plan.use, "buy");
    assert.equal(plan.say, "Two bags of house blend from Bean & Leaf, for you to sign.");
    const flow = plan.use === "buy" ? plan.flow : null;
    assert.deepEqual(flow?.steps, [{ id: "pay", type: "pay", shop: "shop", cart: '[{"sku":"beans-house","qty":2}]' }]);
    assert.equal(flow?.description, "Buy two bags of house blend");
  });

  it("isn't taken at a shop you don't have, or for something the shop doesn't list", () => {
    assert.throws(() => planFrom({ use: "buy", shop: "https://elsewhere.example/shop", items: [{ sku: "beans-house" }] }, "Buy coffee", CHOICES), /a shop you don't have/);
    assert.throws(() => planFrom({ use: "buy", shop: SHOP_URL, items: [{ sku: "gift-200", qty: 1 }] }, "Buy coffee", CHOICES), /doesn't list "gift-200"/);
    assert.throws(() => planFrom({ use: "buy", shop: SHOP_URL, items: [] }, "Buy coffee", CHOICES), /as a list/);
  });
});

describe("Just ask buying", () => {
  it("shows the planner what your shops sell, and leaves the cart waiting for your board", async () => {
    let seen: Choices | null = null;
    const { store, asker } = setUp(async (said, choices) => {
      seen = choices;
      return planFrom({ use: "buy", shop: SHOP_URL, items: [{ sku: "beans-house", qty: 2 }], say: "Two bags of house blend from Bean & Leaf." }, said, choices);
    });
    const asked = await asker.ask("Buy two bags of house blend", BY);
    const shops = (seen as Choices | null)?.shops ?? [];
    assert.equal(shops[0]?.name, "Bean & Leaf");
    assert.ok(shops[0]?.products.some((product) => product.sku === "beans-decaf"), "the shop's own catalog, as it lists it now");
    assert.equal(asked.plan.use, "buy");
    assert.deepEqual(asked.plan.team, [], "no assistant in between: the shop prices it, the board signs it");
    const run = await stopped(store, asked.run!.runId);
    assert.equal(run.state, "waiting");
    assert.equal(store.waitingApproval(run.id)?.message, "Pay $24.00 to Bean & Leaf: 2× House blend beans, 1 lb");
  });

  it("is planned by Nemotron from what was said, over the shop's real catalog", { skip: !process.env.NEBIUS_API_KEY?.trim() && "set NEBIUS_API_KEY to plan with Nemotron on Token Factory" }, async () => {
    const { store, asker } = setUp(planner({ url: TOKEN_FACTORY_URL, model: NEMOTRON.super, key: process.env.NEBIUS_API_KEY!.trim() }));
    const asked = await asker.ask("Order two bags of the house blend coffee beans and one bag of decaf", BY);
    assert.equal(asked.plan.use, "buy", JSON.stringify(asked.plan));
    assert.ok(asked.plan.say, "Hud says what goes in the cart");
    const run = await stopped(store, asked.run!.runId);
    assert.equal(run.state, "waiting");
    const payment = parseSignable(store.waitingSignRequests()[0]!.text) as Payment;
    assert.deepEqual(
      payment.items.map((item) => [item.name, item.qty]).sort(),
      [
        ["House blend beans, 1 lb", 2],
        ["Swiss water decaf beans, 12 oz", 1],
      ],
    );
    assert.equal(payment.total, "38.00");
  });
});
