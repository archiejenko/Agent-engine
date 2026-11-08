import type { InfraConfig, ProductsConfig } from "@ae/config";
import { createTask, type LoadedPlaybook } from "@ae/infra";
import type { CheckoutCompleted, QueueBus } from "@ae/ports";
import type { Storage } from "@ae/storage";

/**
 * A paid Stripe Checkout → work + revenue. Idempotent on the Checkout Session id (Stripe retries
 * webhooks): the ledger reference and the task's idempotency key are both the session id.
 */
export async function handleCheckoutCompleted(
  storage: Storage,
  infra: InfraConfig,
  products: ProductsConfig,
  playbooks: Map<string, LoadedPlaybook>,
  queue: QueueBus,
  ev: CheckoutCompleted,
) {
  const product = ev.metadata.product;
  const firstTime = await storage.ledger.record({
    rail: "stripe",
    reference: ev.session_id,
    payer: ev.customer_email,
    amount_gbp: ev.amount_gbp,
    currency_amount: `${ev.amount_gbp.toFixed(2)} GBP`,
    dry_run: ev.session_id.startsWith("cs_test_"),
    task_id: null,
  });
  if (product === "human_report") {
    const n = (ev.metadata.company_number ?? "").toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(n) || !ev.customer_email)
      throw new Error("checkout is missing the company number or email");
    const { task, created } = await createTask(storage, infra, playbooks, queue, {
      idempotency_key: `stripe:${ev.session_id}`,
      playbook: "human_report",
      revenue_path: "human_check",
      source_ref: `stripe:${ev.session_id}:entity:${n}`,
      lane: "open",
      state: { company_number: n, email: ev.customer_email },
    });
    if (created && firstTime) await storage.tasks.addRevenue(task.task_id, ev.amount_gbp);
    return { kind: "human_report" as const, task_id: task.task_id, created };
  }
  if (product === "monitoring_monthly") {
    const entities = (ev.metadata.company_numbers ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z0-9]{8}$/.test(x));
    const { task, created } = await createTask(storage, infra, playbooks, queue, {
      idempotency_key: `stripe:${ev.session_id}`,
      playbook: "monitoring_subscription",
      revenue_path: "monitoring",
      source_ref: `stripe:${ev.session_id}`,
      lane: "open",
    });
    if (created && firstTime) {
      await storage.tasks.addRevenue(task.task_id, ev.amount_gbp);
      const customer = await storage.customers.add({
        name: ev.metadata.customer_name ?? ev.customer_email ?? "customer",
        email: ev.customer_email ?? "",
        plan: "monthly",
        payment_ref: ev.session_id,
      });
      const channel = ev.metadata.webhook_url ? "webhook" : "email";
      for (const e of entities) {
        await storage.watches.add({
          customer_id: customer,
          entity_id: e,
          fields: [
            "company_status",
            "officers_active",
            "psc_active",
            "charges",
            "accounts_overdue",
            "registered_office_address",
          ],
          channel,
          target: ev.metadata.webhook_url ?? ev.customer_email ?? "",
        });
      }
    }
    return {
      kind: "monitoring_monthly" as const,
      task_id: task.task_id,
      created,
      watches: entities.length,
    };
  }
  return {
    kind: "ignored" as const,
    product: product ?? null,
    monthly_gbp: products.monitoring.monthly_gbp,
  };
}
