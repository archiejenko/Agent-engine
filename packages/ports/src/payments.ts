/**
 * Card payments port (Stripe Checkout). The webhook signature check is REAL code used by both the fake
 * and the real provider: Stripe-Signature "t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>",
 * 5-minute tolerance. ASSUMPTIONS TO VERIFY at cutover: Checkout Session params and event shape.
 */
export interface CheckoutRequest {
  product: "human_report" | "monitoring_monthly";
  amount_gbp: number;
  description: string;
  success_url: string;
  cancel_url: string;
  customer_email?: string;
  metadata: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(r: CheckoutRequest): Promise<{ id: string; url: string }>;
}

export interface CheckoutCompleted {
  event_id: string;
  session_id: string;
  amount_gbp: number;
  customer_email: string | null;
  metadata: Record<string, string>;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signStripePayload(
  rawBody: string,
  secret: string,
  t = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

export class WebhookSignatureError extends Error {}

/** Thrown when card payments are refused because delivery is switched off (kill switch, guardrail 7). */
export class PaymentsPausedError extends Error {}

/** Wraps a provider so no checkout is created while the product can't be delivered. */
export function guardedPayments(
  inner: PaymentProvider,
  allowed: (product: CheckoutRequest["product"]) => Promise<boolean>,
): PaymentProvider {
  return {
    name: inner.name,
    async createCheckout(r) {
      if (!(await allowed(r.product))) throw new PaymentsPausedError(r.product);
      return inner.createCheckout(r);
    },
  };
}

/** Verify and parse a Stripe webhook. Only checkout.session.completed (paid) is returned; others → null. */
export async function verifyStripeWebhook(
  rawBody: string,
  header: string | null,
  secret: string,
  now = Date.now(),
  toleranceSec = 300,
): Promise<CheckoutCompleted | null> {
  if (!header || !secret) throw new WebhookSignatureError("missing signature or secret");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  const sigs = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (!Number.isFinite(t) || sigs.length === 0)
    throw new WebhookSignatureError("malformed signature");
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new WebhookSignatureError("signature too old");
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  // Constant-time comparison.
  const ok = sigs.some(
    (s) =>
      s.length === expected.length &&
      [...s].reduce((acc, c, i) => acc | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0,
  );
  if (!ok) throw new WebhookSignatureError("signature mismatch");
  const event = JSON.parse(rawBody) as {
    id: string;
    type: string;
    data: {
      object: {
        id: string;
        amount_total: number;
        currency: string;
        customer_email?: string | null;
        customer_details?: { email?: string | null };
        metadata?: Record<string, string>;
        payment_status?: string;
      };
    };
  };
  if (event.type !== "checkout.session.completed") return null;
  const o = event.data.object;
  if (o.payment_status !== "paid" || o.currency !== "gbp") return null;
  return {
    event_id: event.id,
    session_id: o.id,
    amount_gbp: o.amount_total / 100,
    customer_email: o.customer_email ?? o.customer_details?.email ?? null,
    metadata: o.metadata ?? {},
  };
}

/** Fake Stripe: sessions in memory; `complete()` produces a correctly signed webhook. */
export class FakeStripe implements PaymentProvider {
  readonly name = "fake-stripe";
  sessions = new Map<string, CheckoutRequest>();
  constructor(private readonly webhookSecret: string) {}
  async createCheckout(r: CheckoutRequest) {
    const id = `cs_test_fake_${crypto.randomUUID().replace(/-/g, "")}`;
    this.sessions.set(id, r);
    return { id, url: `https://checkout.stripe.test/pay/${id}` };
  }
  async complete(
    sessionId: string,
    email = "customer@example.com",
  ): Promise<{ body: string; signature: string }> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error("unknown session");
    const body = JSON.stringify({
      id: `evt_fake_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          amount_total: Math.round(r.amount_gbp * 100),
          currency: "gbp",
          customer_email: r.customer_email ?? email,
          metadata: { ...r.metadata, product: r.product },
          payment_status: "paid",
        },
      },
    });
    return { body, signature: await signStripePayload(body, this.webhookSecret) };
  }
}

/** REAL Stripe Checkout via the REST API (cutover; not yet run live). Secret key = Worker secret. */
export class StripeCheckout implements PaymentProvider {
  readonly name = "stripe";
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async createCheckout(r: CheckoutRequest) {
    const f = new URLSearchParams({
      mode: "payment",
      success_url: r.success_url,
      cancel_url: r.cancel_url,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "gbp",
      "line_items[0][price_data][unit_amount]": String(Math.round(r.amount_gbp * 100)),
      "line_items[0][price_data][product_data][name]": r.description,
      "metadata[product]": r.product,
    });
    for (const [k, v] of Object.entries(r.metadata)) f.set(`metadata[${k}]`, v);
    if (r.customer_email) f.set("customer_email", r.customer_email);
    const res = await this.fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: f,
    });
    const j = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !j.id || !j.url) throw new Error(`Stripe: ${j.error?.message ?? res.status}`);
    return { id: j.id, url: j.url };
  }
}
