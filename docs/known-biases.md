# Known biases

Things we know are skewing the data, why we accept them for now, and when we fix them.

| # | Bias | Effect | Accepted because | Fix | Status |
|---|---|---|---|---|---|
| 1 | **Location = registered office** (Phase 1) | Companies registered at an accountant's address inside GM but trading elsewhere are wrongly **included**; GM businesses registered at an accountant outside GM are wrongly **excluded**. | It's the only location Companies House gives for free. | Trading addresses from company websites in Phase 2; compare registered vs trading location. | Open |
| 2 | **Staff numbers only from filed accounts** | Companies that don't file tagged (iXBRL) accounts or don't disclose employees have no staff figure. These skew towards the smallest firms. | Included as `staff_unknown` and scored neutral on size, so they're not dropped. | Outcome data will show whether `staff_unknown` firms convert; website/job data in Phase 2. | Open |
| 3 | **"Active since incorporation"** | For active companies with no insolvency history we date `company_status` from incorporation. A company that was briefly in a strike-off proposal and recovered looks continuously active. | Strike-off proposals that are discontinued rarely matter for lead gen. | Read gazette filings (GAZ1/discontinuance) in Phase 3 if backtests show it matters. | Open |
| 4 | **Publication-date fallbacks** | Where no filing proves when something became public, we use our fetch time. Backtests then see those facts later than reality (never earlier). | Errs towards no look-ahead. | `pnpm gate:phase1` will report how often it happens once live; improve matching if it's common. | Open |
| 5 | **Synthetic rehearsal ≠ real data** | All Phase 1 evidence so far is on synthetic files and fake API responses. | No network/key in the build session. | First live run (`docs/runbooks/phase1-ingestion.md`). | Open |

