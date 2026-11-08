---
playbook: monitoring_subscription
version: 1
revenue_path: monitoring
autonomy: L3
budget_gbp: 0.01
steps:
  - { id: activate, role: operator, tools: [], output: activated }
done_when: activated
---

# Monitoring subscription

Records a new or renewed monitoring subscription (Stripe Checkout) so its revenue is attributed to a
task. The watches themselves are created when the payment is confirmed.
