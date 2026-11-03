import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Assistant, Engine, mock, parseFlow, parseSignable, type Payment, shopClient, Store } from "@huddle/core";
import { demoShop } from "@huddle/shop";
import { createApp } from "../src/app.ts";
import { buyFlow, knownShops, linesFrom, pickShop } from "../src/shops.ts";

/**
 * Agents shopping through Huddle, against Bean & Leaf itself (the demo shop, answering in this process): they
 * search the shops you have and put a cart together; the cart waits for your board, and nothing is paid without it.
 */
const SHOP_URL = "http://localhost:7700/shop";
const TOKEN = "test-token-0123456789";
const OWNER = "a2a-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body: unknown) => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

function setUp() {
  const shop = demoShop({ HUDDLE_SHOP: "on" }, { publicUrl: SHOP_URL, db: ":memory:" })!;
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.app.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: (url) => shopClient(url, reach) });
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, a2aToken: OWNER, shop: SHOP_URL });
  return { store, engine, app };
}

function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

/** One MCP tool call, the way Claude Code sends it. */
async function tool(app: ReturnType<typeof setUp>["app"], name: string, args: object, token = OWNER) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? "tools/list" : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }),
  });
  return (await response.json()) as { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> }; annotations?: object }[] }; error?: { message: string } };
}
const said = (reply: Awaited<ReturnType<typeof tool>>) => reply.result?.content?.map((part) => part.text).join("\n") ?? reply.error?.message ?? "";

describe("the shops Huddle buys at", () => {
  it("are the demo shop and the shops among your assistants and flows, each once", () => {
    const store = new Store();
    store.saveAssistants([Assistant.parse({ id: "corner", connector: "shop", url: "https://corner.example/shop" })]);
    store.saveFlow(parseFlow({ name: "Beans", assistants: [{ id: "beans", connector: "shop", url: `${SHOP_URL}/` }], steps: [{ id: "pay", type: "pay", shop: "beans", cart: "[]" }] }));
    assert.deepEqual(knownShops(store, SHOP_URL), [SHOP_URL, "https://corner.example/shop"]);
    assert.deepEqual(knownShops(new Store()), []);
  });

  it("are the only ones a cart goes to: a page or a message can't name a new one", () => {
    assert.equal(pickShop([SHOP_URL], undefined), SHOP_URL);
    assert.equal(pickShop([SHOP_URL], `${SHOP_URL}/`), SHOP_URL);
    assert.throws(() => pickShop([SHOP_URL], "https://bean-and-leaf.example/shop"), /only buys at shops you have/);
    assert.throws(() => pickShop([SHOP_URL, "https://corner.example/shop"], undefined), /Say which shop/);
    assert.throws(() => pickShop([], undefined), /knows no shops yet/);
  });

  it("take a cart of skus and whole quantities, each sku once", () => {
    assert.deepEqual(linesFrom([{ sku: "beans-house", qty: 2 }, { sku: "beans-house" }, { sku: "mug", qty: 1 }]), [{ sku: "beans-house", qty: 3 }, { sku: "mug", qty: 1 }]);
    assert.throws(() => linesFrom([]), /as a list/);
    assert.throws(() => linesFrom([{ sku: "Beans House" }]), /sku/);
    assert.throws(() => linesFrom([{ sku: "mug", qty: 1.5 }]), /whole quantity/);
    assert.throws(() => linesFrom(Array.from({ length: 13 }, (_, n) => ({ sku: `thing-${n}` }))), /at most 12/);
    const flow = buyFlow(SHOP_URL, "Bean & Leaf", [{ sku: "mug", qty: 1 }], "A mug for the office");
    assert.deepEqual(flow.steps.map((step) => step.type), ["pay"], "a cart and the board's signature: no assistant in between");
  });
});

