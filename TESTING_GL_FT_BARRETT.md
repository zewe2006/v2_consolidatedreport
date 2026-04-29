# Tomorrow's testing — FT Barrett general ledger

A real general ledger was backfilled for **FT Barrett Property Plaid** (`653a7dba-6c18-4b97-aeed-b892dff215d3`) and the live write paths now auto-emit journal entries. This file is the test plan to confirm everything works end-to-end before extending the same treatment to Food Terminal Plaid.

## What was shipped

| commit | repo | what |
|---|---|---|
| `5257a49` | v2 | manual+Plaid companies always route to Supabase, not Railway |
| `10a14f0` | v2 | P&L reads from GL when GL data exists, falls back otherwise |
| `45c658f` | v2 | auto-emit JEs on bill / payment / categorize events |
| `d21c81c` | bill | `backfill` source value migration |
| `34067c2` | bill | `auto` source value migration |

Database state for FT Barrett:
- 51 historical journal entries tagged `source='backfill'` (trial balance = 0; P&L + A/P fully reconciled to legacy numbers)
- Going forward, every new bill, match, or txn categorize will emit `source='auto'` JEs

Other companies (Food Terminal Plaid, QBO companies): untouched. The GL probe finds zero rows, so they keep using the legacy P&L path with no change in behavior.

## Test cases

Treat any failure as a stop-and-report — don't keep clicking through.

### 1 · P&L reads from the GL with identical numbers

- Navigate to **Profit & Loss**, company **FT Barrett Property Plaid**, Method **Cash**, Columns **By Month**, range **2026-01-01 → 2026-04-28**.
- Click **Run Report**.

Expected:

| | Jan | Feb | Mar | Apr | Total |
|---|---|---|---|---|---|
| Rental Income | 14,583.33 | 14,583.33 | 14,583.33 | 14,583.33 | 58,333.32 |
| Bank Charges & Fees | — | 14.15 | — | — | 14.15 |
| Interest Paid | 7,741.38 | 6,983.38 | 7,718.10 | 7,459.30 | 29,902.16 |
| Legal & Professional | 100.00 | — | — | — | 100.00 |
| **Net Income** | **6,741.95** | **7,585.80** | **6,865.23** | **7,124.03** | **28,316.96** |

Critical: the notice text above the table should read **"Cash basis · derived from the General Ledger. Single source of truth."** (NOT "derived from categorized transactions").

### 2 · Method dropdown disabled on manual+Plaid

- Same screen. Open the **Method** dropdown.
- It should be **disabled** with a tooltip on hover: *"Cash basis only on manual + Plaid companies"*.
- Same on the **Balance Sheet** screen.

### 3 · Create a new bill auto-emits a JE

- Create a new bill on FT Barrett. Vendor: any. Date: today. One line: pick any expense COA (e.g. **6907 Legal & Professional Services**), amount **$100**.
- Save.
- Run this query in Supabase:

```sql
SELECT je.id, je.date, je.memo, je.source,
       jl.coa_account_id, coa.code, coa.name, jl.debit, jl.credit
FROM journal_entries je
JOIN journal_lines jl ON jl.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jl.coa_account_id
WHERE je.company_id = '653a7dba-6c18-4b97-aeed-b892dff215d3'
  AND je.source = 'auto'
  AND je.memo LIKE 'auto:bill:%'
ORDER BY je.created_at DESC
LIMIT 10;
```

Expected: a fresh row with memo `auto:bill:<new-bill-id>`, two journal_lines:
- Dr 6907 Legal & Professional Services $100
- Cr 2901 Accounts Payable (A/P) $100

Re-run the P&L. The new $100 should appear in this month's Legal & Professional row.

### 4 · Match a bank transaction to a bill

- Pick an unmatched outflow on FT Barrett (any amount). Click **Match**, apply against any open bill.
- Run this query:

```sql
SELECT je.memo, jl.coa_account_id, coa.code, coa.name, jl.debit, jl.credit
FROM journal_entries je
JOIN journal_lines jl ON jl.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jl.coa_account_id
WHERE je.company_id = '653a7dba-6c18-4b97-aeed-b892dff215d3'
  AND je.memo LIKE 'auto:payment:%'
ORDER BY je.created_at DESC
LIMIT 5;
```

