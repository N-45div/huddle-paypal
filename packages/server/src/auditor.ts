import { amountText, audit, chargesFromEvents, type Finding, flagged, type PayPal, type PayPalCharge, type Store, thinkingFor } from "@huddle/core";

/**
 * The auditor at work: every so often (and when you ask), it reads PayPal's own record of the shop's charges and
 * checks each against what your boards signed. A flagged charge gets a dispute drafted for it, by a model when
 * one is set up, ready to send PayPal. PayPal's record is the events it made for the app's webhooks, which cover
 * every capture however it was made, plus a look at each order Huddle paid; without a webhook, only the latter.
 */

const DAYS = 30;
const WEBHOOK_HINT = "PayPal's record of every charge needs a webhook on the PayPal app (npm run paypal:webhook -- https://<your Huddle>/shop/paypal/webhook); until then, only the orders Huddle paid are checked.";

export interface AuditView {
  readonly checkedAt: string | null;
  /** Whether PayPal's events were read (a webhook is set up), or only the orders Huddle paid. */
  readonly events: boolean;
  /** What wasn't checked, or why the check didn't finish. */
  readonly note: string | null;
  readonly findings: readonly (Finding & { readonly draft: string | null; readonly flagged: boolean })[];
}

/** The facts a dispute is written from: never more than the auditor knows. */
export interface DisputeFacts {
  readonly merchant: string;
  readonly finding: Finding;
}

export type DisputeWriter = (facts: DisputeFacts) => Promise<string>;

/** A dispute in plain words, from the facts alone: the fallback when no model is set up. */
export function disputeTemplate({ merchant, finding }: DisputeFacts): string {
  const { charge } = finding;
  const amount = amountText(charge.amount, charge.currency || "USD");
  const when = charge.at.slice(0, 10);
  const what =
    finding.verdict === "mismatch"
      ? `The amount doesn't match what I authorized: ${finding.why.replace(/^PayPal took [^,]+, but /, "").replace(/\.$/, "")}.`
      : "I didn't authorize it: every purchase I make there is signed on my own device first, and no signature of mine is behind this charge.";
  return `I'm disputing a charge of ${amount} by ${merchant} on ${when} (PayPal transaction ${charge.captureId}${charge.orderId ? `, order ${charge.orderId}` : ""}). ${what} Please reverse the charge.`;
}

const GUIDE = `You write the message a person sends PayPal's Resolution Center to dispute a charge to their PayPal account. Write it in the first person, plainly, in four or five sentences: the merchant, the date, the amount and PayPal's transaction id, then what's wrong with the charge, then ask PayPal to reverse it. Use only the facts you're given; never add any. No greeting, no sign-off, no placeholders, no markdown.`;

/** Drafts disputes with a model (Nemotron on Token Factory, say); the template if the model fails. */
export function disputeWriter(options: { readonly url: string; readonly model: string; readonly key?: string; readonly fetcher?: typeof fetch }): DisputeWriter {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  return async (facts) => {
    const { charge } = facts.finding;
    const given = {
      merchant: facts.merchant,
      date: charge.at.slice(0, 10),
      amount: amountText(charge.amount, charge.currency || "USD"),
      paypalTransactionId: charge.captureId,
      paypalOrderId: charge.orderId,
      whatsWrong: facts.finding.verdict === "mismatch" ? `the amount doesn't match what I authorized (${facts.finding.why})` : "I didn't authorize it: I sign every purchase there on my own device first, and no signature of mine is behind this charge",
    };
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
        body: JSON.stringify({ model: options.model, messages: [{ role: "system", content: GUIDE }, { role: "user", content: JSON.stringify(given) }], temperature: 0.2, max_tokens: 300, ...thinkingFor(options.url, false) }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const text = body?.choices?.[0]?.message?.content;
      // A draft that leaves out the transaction id or the amount isn't one to send.
      if (response.ok && typeof text === "string" && text.includes(charge.captureId) && text.includes(charge.amount)) return text.trim();
    } catch {
      // The template, then.
    }
    return disputeTemplate(facts);
  };
}

export class Auditor {
  private readonly store: Store;
  private readonly paypal: PayPal;
  private readonly writer: DisputeWriter;
  private readonly merchant: string;
  private running: Promise<AuditView> | null = null;

  constructor(store: Store, paypal: PayPal, options: { readonly writer?: DisputeWriter; readonly merchant?: string } = {}) {
    this.store = store;
    this.paypal = paypal;
    this.writer = options.writer ?? (async (facts) => disputeTemplate(facts));
    this.merchant = options.merchant ?? "the merchant";
  }

  /** What the auditor last found. */
  view(): AuditView {
    return {
      checkedAt: this.store.setting("audit.checked_at"),
      events: this.store.setting("audit.events") === "yes",
      note: this.store.setting("audit.note") || null,
      findings: this.store.findings().map((finding) => ({ ...finding, flagged: flagged(finding) })),
    };
  }

  /** Checks now; a check already under way is the one answered. */
  run(): Promise<AuditView> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<AuditView> {
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    const charges: PayPalCharge[] = [];
    let events = false;
    let note: string | null = null;
    try {
      if ((await this.paypal.webhooks()).length > 0) {
        charges.push(...chargesFromEvents(await this.paypal.events({ since })));
        events = true;
      } else {
        note = WEBHOOK_HINT;
      }
    } catch (error) {
      note = `PayPal's events couldn't be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Each order Huddle paid, as PayPal has it now: a refund or reversal since, or an amount that changed, shows.
    for (const request of this.store.signRequests(100, "buy")) {
      const orderId = (request.result as { paypal?: { orderId?: unknown } } | null)?.paypal?.orderId;
      if (request.status !== "paid" || typeof orderId !== "string") continue;
      try {
        const order = await this.paypal.order(orderId);
        for (const capture of order.captures) charges.push({ captureId: capture.id, orderId: order.id, invoiceId: order.invoiceId, amount: capture.amount.value, currency: capture.amount.currency_code, status: capture.status, at: capture.at });
      } catch (error) {
        note = `PayPal couldn't say how order ${orderId} stands: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const known = new Map(this.store.findings().map((finding) => [finding.charge.captureId, finding]));
    for (const finding of audit(this.store, charges)) {
      const draft = flagged(finding) && !known.get(finding.charge.captureId)?.draft ? await this.writer({ merchant: this.merchant, finding }) : undefined;
      this.store.saveFinding(finding, draft);
    }
    this.store.saveSetting("audit.checked_at", new Date().toISOString());
    this.store.saveSetting("audit.events", events ? "yes" : "no");
    this.store.saveSetting("audit.note", note ?? "");
    this.store.audited();
    return this.view();
  }
}
