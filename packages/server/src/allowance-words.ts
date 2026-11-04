import { cents, decimal, MAX_ALLOWANCE_DAYS, type Period, PERIODS, thinkingFor } from "@huddle/core";
import { jsonIn } from "./describe.ts";

/**
 * An allowance from what you say ("groceries up to $20 each, $50 a week"): a model writes the exact limits, and
 * your board shows them before you sign. Whatever the model writes, the board's screen is what you agree to.
 */

export interface Limits {
  readonly for: string;
  readonly each: string;
  readonly total: string;
  readonly per: Period;
  readonly days: number;
}

export type LimitsWriter = (said: string) => Promise<Limits>;

const GUIDE = `You turn what the person says into an allowance: how much their assistant Huddle may spend at a shop on its own, without asking them each time. Answer with JSON only:
{"for": "<what it's for, in 1 to 4 words, like Groceries>", "each": "<the most for one payment, like 20.00>", "total": "<the most for all payments in a period, like 50.00>", "per": "day" | "week" | "month", "days": <how many days it lasts, from 1 to ${MAX_ALLOWANCE_DAYS}>}
Amounts are plain numbers with two decimals, no currency sign. When they give one amount, it's both "each" and "total". When they don't say a period, it's "week". When they don't say how long, "days" is 30. "each" is never more than "total".`;

/** The limits from the model's answer, checked: amounts, a period, and a length Huddle allows. */
export function limitsFrom(answer: unknown): Limits {
  const { for: label, each, total, per, days } = (answer ?? {}) as Record<string, unknown>;
  const amount = (value: unknown) => (typeof value === "number" ? cents(value.toFixed(2)) : typeof value === "string" ? cents(value.replace(/^\$/, "").trim()) : null);
  const eachCents = amount(each);
  const totalCents = amount(total) ?? eachCents;
  if (eachCents === null || eachCents === 0 || totalCents === null || totalCents === 0) throw new Error("The allowance needs amounts: the most for one payment, and the most in all.");
  if (typeof per !== "string" || !(per in PERIODS)) throw new Error("The allowance's limit runs per day, week or month.");
  const length = typeof days === "number" && Number.isInteger(days) ? days : 30;
  const name = typeof label === "string" && label.trim() ? label.trim().replace(/\s+/g, " ").slice(0, 40) : "Shopping";
  return { for: name, each: decimal(Math.min(eachCents, totalCents)), total: decimal(totalCents), per: per as Period, days: Math.min(Math.max(length, 1), MAX_ALLOWANCE_DAYS) };
}

export function limitsWriter(options: { readonly url: string; readonly model: string; readonly key?: string; readonly fetcher?: typeof fetch }): LimitsWriter {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  return async (said) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: GUIDE },
          { role: "user", content: said.slice(0, 500) },
        ],
        temperature: 0,
        max_tokens: 200,
        ...thinkingFor(options.url, false),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
    if (!response.ok) {
      const why = body?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`The model said: ${options.key ? why.replaceAll(options.key, "[key]") : why}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("The model sent an empty answer.");
    return limitsFrom(jsonIn(content));
  };
}
