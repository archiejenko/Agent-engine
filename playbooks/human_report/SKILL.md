---
playbook: human_report
version: 1
revenue_path: human_check
autonomy: L3
budget_gbp: 0.05
steps:
  - { id: build, role: researcher, tools: [company_check], output: report }
  - { id: verify, role: checker, tools: [company_check], output: pass_or_fail }
  - { id: deliver, role: operator, tools: [send_report], output: delivery }
done_when: delivered
---

# Human company check (paid by card)

A customer paid (Stripe Checkout) for a one-page report on a UK company. Built entirely from open-lane
verified facts (no model writes it), re-checked against a fresh read of the facts, then emailed to the
customer. Fully automatic (L3): the customer is waiting, and the content is deterministic. While the
kill switch is on, delivery is a dry run.
