# RLS audit — Supabase project `aemqlnwbnvwynnxirrmg`

> **Premise**: app.js ships to the browser. Anyone with a valid Supabase JWT can hit the REST API directly with whatever query they want. Per-row access is governed solely by RLS. Any table without RLS is a hole.

## Summary

- **30** base tables in `public`
- **18** have RLS enabled and reasonable policies ✅
- **12** have **RLS disabled** ❌ — anyone authenticated can read/write any row in any company
- **1** RLS-enabled table allows users to UPDATE the audit log (tamper risk) ⚠️

## Critical: 12 tables with no RLS at all

| Table | What's exposed | Cross-tenant risk |
|---|---|---|
| `bills` | every company's accounts-payable history | read all, modify amounts/status, delete |
| `bill_lines` | line-level breakdown of every bill | same |
| `invoices` | every company's accounts-receivable history | same |
| `invoice_lines` | invoice line items | same |
| `credit_memos`, `credit_memo_lines`, `credit_memo_applications` | A/P credit notes | same |
| `recurring_invoices` | scheduled billing | read templates, schedule fake invoices |
| `payments` | every cash payment with bank-account ids | read, **forge fake payments to clear A/P** |
| `payment_applications` | links between payments and bills/invoices | same |
| `vendors` | vendor names + email + address + phone + tax_id (PII!) | mass scrape, modify ACH details |
| `customers` | customer names + email + address + phone (PII!) | same |

**Concrete attack**: any authenticated user can run

```http
GET https://aemqlnwbnvwynnxirrmg.supabase.co/rest/v1/payments?select=*
Apikey: <anon key from app.js>
Authorization: Bearer <their own JWT>
```

…and get every payment row across every company. Same for the other 11 tables. Ditto for POST / PATCH / DELETE.

## Medium: audit_log is fully mutable

`audit_log_update` and `audit_log_delete` policies allow any company member to modify or delete entries. Audit logs should be append-only for users; only service_role should mutate. Not a cross-tenant leak (still scoped by `user_companies()`), but it lets a malicious member cover their tracks.

```sql
-- Current policies on audit_log
audit_log_select: company_id IN user_companies()
audit_log_insert: company_id IN user_companies()
audit_log_update: company_id IN user_companies()  -- ⚠️ tamperable
audit_log_delete: company_id IN user_companies()  -- ⚠️ tamperable
```

## Low / informational

- `companies_insert` only checks `auth.uid() = created_by`. It does NOT prevent a user from creating a company with arbitrary name, then inserting `company_members` rows pointing at other users. The `members_insert` policy DOES require either self-with-owner-role OR existing membership in the company, so you can only add yourself as owner of a company you just created. That seems fine, but the company-creation flow is the entry point — confirm the UI matches the policy intent.
- `members_insert` allows any current member to add new members regardless of role. Adding admins/owners should require admin-or-above. (Not exploitable if the only entry is via the invite flow, but RLS should still narrow it.)
- `investment_holdings` and `investment_transactions` only have `SELECT` for users + `ALL` for service_role — INSERT/UPDATE/DELETE go through the service. Acceptable but unusual.
- `user_companies()` itself: SECURITY DEFINER, body is `SELECT company_id FROM company_members WHERE user_id = auth.uid()`. No injection vector, no parameter abuse. ✅ safe.

## RLS-enabled tables that look correct

```
accounts, categories, chart_of_accounts, companies, company_invites,
company_member_events, company_members, investment_holdings,
investment_transactions, journal_entries, journal_lines, liabilities,
mortgage_statements, plaid_items, rules, transactions,
vendor_loan_coa_mapping
```

(audit_log too, with the caveat above.)

## Proposed remediation — one migration

Below is the migration to enable RLS on every gap table with the right policies. Companies use `company_id` directly for parent tables; line/application tables walk to their parent.

