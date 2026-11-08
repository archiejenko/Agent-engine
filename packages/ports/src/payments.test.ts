import { describe, expect, it } from "vitest";
import {
  FakeStripe,
  guardedPayments,
  PaymentsPausedError,
  StripeCheckout,
  signStripePayload,
  verifyStripeWebhook,
  WebhookSignatureError,
} from "./payments.ts";

it("Stripe webhooks: valid signatures pass; tampered, wrong-secret and stale ones fail", async () => {
  const s = new FakeStripe("whsec_test");
  const { id } = await s.createCheckout({
    product: "human_report",
    amount_gbp: 9,
    description: "Report",
    success_url: "https://x/ok",
    cancel_url: "https://x/no",
    metadata: { company_number: "01234567" },
  });
  const { body, signature } = await s.complete(id, "a@b.example");
  const ev = await verifyStripeWebhook(body, signature, "whsec_test");
  expect(ev).toMatchObject({
    session_id: id,
    amount_gbp: 9,
    customer_email: "a@b.example",
    metadata: { company_number: "01234567", product: "human_report" },
  });
  await expect(
    verifyStripeWebhook(
      body.replace('"amount_total":900', '"amount_total":1'),
      signature,
      "whsec_test",
    ),
  ).rejects.toThrow(WebhookSignatureError);
  await expect(verifyStripeWebhook(body, signature, "whsec_other")).rejects.toThrow(/mismatch/);
  const old = await signStripePayload(body, "whsec_test", Math.floor(Date.now() / 1000) - 3600);
  await expect(verifyStripeWebhook(body, old, "whsec_test")).rejects.toThrow(/too old/);
});

it("real Stripe Checkout sends a form-encoded session with GBP line item and metadata", async () => {
  let sent = "";
  const s = new StripeCheckout("sk_test_x", (async (_u: string, init?: RequestInit) => {
    sent = String(init?.body);
    return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
  }) as unknown as typeof fetch);
  expect(
    await s.createCheckout({
      product: "human_report",
      amount_gbp: 9,
      description: "Company check",
      success_url: "https://a",
      cancel_url: "https://b",
      metadata: { company_number: "01234567" },
    }),
  ).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
  expect(sent).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=900");
  expect(sent).toContain("metadata%5Bcompany_number%5D=01234567");
});

describe("guardedPayments (kill switch)", () => {
  it("refuses to create a checkout while the product can't be delivered", async () => {
    const inner = new FakeStripe("whsec_t");
    let allowed = false;
    const p = guardedPayments(inner, async () => allowed);
    const req = {
      product: "human_report" as const,
      amount_gbp: 9,
      description: "x",
      success_url: "http://x/thanks",
      cancel_url: "http://x/",
      metadata: {},
    };
    await expect(p.createCheckout(req)).rejects.toBeInstanceOf(PaymentsPausedError);
    allowed = true;
    await expect(p.createCheckout(req)).resolves.toHaveProperty("url");
  });
});
