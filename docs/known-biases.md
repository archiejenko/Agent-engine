# Known biases

Things we know are skewing the data, why we accept them for now, and when we fix them.

| # | Bias | Effect | Accepted because | Fix | Status |
|---|---|---|---|---|---|
| 1 | **Location = registered office** (Phase 1) | Companies registered at an accountant's address inside GM but trading elsewhere are wrongly **included**; GM businesses registered at an accountant outside GM are wrongly **excluded**. | It's the only location Companies House gives for free. | Trading addresses from company websites in Phase 2; compare registered vs trading location. | Open |
| 2 | **Staff numbers only from filed accounts** | Companies that don't file tagged (iXBRL) accounts or don't disclose employees have no staff figure. These skew towards the smallest firms. | Included as `staff_unknown` and scored neutral on size, so they're not dropped. | Outcome data will show whether `staff_unknown` firms convert; website/job data in Phase 2. | Open |
