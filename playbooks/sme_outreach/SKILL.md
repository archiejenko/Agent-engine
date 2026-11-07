---
playbook: sme_outreach
version: 1
revenue_path: sme_outreach
autonomy: L0
budget_gbp: 0.40
steps:
  - { id: research, role: researcher, tools: [verified_facts, web_fetch], output: company_brief }
  - { id: draft, role: writer, tools: [], output: email_draft }
  - { id: check, role: checker, tools: [verified_facts], output: pass_or_fail }
  - { id: approve, gate: archie }
done_when: approved_or_rejected
---

# SME outreach (L0: drafts only)

Turns an approved lead into a short, truthful first email offering a new website.

1. **Research**: gathers the company's verified facts (open lane only) into a brief. Every fact in the
   brief has an id and a plain-English statement. Web pages may be read for context but are never
   copied into the brief.
2. **Draft**: writes the email using only statements from the brief, listing which fact each claim
   relies on. Archie's past edits are given as examples.
3. **Check**: confirms every factual claim against a verified fact, that nothing unsupported (numbers,
   dates) slipped in, and the length. A failed check retries the draft once, then stops for review.
4. **Approve**: Archie approves, edits or rejects. Edits are kept as examples for next time.

At L0 nothing is sent. The sender identity and opt-out line are added by code, not the model.