```sql
-- 0021_rls_close_gaps.sql
-- Enables RLS + adds policies on the 12 tables that were unprotected.
-- All policies match the existing pattern (company_id IN user_companies()).

------------ PARENT TABLES (have company_id directly) ------------

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY bills_select ON bills FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY bills_insert ON bills FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY bills_update ON bills FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY bills_delete ON bills FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_select ON invoices FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY invoices_insert ON invoices FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY invoices_update ON invoices FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY invoices_delete ON invoices FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE credit_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_memos_select ON credit_memos FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY credit_memos_insert ON credit_memos FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY credit_memos_update ON credit_memos FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY credit_memos_delete ON credit_memos FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE recurring_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY recurring_invoices_select ON recurring_invoices FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY recurring_invoices_insert ON recurring_invoices FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY recurring_invoices_update ON recurring_invoices FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY recurring_invoices_delete ON recurring_invoices FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_select ON payments FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY payments_update ON payments FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY payments_delete ON payments FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendors_select ON vendors FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY vendors_insert ON vendors FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY vendors_update ON vendors FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY vendors_delete ON vendors FOR DELETE USING (company_id IN (SELECT user_companies()));

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_select ON customers FOR SELECT USING (company_id IN (SELECT user_companies()));
CREATE POLICY customers_insert ON customers FOR INSERT WITH CHECK (company_id IN (SELECT user_companies()));
CREATE POLICY customers_update ON customers FOR UPDATE USING (company_id IN (SELECT user_companies()));
CREATE POLICY customers_delete ON customers FOR DELETE USING (company_id IN (SELECT user_companies()));

------------ CHILD TABLES (walk to parent for company scope) ------------

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY bill_lines_select ON bill_lines FOR SELECT USING (
  bill_id IN (SELECT id FROM bills WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY bill_lines_insert ON bill_lines FOR INSERT WITH CHECK (
  bill_id IN (SELECT id FROM bills WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY bill_lines_update ON bill_lines FOR UPDATE USING (
  bill_id IN (SELECT id FROM bills WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY bill_lines_delete ON bill_lines FOR DELETE USING (
  bill_id IN (SELECT id FROM bills WHERE company_id IN (SELECT user_companies()))
);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines_select ON invoice_lines FOR SELECT USING (
  invoice_id IN (SELECT id FROM invoices WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY invoice_lines_insert ON invoice_lines FOR INSERT WITH CHECK (
  invoice_id IN (SELECT id FROM invoices WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY invoice_lines_update ON invoice_lines FOR UPDATE USING (
  invoice_id IN (SELECT id FROM invoices WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY invoice_lines_delete ON invoice_lines FOR DELETE USING (
  invoice_id IN (SELECT id FROM invoices WHERE company_id IN (SELECT user_companies()))
);

ALTER TABLE credit_memo_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_memo_lines_select ON credit_memo_lines FOR SELECT USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_lines_insert ON credit_memo_lines FOR INSERT WITH CHECK (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_lines_update ON credit_memo_lines FOR UPDATE USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_lines_delete ON credit_memo_lines FOR DELETE USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);

ALTER TABLE credit_memo_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_memo_applications_select ON credit_memo_applications FOR SELECT USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_applications_insert ON credit_memo_applications FOR INSERT WITH CHECK (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_applications_update ON credit_memo_applications FOR UPDATE USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY credit_memo_applications_delete ON credit_memo_applications FOR DELETE USING (
  credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id IN (SELECT user_companies()))
);

ALTER TABLE payment_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_applications_select ON payment_applications FOR SELECT USING (
  payment_id IN (SELECT id FROM payments WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY payment_applications_insert ON payment_applications FOR INSERT WITH CHECK (
  payment_id IN (SELECT id FROM payments WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY payment_applications_update ON payment_applications FOR UPDATE USING (
  payment_id IN (SELECT id FROM payments WHERE company_id IN (SELECT user_companies()))
);
CREATE POLICY payment_applications_delete ON payment_applications FOR DELETE USING (
  payment_id IN (SELECT id FROM payments WHERE company_id IN (SELECT user_companies()))
);

------------ FIX audit_log to be append-only for users ------------

DROP POLICY IF EXISTS audit_log_update ON audit_log;
DROP POLICY IF EXISTS audit_log_delete ON audit_log;
-- service_role keeps full access by default (bypass RLS).
-- No replacement update/delete policies = users cannot mutate or remove entries.
```

## Risks of applying this migration

- **Breakage**: any code path that today writes to one of the 12 tables using a JWT that's NOT a member of the target `company_id` will start failing. The current app.js paths all filter by `selectedCompanyId` first, but the QBO sync service (Railway) uses the service role and bypasses RLS — confirm. Same for any cron / edge function.
- **Embedded selects**: PostgREST uses RLS for `?select=foo,bar(...)` embeds too. If any client query embeds a child table (e.g. `bills?select=*,bill_lines(*)`), the embed is now subject to the child policy. The walk-to-parent pattern above keeps that working as long as the user has access to the parent.
- **Backfill paths**: my GL backfill ran with the service role via the MCP tool, which bypasses RLS — unaffected.

## Recommendation

Apply the migration. Test by:

1. After apply, hit `GET /rest/v1/bills?company_id=eq.<some company you don't own>` with a regular user JWT. Should return `[]`.
2. Hit the FT Barrett UI flows (P&L, bills create, match) end-to-end. Should still work for users who own the company.
3. Verify the QBO sync still runs (uses service role).

If anything breaks, individual policies can be `DROP`ped; the migration is reversible.