describe("shopping in the API", () => {
  it("searches your shops, and a cart waits for your board", async () => {
    const { app, store } = setUp();
    assert.deepEqual(await (await app.request("/api/shops", { headers: auth })).json(), [SHOP_URL]);
    const found = (await (await app.request("/api/shops/search?q=decaf", { headers: auth })).json()) as { url: string; shop: { name: string }; products: { sku: string }[] }[];
    assert.equal(found[0]?.shop.name, "Bean & Leaf");
    assert.ok(found[0]?.products.some((product) => product.sku === "beans-decaf"));

    const bought = await app.request("/api/shops/buy", post({ items: [{ sku: "beans-house", qty: 2 }], why: "Coffee for the week", via: "webmcp" }));
    assert.equal(bought.status, 202);
    const view = (await bought.json()) as { runId: string; state: string; waiting: { signId: string; line: string } };
    assert.equal(view.state, "waiting");
    assert.equal(view.waiting.line, "Pay $24.00 to Bean & Leaf: 2× House blend beans, 1 lb");
    assert.equal((parseSignable(store.signRequest(view.waiting.signId)!.text) as Payment).total, "24.00");
    assert.deepEqual(store.logOf(view.runId).find((line) => line.kind === "started")?.detail, { name: "You", tier: "owner", via: "webmcp" });
    // It's an approval nothing but a signature says yes to.
    const [approval] = (await (await app.request("/api/approvals", { headers: auth })).json()) as { id: string }[];
    assert.equal((await app.request(`/api/approvals/${approval!.id}`, post({ yes: true }))).status, 409);

    assert.equal((await app.request("/api/shops/buy", post({ items: [{ sku: "mug" }], shop: "https://bean-and-leaf.example/shop" }))).status, 400);
    assert.equal((await app.request("/api/shops/buy", post({ items: "two coffees" }))).status, 400);
    assert.equal((await app.request("/api/shops/buy", { method: "POST" })).status, 401, "behind the Huddle token");
  });
});

describe("shopping over MCP", () => {
  it("is yours alone: a contact sees no shop tools", async () => {
    const { app, store } = setUp();
    const owner = (await tool(app, "tools/list", {})).result?.tools ?? [];
    const search = owner.find((one) => one.name === "shop_search");
    assert.ok(search, "the owner can search");
    assert.deepEqual(search.inputSchema.properties.shop?.enum, [SHOP_URL]);
    assert.deepEqual(search.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.ok(owner.some((one) => one.name === "shop_buy"));
    const friend = store.addContact({ name: "Asha", tier: "friend" });
    const theirs = (await tool(app, "tools/list", {}, friend.token)).result?.tools ?? [];
    assert.ok(!theirs.some((one) => one.name.startsWith("shop_")));
    assert.match(said(await tool(app, "shop_buy", { items: [{ sku: "mug" }] }, friend.token)), /no tool "shop_buy"/);
  });

  it("finds products, puts a cart in front of your board, and says what came of it", async () => {
    const { app, store, engine } = setUp();
    const found = said(await tool(app, "shop_search", { query: "decaf" }));
    assert.match(found, /^Bean & Leaf \(http:\/\/localhost:7700\/shop\):\n- beans-decaf: Swiss water decaf beans, 12 oz, \$14\.00/);
    assert.match(found, /board signs the exact cart/);

    const asked = said(await tool(app, "shop_buy", { items: [{ sku: "beans-decaf", qty: 1 }], why: "Decaf for the evenings" }));
    assert.match(asked, /^Waiting for the owner's board to sign it: Pay \$14\.00 to Bean & Leaf: 1× Swiss water decaf beans, 12 oz\. Nothing is paid until they hold their board's button for two seconds \(or on the virtual board in Huddle: http:\/\/huddle\.test\/#\/devices\)\./);
    const runId = /Run id: (run_\w+)/.exec(asked)?.[1];
    assert.ok(runId);
    assert.match(said(await tool(app, "get_run", { run_id: runId })), /^Waiting for the owner's board to sign it/);

    // The board signs; this test board isn't linked to a PayPal at the shop, so the shop says no, and get_run says why.
    const mine = board();
    store.addSigner({ key: mine.key, name: "Desk button" });
    const request = store.waitingSignRequests()[0]!;
    engine.sign(request.id, mine.sign(request.text), mine.key);
    for (let tries = 0; tries < 100 && ["waiting", "running"].includes(store.run(runId)?.state ?? ""); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(said(await tool(app, "get_run", { run_id: runId })), /The run failed: The shop didn't take the payment: This board isn't linked to a PayPal at Bean & Leaf/);

    assert.match(said(await tool(app, "shop_buy", { items: [{ sku: "mug" }], shop: "https://elsewhere.example/shop" })), /only buys at shops you have/);
    assert.match(said(await tool(app, "shop_buy", { items: [{ sku: "nothing-like-it", qty: 1 }] })), /nothing-like-it|isn't sold|doesn't sell/i);
  });
});
