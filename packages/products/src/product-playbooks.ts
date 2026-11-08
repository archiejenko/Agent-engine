import type { InfraConfig, ProductsConfig } from "@ae/config";
import type { PlaybookImpl, RoleImpl, ToolRegistry } from "@ae/infra";
import type { AlertChannel, EmailSender } from "@ae/ports";
import type { Storage, WatchRow } from "@ae/storage";
import type { VerificationContext } from "@ae/verification";
import { type CompanyCheck, companyCheck } from "./check.ts";
import { renderReport } from "./report.ts";

/** Tools for the product playbooks. company_check is internal; send_report / send_alert are external. */
export function registerProductTools(
  registry: ToolRegistry,
  d: {
    storage: Storage;
    ctx: VerificationContext;
    email: EmailSender;
    alerts: AlertChannel;
    infra: InfraConfig;
    products: ProductsConfig;
  },
) {
  registry.register(
    {
      name: "company_check",
      description: "Open-lane company check (human_check caller).",
      allowed_lanes: ["open"],
      external: false,
      serves_customer: false,
      allowed_roles: ["researcher", "checker"],
      rate_limit_per_min: 600,
      cost_gbp_per_call: 0,
    },
    async (args) => ({
      result: await companyCheck(
        d.storage,
        d.ctx,
        String((args as { company_number: string }).company_number),
        { tier: "cached", caller: "human_check" },
      ),
    }),
  );
  registry.register(
    {
      name: "send_report",
      description: "Email a paid report to the customer who bought it (transactional).",
      allowed_lanes: ["open"],
      external: true,
      serves_customer: true,
      allowed_roles: ["operator"],
      rate_limit_per_min: 60,
      cost_gbp_per_call: 0,
    },
    async (args, { task, dryRun }) => {
      const a = args as { to: string; subject: string; html: string };
      const r = await d.email.send(
        {
          to: a.to,
          from: d.infra.sender.from_email,
          subject: a.subject,
          body: a.html,
          task_id: task.task_id,
        },
        dryRun,
      );
      await d.storage.outbox.add({
        task_id: task.task_id,
        thread_id: `report:${task.task_id}`,
        attempt: 1,
        entity_id: null,
        recipient: a.to,
        sender: d.infra.sender.from_email,
        subject: a.subject,
        body: a.html,
        status: dryRun ? "dry_run" : "sent",
        reason: null,
      });
      return { result: { delivered: r.delivered, dry_run: dryRun } };
    },
  );
  registry.register(
    {
      name: "send_alert",
      description: "Deliver a watch-list change to the customer's webhook or email.",
      allowed_lanes: ["open"],
      external: true,
      serves_customer: true,
      allowed_roles: ["operator"],
      rate_limit_per_min: 600,
      cost_gbp_per_call: 0,
    },
    async (args, { task, dryRun }) => {
      const a = args as {
        change: {
          watch_id: string;
          field: string;
          old_value: unknown;
          new_value: unknown;
          version: number;
          watch: WatchRow;
        };
      };
      const w = a.change.watch;
      const customer = await d.storage.customers.get(w.customer_id);
      const r = await d.alerts.send(
        {
          kind: w.channel,
          target: w.target,
          payload: {
            company_number: w.entity_id,
            field: a.change.field,
            from: a.change.old_value,
            to: a.change.new_value,
          },
        },
        dryRun,
      );
      const charge = customer?.plan === "per_alert" ? d.products.monitoring.per_alert_gbp : 0;
      const fresh = await d.storage.watches.recordAlert({
        watch_id: w.id,
        entity_id: w.entity_id,
        field: a.change.field,
        old_value: a.change.old_value,
        new_value: a.change.new_value,
        fact_version: a.change.version,
        task_id: task.task_id,
        charged_gbp: charge,
      });
      if (fresh && charge > 0) await d.storage.tasks.addRevenue(task.task_id, charge);
      return {
        result: { delivered: r.delivered, dry_run: dryRun, charged_gbp: fresh ? charge : 0 },
      };
    },
  );
}

export const HUMAN_REPORT: PlaybookImpl = {
  roles: {
    build: (async (ctx) => {
      const n = (ctx.task.state as { company_number: string }).company_number;
      const check = (await ctx.tools.call("company_check", { company_number: n }))
        .result as CompanyCheck | null;
      if (!check) throw new Error(`no verified facts for ${n}`);
      return { output: { check, html: renderReport(check) } };
    }) satisfies RoleImpl,
    verify: (async (ctx) => {
      // The report must contain every risk flag and every field we hold; re-read the facts to confirm.
      const r = ctx.inputs.report as { check: CompanyCheck; html: string };
      const fresh = (
        await ctx.tools.call("company_check", { company_number: r.check.company_number })
      ).result as CompanyCheck | null;
      const reasons: string[] = [];
      if (!fresh) reasons.push("facts disappeared");
      else {
        for (const f of fresh.risk_flags)
          if (!r.check.risk_flags.some((x) => x.flag === f.flag))
            reasons.push(`missing risk flag ${f.flag}`);
        for (const k of Object.keys(fresh.fields))
          if (!r.check.fields[k]) reasons.push(`missing field ${k}`);
      }
      return {
        output: { passed: reasons.length === 0, reasons },
        check: { passed: reasons.length === 0, reasons },
      };
    }) satisfies RoleImpl,
    deliver: (async (ctx) => {
      const r = ctx.inputs.report as { check: CompanyCheck; html: string };
      const s = ctx.task.state as { email: string };
      return {
        output: (
          await ctx.tools.call("send_report", {
            to: s.email,
            subject: `Your company check: ${r.check.company_number}`,
            html: r.html,
          })
        ).result,
      };
    }) satisfies RoleImpl,
  },
  gateItem: (s) => s.outputs.report,
};

export const WATCH_ALERT: PlaybookImpl = {
  roles: {
    deliver: (async (ctx) => ({
      output: (
        await ctx.tools.call("send_alert", {
          change: (ctx.task.state as { change: unknown }).change,
        })
      ).result,
    })) satisfies RoleImpl,
  },
  gateItem: () => null,
};

export const MONITORING_SUBSCRIPTION: PlaybookImpl = {
  roles: { activate: (async () => ({ output: { activated: true } })) satisfies RoleImpl },
  gateItem: () => null,
};
