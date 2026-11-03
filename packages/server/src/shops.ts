import { type CartLine, type Engine, type Flow, MAX_ITEMS, type Payee, type ShopProduct, type StartedBy, type Store } from "@huddle/core";
import { checkFlow } from "./app.ts";
import { settled } from "./callers.ts";

/**
 * Buying from outside the canvas (an MCP client, a browser agent through WebMCP, Just ask): the shops Huddle
 * knows of, and a one-off flow that buys a cart at one. Whoever asks only puts the cart together: the flow's pay
 * step has the shop price it, and nothing is paid until your board signs that exact cart, as with any payment.
 */

/** The shops Huddle knows of, by address: the demo shop it opens, then each shop among your assistants and flows. */
export function knownShops(store: Store, demo?: string): string[] {
  const urls = [
    ...(demo ? [demo] : []),
    ...store.assistants().flatMap((assistant) => (assistant.connector === "shop" && assistant.url ? [assistant.url] : [])),
    ...store.flows().flatMap((saved) => saved.flow.assistants.flatMap((assistant) => (assistant.connector === "shop" && assistant.url ? [assistant.url] : []))),
  ];
  const seen = new Set<string>();
  return urls.filter((url) => {
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cart lines from what was sent: [{ sku, qty }], at most MAX_ITEMS of them, each sku once, 1 to 99 of each. */
export function linesFrom(value: unknown): CartLine[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Give the items as a list, like [{ "sku": "beans-house", "qty": 2 }].');
  const lines = new Map<string, number>();
  for (const item of value) {
    const { sku, qty } = (item ?? {}) as { sku?: unknown; qty?: unknown };
    if (typeof sku !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(sku)) throw new Error("Each item needs the sku the shop listed it with.");
    const count = qty === undefined ? 1 : qty;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 99) throw new Error(`"${sku}" needs a whole quantity from 1 to 99.`);
    lines.set(sku, (lines.get(sku) ?? 0) + count);
  }
  if (lines.size > MAX_ITEMS) throw new Error(`A cart has at most ${MAX_ITEMS} different things in it.`);
  return [...lines].map(([sku, qty]) => ({ sku, qty }));
}

/**
 * A flow, run once and never saved, that buys these lines at a shop: the shop prices the cart, your board is asked
 * to sign it, and once signed the shop charges your PayPal. `why` is what was asked for, kept as the run's input.
 */
export function buyFlow(shopUrl: string, shopName: string, lines: readonly CartLine[], why: string): Flow {
  const checked = checkFlow({
    name: `Buy at ${shopName}`.slice(0, 80),
    description: why.slice(0, 500) || `A cart at ${shopName}, for your board to sign.`,
    trigger: { type: "manual" },
    assistants: [{ id: "shop", name: shopName.slice(0, 60), connector: "shop", url: shopUrl }],
    steps: [{ id: "pay", type: "pay", shop: "shop", cart: JSON.stringify(lines) }],
  });
  if ("problems" in checked) throw new Error(`That cart didn't make a flow: ${checked.problems.join("; ")}`);
  return checked.flow;
}

/** The shop asked for (its address), out of the ones Huddle knows; the only one, when none is named. */
export function pickShop(shops: readonly string[], given: unknown): string {
  if (shops.length === 0) throw new Error("Huddle knows no shops yet: open the demo shop (set PayPal's keys, or HUDDLE_SHOP=on), or add a shop assistant.");
  if (typeof given !== "string" || !given.trim()) {
    if (shops.length === 1) return shops[0]!;
    throw new Error(`Say which shop, by its address: ${shops.join(", ")}.`);
  }
  const wanted = given.trim().replace(/\/+$/, "");
  const found = shops.find((url) => url.replace(/\/+$/, "") === wanted);
  // Only a shop you already have: a page or a message can't send your assistants to buy somewhere new.
  if (!found) throw new Error(`Huddle only buys at shops you have, and "${given.trim().slice(0, 100)}" isn't one. Your shops: ${shops.join(", ")}.`);
  return found;
}

export interface Found {
  readonly url: string;
  readonly shop: Payee;
  readonly products: readonly ShopProduct[];
}

/** What a shop (or each shop you have, up to three, when none is named) sells that fits what's asked. */
export async function searchShops(engine: Engine, shops: readonly string[], query: string, given?: unknown): Promise<Found[]> {
  const urls = typeof given === "string" && given.trim() ? [pickShop(shops, given)] : shops.slice(0, 3);
  if (!urls.length) pickShop(shops, given);
  return Promise.all(urls.map(async (url) => ({ url, ...(await engine.shop(url).search(query.slice(0, 500), 8)) })));
}

/** What a search found, for an agent to read: each shop by name and address, then each product's sku, name and price. */
export function foundText(found: readonly Found[]): string {
  const blocks = found.map(({ url, shop, products }) => {
    const lines = products.map((product) => `- ${product.sku}: ${product.name}, ${product.currency === "USD" ? `$${product.price}` : `${product.price} ${product.currency}`}`);
    return `${shop.name} (${url}):\n${lines.join("\n") || "- nothing that fits"}`;
  });
  return blocks.join("\n\n");
}

export interface Bought {
  readonly runId: string;
  /** Where the run is: waiting (for your board), or failed, with why. */
  readonly state: string;
  /** The payment waiting for your board: its id and its line ("Pay $24.00 to Bean & Leaf: 2× House blend"). */
  readonly waiting: { readonly signId: string; readonly line: string } | null;
  readonly error: string | null;
}

/**
 * Starts buying a cart at a shop you have: the shop prices it and your board is asked to sign it. Waits (up to
 * `waitMs`) until the payment is waiting for your board, then says so; nothing is paid before the board signs.
 */
export async function startBuy(
  store: Store,
  engine: Engine,
  shops: readonly string[],
  input: { readonly shop?: unknown; readonly items: unknown; readonly why?: unknown },
  by: StartedBy,
  waitMs = 15_000,
): Promise<Bought> {
  const lines = linesFrom(input.items);
  const url = pickShop(shops, input.shop);
  const about = await engine.shop(url).about();
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 500) : "";
  const asked = why || `Buy ${lines.map((line) => `${line.qty} × ${line.sku}`).join(", ")} at ${about.shop.name}`;
  const runId = engine.launch(buyFlow(url, about.shop.name, lines, why), asked, null, by);
  await settled(store, runId, waitMs);
  const run = store.run(runId)!;
  const approval = run.state === "waiting" ? store.waitingApproval(runId) : null;
  return { runId, state: run.state, waiting: approval?.signs ? { signId: approval.signs, line: approval.message } : null, error: run.error };
}
