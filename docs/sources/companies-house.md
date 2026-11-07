# Companies House & ONS sources

Status: **built and tested against realistic fixtures; NOT yet run against the live API.**
This session's network couldn't reach Companies House or ONS, so these items are written from our
reading of the public API and must be checked against the current docs as the first live step.

## Verify before the first live run (≈ 15 minutes)

| # | Assumption | Where it lives | How to check |
|---|---|---|---|
| 1 | Auth is HTTP Basic: API key as username, empty password | `client.ts` `auth()` | developer.company-information.service.gov.uk → Authentication |
| 2 | Rate limit 600 requests / 5 minutes; 429 when exceeded; `X-Ratelimit-Reset` = epoch seconds | `companies_house.json`, `client.ts` | Rate limiting guide; first live call's response headers |
| 3 | Profile field names (`company_status`, `date_of_creation`, `accounts.last_accounts.type`, …) | `mapper.ts` `PROFILE_MAPPED` | Company profile resource. Any unexpected key is logged in `dropped_fields`, so `pnpm gate:phase1` shows it |
| 4 | Officers: `appointed_on`, `resigned_on`, `date_of_birth {month, year}`; resigned officers included by default | `mapper.ts` | Officer list resource |
| 5 | Filing history `date` = date the filing was received/registered; officer filings carry the effective date in `action_date` or `description_values` | `mapper.ts` `filingFor()` | Filing history resource. **This drives the published_at rule.** |
| 6 | Charges: `created_on`, `delivered_on`, `status`, `satisfied_on` | `mapper.ts` | Charge list resource |
| 7 | PSC: `notified_on`, `ceased_on`, `natures_of_control`, `kind` | `mapper.ts` | PSC list resource |
| 8 | Bulk file name `BasicCompanyDataAsOneFile-YYYY-MM-01.zip`; columns `CompanyNumber`, `CompanyName`, `CompanyStatus`, `RegAddress.PostCode`, `IncorporationDate` (dd/mm/yyyy), `Accounts.AccountCategory`, `SICCode.SicText_1..4`, `Mortgages.NumMortCharges` | `bulk.ts` | Free Company Data Product page. A missing column stops the run with a clear message |
| 9 | Accounts archives `Accounts_Monthly_Data-MonthYYYY.zip` / `Accounts_Bulk_Data-YYYY-MM-DD.zip`; files `Prod223_XXXX_<number>_<yyyymmdd>.html`; employees tag ends `AverageNumberEmployeesDuringPeriod` | `ixbrl.ts` | Accounts data product page; open one file |
| 10 | ONS lookup has a postcode column (`pcds`) and a LAD column (`lad25cd`/`oslaua`/…) | `postcodes.ts` | Detected automatically; a clear error names the headers found |

## How publication dates are decided (`published_at`)

Approved rule: a Companies House fact is knowable from when the filing was **received/published**, not
when the change took effect. If no filing proves the date, we fall back to the fetch time (we never
claim to have known something earlier than we can prove). Fallbacks are counted per field.

| Fact | Published at |
|---|---|
| incorporation date, company type | date of creation |
| company name | date of creation if never renamed; else the latest change-of-name filing |
| company status | `active` with no insolvency history → date of creation; `dissolved` → dissolution date; otherwise fetch time |
| registered office | latest AD01 filing; else date of creation |
| SIC codes | latest CS01/AR01/incorporation filing |
| accounts category / made-up date | the accounts filing for that period |
| due dates, overdue flags, insolvency/office flags | fetch time (live values) |
| officers | the AP01–AP04 / TM01–TM02 filing whose date matches the appointment/resignation; incorporation filing for founding officers |
| charges | `delivered_on`; satisfaction from the MR04 filing |
| PSC | the PSC01–PSC09 filing matching the date; incorporation for founders |
| employees (accounts data) | the archive's publication date (daily file date, or month end for monthly archives) |

History fields (officers, filings, charges, PSC) are stored as **snapshots**, one per publication
date, within a 6-year window (filings: 3 years). That's what lets a backtest see a past state.

## Cost and time

About 4.2 API calls per company (profile, officers, filing history, PSC, and charges only when flagged).
At 85% of the limit (510 calls / 5 min) a 10,000-company pull takes **about 7 hours**, unattended
and resumable. Responses are cached in `data/cache/ch`, so a re-run costs nothing.
