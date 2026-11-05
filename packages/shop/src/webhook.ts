import { PayPal } from "@huddle/core";

/**
 * Hooks the shop up to PayPal's webhooks: `npm run paypal:webhook -- https://<your Huddle>/shop/paypal/webhook`
 * adds a webhook for the PayPal app in PAYPAL_CLIENT_ID (or moves the one it has to that address) and prints its
 * id, for PAYPAL_WEBHOOK_ID. PayPal then sends each capture, refund and reversal there, and keeps them as its own
 * record of the app's payments, which Huddle's auditor reads.
 */
export const WEBHOOK_EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;

async function main(): Promise<void> {
  const url = process.argv[2]?.trim() ?? "";
  if (!/^https:\/\/.+\/shop\/paypal\/webhook$/.test(url)) {
    console.error("Give the shop's webhook address: npm run paypal:webhook -- https://<your Huddle>/shop/paypal/webhook");
    process.exit(2);
  }
  const paypal = PayPal.fromEnv(process.env);
  if (!paypal) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (the PayPal app's) first.");
    process.exit(2);
  }
  const theirs = (await paypal.webhooks()).find((hook) => WEBHOOK_EVENTS.every((event) => hook.events.includes(event)));
  if (theirs && theirs.url === url) {
    console.log(`The webhook is already at ${url}.\nPAYPAL_WEBHOOK_ID=${theirs.id}`);
    return;
  }
  if (theirs) {
    await paypal.moveWebhook(theirs.id, url);
    console.log(`Moved the webhook from ${theirs.url} to ${url}.\nPAYPAL_WEBHOOK_ID=${theirs.id}`);
    return;
  }
  const added = await paypal.addWebhook(url, WEBHOOK_EVENTS);
  console.log(`Added a webhook at ${added.url} (PayPal's ${paypal.sandbox ? "sandbox" : "live"}).\nPAYPAL_WEBHOOK_ID=${added.id}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
