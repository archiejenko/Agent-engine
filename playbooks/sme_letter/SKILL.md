---
playbook: sme_letter
version: 1
revenue_path: sme_outreach
autonomy: L0
budget_gbp: 0.40
steps:
  - { id: research, role: researcher, tools: [verified_facts], output: letter_brief }
  - { id: draft, role: writer, tools: [], output: letter_draft }
  - { id: check, role: checker, tools: [verified_facts], output: pass_or_fail }
  - { id: prepare, role: writer, tools: [prepare_letter], output: print_ready }
  - { id: print_batch, gate: archie }
done_when: batch_approved_or_rejected
---

# SME letter (v1, L0: drafts only; Archie approves a weekly print batch)

For approved leads we can't email: no website, or no emailable address on the company's own site.

1. **Research**: the company's verified facts (open lane only) into a brief, plus its registered office
   address and Companies House's "undeliverable" flag.
2. **Draft**: a short letter using only statements from the brief, each tied to a fact. The greeting
   ("Dear Directors"), sign-off, sender details, QR caption and opt-out are added by code.
3. **Check**: the same truth check as email (every claim matches a verified fact; no unsupported numbers
   or dates; no placeholders; length), plus: there must be a verified registered office that isn't
   marked undeliverable. A failed check retries the draft once, then stops for review.
4. **Prepare**: renders a one-page demo homepage for the company (only verified facts: name, town,
   trading since; `noindex`, with a banner saying it's a sample) and a print-ready A4 PDF addressed to
   "The Directors" at the registered office, with a QR code to the demo. Nothing is sent or published.
   If the registered office looks like an accountant's or formation agent's (care-of, accountancy words,
   or shared by many companies), the letter is **flagged** in the print queue.
5. **Print batch** (gate): once a week the waiting letters are put into one print batch. Archie
   approves it (optionally leaving out flagged letters) or rejects it, then prints and posts the PDF
   himself. There is no print/post API yet. Demo pages go live only for approved letters, and only while
   external actions are allowed for `sme_letter` (kill switch off).
