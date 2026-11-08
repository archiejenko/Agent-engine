---
playbook: watch_alert
version: 1
revenue_path: monitoring
autonomy: L3
budget_gbp: 0.01
steps:
  - { id: deliver, role: operator, tools: [send_alert], output: delivery }
done_when: delivered
---

# Watch-list change alert

A watched company changed (a new version of a watched fact). The change is sent to the customer's
webhook or email. Automatic (L3); dry run while the kill switch is on. Per-alert customers are charged
per delivered alert.
