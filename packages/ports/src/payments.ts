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
  /** Setup fee now + a monthly subscription (v2 "claim this site"). */
  createSubscriptionCheckout?(r: SubscriptionCheckoutRequest): Promise<{ id: string; url: string }>;
}

export interface SubscriptionCheckoutRequest {
  product: "claim_site";
  setup_fee_gbp: number;
  monthly_gbp: number;
  description: string;
  success_url: string;
  cancel_url: string;
  customer_email: string;
  metadata: Record<string, string>;
}

/**
 * Provider-neutral subscription events. The claim flow only ever sees these, so the Stripe-specific
 * mapping (`toSubscriptionEvent`) is the one place to check against Stripe's docs.
 */
export type SubscriptionEvent =
  | {
      kind: "checkout_completed";
      event_id: string;
      session_id: string;
      subscription_id: string | null;
      amount_gbp: number;
      customer_email: string | null;
      metadata: Record<string, string>;
    }
  | {
      kind: "invoice_paid";
      event_id: string;
      invoice_id: string;
      subscription_id: string;
      amount_gbp: number;
      /** The first invoice is paid in the checkout; only renewals add revenue here. */
      first_invoice: boolean;
    }
  | { kind: "subscription_deleted"; event_id: string; subscription_id: string }
  | {
      kind: "charge_refunded";
      event_id: string;
      charge_id: string;
      amount_refunded_gbp: number;
      subscription_id: string | null;
      metadata: Record<string, string>;
    };

/** The Stripe-specific code isn't checked against current docs yet; it refuses to call Stripe until it is. */
export class NotVerifiedError extends Error {}

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
  allowed: (
    product: CheckoutRequest["product"] | SubscriptionCheckoutRequest["product"],
  ) => Promise<boolean>,
): PaymentProvider {
  return {
    name: inner.name,
    async createCheckout(r) {
      if (!(await allowed(r.product))) throw new PaymentsPausedError(r.product);
      return inner.createCheckout(r);
    },
    async createSubscriptionCheckout(r) {
      if (!(await allowed(r.product))) throw new PaymentsPausedError(r.product);
      if (!inner.createSubscriptionCheckout) throw new NotVerifiedError("no subscription checkout");
      return inner.createSubscriptionCheckout(r);
    },
  };
}

/** Checks a Stripe-Signature header (HMAC-SHA256 over `${t}.${body}`, 5-minute tolerance). */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now = Date.now(),
  toleranceSec = 300,
): Promise<void> {
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
  const ok = sigs.some(
    (s) =>
      s.length === expected.length &&
      [...s].reduce((acc, c, i) => acc | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0,
  );
  if (!ok) throw new WebhookSignatureError("signature mismatch");
}

/**
 * Maps a (signature-checked) Stripe event to a SubscriptionEvent, or null for anything else.
 * UNVERIFIED: field names follow the shape this codebase already assumes for Checkout; Stripe's docs
 * were unreachable from the build environment. Check every field here before the first test-mode run.
 */
export function toSubscriptionEvent(rawBody: string): SubscriptionEvent | null {
  const ev = JSON.parse(rawBody) as {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  };
  const o = ev.data?.object ?? {};
  const meta = (o.metadata as Record<string, string> | undefined) ?? {};
  const gbp = (pence: unknown) => (typeof pence === "number" ? pence / 100 : 0);
  switch (ev.type) {
    case "checkout.session.completed":
      if (o.mode !== "subscription" || o.currency !== "gbp") return null;
      return {
        kind: "checkout_completed",
        event_id: ev.id,
        session_id: String(o.id),
        subscription_id: (o.subscription as string | null) ?? null,
        amount_gbp: gbp(o.amount_total),
        customer_email:
          (o.customer_email as string | null) ??
          (o.customer_details as { email?: string } | undefined)?.email ??
          null,
        metadata: meta,
      };
    case "invoice.paid":
      if (o.currency !== "gbp" || !o.subscription) return null;
      return {
        kind: "invoice_paid",
        event_id: ev.id,
        invoice_id: String(o.id),
        subscription_id: String(o.subscription),
        amount_gbp: gbp(o.amount_paid),
        first_invoice: o.billing_reason === "subscription_create",
      };
    case "customer.subscription.deleted":
      return { kind: "subscription_deleted", event_id: ev.id, subscription_id: String(o.id) };
    case "charge.refunded":
      return {
        kind: "charge_refunded",
        event_id: ev.id,
        charge_id: String(o.id),
        amount_refunded_gbp: gbp(o.amount_refunded),
        subscription_id: (meta.subscription_id as string | undefined) ?? null,
        metadata: meta,
      };
    default:
      return null;
  }
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
  subscriptionSessions = new Map<string, SubscriptionCheckoutRequest>();
  constructor(private readonly webhookSecret: string) {}

  async createSubscriptionCheckout(r: SubscriptionCheckoutRequest) {
    const id = `cs_test_fake_${crypto.randomUUID().replace(/-/g, "")}`;
    this.subscriptionSessions.set(id, r);
    return { id, url: `https://checkout.stripe.test/pay/${id}` };
  }

  private async signed(type: string, object: Record<string, unknown>) {
    const body = JSON.stringify({
      id: `evt_fake_${crypto.randomUUID().replace(/-/g, "")}`,
      type,
      data: { object },
    });
    return { body, signature: await signStripePayload(body, this.webhookSecret) };
  }

  /** The customer pays: setup fee + first month. Returns the webhook and the subscription id. */
  async completeSubscription(sessionId: string) {
    const r = this.subscriptionSessions.get(sessionId);
    if (!r) throw new Error("unknown session");
    const subscription = `sub_test_fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      subscription,
      ...(await this.signed("checkout.session.completed", {
        id: sessionId,
        mode: "subscription",
        subscription,
        amount_total: Math.round((r.setup_fee_gbp + r.monthly_gbp) * 100),
        currency: "gbp",
        customer_email: r.customer_email,
        metadata: { ...r.metadata, product: r.product },
        payment_status: "paid",
      })),
    };
  }
  invoicePaid(subscription: string, amountGbp: number, first = false) {
    return this.signed("invoice.paid", {
      id: `in_test_fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      subscription,
      amount_paid: Math.round(amountGbp * 100),
      currency: "gbp",
      billing_reason: first ? "subscription_create" : "subscription_cycle",
    });
  }
  subscriptionDeleted(subscription: string) {
    return this.signed("customer.subscription.deleted", { id: subscription, status: "canceled" });
  }
  chargeRefunded(subscription: string, amountGbp: number) {
    return this.signed("charge.refunded", {
      id: `ch_test_fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      amount_refunded: Math.round(amountGbp * 100),
      metadata: { subscription_id: subscription },
    });
  }
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

  /**
   * NOT BUILT YET: subscription-mode Checkout (setup fee + recurring price) must be written against
   * Stripe's current docs, which were unreachable from the build environment. Until then this refuses,
   * so nothing unverified ever reaches Stripe. See the Milestone A report.
   */
  async createSubscriptionCheckout(
    _r: SubscriptionCheckoutRequest,
  ): Promise<{ id: string; url: string }> {
    throw new NotVerifiedError(
      "subscription Checkout isn't built against Stripe's current docs yet (blocked from the build environment)",
    );
  }
}

/** v2 rule 9: Stripe runs in test mode only. Live keys are refused until Archie lifts this in code review. */
export function assertStripeTestMode(secretKey: string) {
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_"))
    throw new Error("Stripe is test mode only in this build (v2 rule 9): use an sk_test_ key");
}