Expected: a row with memo `auto:payment:<payment-id>`, two journal_lines:
- Dr 2901 Accounts Payable (A/P) `<amount>`
- Cr the bank-account COA `<amount>` (e.g. 1901 Analysis Checking, or 1909 QBO Import Clearing)

The matched bill's `status` should now be `paid` and `balance` should be 0.

Then **click Match again** on the same transaction. Expected toast: **"transaction is already matched; unmatch it first"** — no second payment row created.

### 5 · Categorize a bank transaction

- Find an **uncategorized** bank txn on FT Barrett. Click its category cell, set it to any expense COA (e.g. **6902 Bank Charges & Fees**).
- Query:

```sql
SELECT je.memo, jl.coa_account_id, coa.code, coa.name, jl.debit, jl.credit
FROM journal_entries je
JOIN journal_lines jl ON jl.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jl.coa_account_id
WHERE je.company_id = '653a7dba-6c18-4b97-aeed-b892dff215d3'
  AND je.memo = 'auto:txn:<the-txn-id-you-just-categorized>';
```

Expected: 2 lines:
- For an outflow (positive amount): Dr the expense COA `<amount>`, Cr the bank account's COA `<amount>`
- For an inflow (negative amount): the reverse

### 6 · Re-categorize replaces the JE

- Change the same transaction's category to a different COA.
- Re-run the query from test 5. Expected: still **one row** with that memo, but lines now reference the new COA. (The previous JE was deleted and re-emitted, not duplicated.)

### 7 · Clear category deletes the JE

- Clear the category entirely.
- Re-run the query. Expected: **zero rows** — JE is gone.

### 8 · Balance Sheet still uses legacy path

- Navigate to **Balance Sheet** → FT Barrett → today.
- Notice text should still say *"Derived from Supabase — no double-entry GL data..."* (the legacy hybrid path).
- A/P should equal sum of open bills' balance. Bank balances should match Plaid feed.
- This is intentional: the GL Balance Sheet exists in code (`_supaBalanceSheetFromGL`) but isn't wired in until opening-balance JEs are populated.

### 9 · Food Terminal Plaid is unaffected

- Switch to **Food Terminal Plaid**. Run P&L for the same period.
- Notice text should say *"derived from categorized transactions in Supabase (legacy path — no GL data for this company yet)"*.
- Numbers should match what Food Terminal showed yesterday.

## If something is broken

```sql
-- Rollback live emissions only (keeps the historical backfill)
DELETE FROM journal_entries WHERE source = 'auto';

-- Full rollback to "no GL anywhere"
DELETE FROM journal_entries WHERE source IN ('auto', 'backfill');
```

After either rollback, FT Barrett's P&L falls back to the legacy txn × category × COA path automatically. No code change required.

Code-side rollback (revert all this session's commits, keep the routing fix):

```sh
# In v2 repo
git revert 45c658f 10a14f0
# In bill repo
cd bill && git revert 34067c2 d21c81c
```

## Known follow-ups (do NOT attempt during testing)

- **Food Terminal Plaid GL backfill** — different data shape (33 bills, up to 9 lines each, 179 "Bill" description txns). Separate session.
- **Opening-balance JEs for bank accounts** — required before switching the Balance Sheet to read from GL. Otherwise GL bank balances would be negative (only cash-leg activity is in the ledger, not opening positions).
- **Cleanup of the duplicate "Bill" description txns** on FT Barrett (Feb 16 / Mar 16 / Apr 16). They duplicate the numbered bill JEs but currently still drive the legacy P&L path (which the GL path takes precedence over for FT Barrett). Safe to delete only after BS also moves to GL.
- **Unmatch flow** — does not delete the auto payment JE today. If unmatch is exercised in testing, a stale `auto:payment:*` JE will remain. Note any case so we can wire it up next.
- **Bill update / delete** — currently only bill *create* emits a JE. Editing or deleting an existing bill won't update the corresponding JE. Avoid editing during this round of testing if possible.
