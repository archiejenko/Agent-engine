---
module: x402_discovery
version: 1
universe:
  members_of: lead_gen_sme_web_v1
  region: Greater Manchester
lanes: [open]
confidence_floor: 0.5
signals:
  x402_interest: { weight: 0.5 }
  director_change_90d: { weight: 0.25 }
  ownership_change_180d: { weight: 0.25 }
threshold: 0.5
outcome: { event: positive_reply, window_days: 30, value_field: deal_value_gbp }
explore_share: 0.10
economics: { deal_value_gbp: 1500, base_win_rate: 0.02 }
---

# x402 discovery

AI agents pay to check a company when they're about to do business with it. A company being checked by
several different agents is probably trading actively and changing — a good moment to offer help.

- **x402 interest** (50%): distinct paying agents in the last 30 days (from our own request log).
- **New director** (25%) and **ownership change** (25%): change brings new budgets.

Approved leads go to the `sme_outreach` playbook (pilot until a backtest shows ≥ 3× lift).
