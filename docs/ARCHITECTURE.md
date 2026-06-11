# APT Service Program — Architecture Plan

Field-service management application for Accurate Power & Technology, replacing
dESCO ESC. Standalone app, deployed separately from the sales CRM
(`Electrical-program`), but sharing the same Supabase Postgres database.

## Context

- **Replaces:** dESCO ESC (now FieldEdge) — dispatch board, service agreements,
  work orders, invoicing, equipment history, mobile tech app, QuickBooks sync.
- **CRM:** `jakesalverda44-alt/Electrical-program` — Node/Express + `pg` backend,
  React 18 + Vite + TypeScript frontend, custom JWT auth against a shared
  `users` table, deployed on Render. `DATABASE_URL` points at Supabase Postgres.
- **This app** mirrors that stack so both programs share conventions, auth, and
  the database: Express + `pg` backend, React + Vite + TS frontend, its own
  Render web service.

## V1 scope (user-confirmed)

1. **Dispatch board & scheduling** — drag-and-drop day/week/month board,
   technician columns, job color coding by status/type.
2. **Service agreements & PMs** — maintenance contracts with billing frequency,
   auto-generated preventive-maintenance visits, renewal tracking.
3. **Work orders & invoicing** — full lifecycle: intake → schedule → dispatch →
   complete → invoice → payment, with **QuickBooks Online sync**.
4. **Field tech experience** — mobile-friendly tech view (PWA): my dispatches,
   status updates, notes, photos, signature capture.
5. **Equipment records** (supporting, not headline): generators/equipment per
   location with serial, kW, warranty, and service history — agreements and PMs
   hang off equipment, so a lightweight version ships in v1.
6. **ESC data import** — staged importer for the existing service-customer base
   (thousands of customers) from ESC Excel/CSV exports.

## Database strategy: one Supabase Postgres, two schemas

The CRM owns the `public` schema. The service program gets its own Postgres
schema, **`service`**, in the same database:

- Zero risk of table-name collisions or accidental CRM breakage.
- Cross-schema foreign keys still work (`service.jobs.crm_project_id →
  public.projects.id`).
- Each app runs its own migrations in its own schema.

**Shared CRM tables we read (never write, except noted):**

| Table | Use |
|---|---|
| `public.users` | Shared logins/roles. `technician` role already exists. May add `dispatcher`. |
| `public.projects` | Awarded work (id = bid/proposal id, `source_type` `'elec'`/`'gen'`). Intake source. |
| `public.customers` | CRM customers/GCs. Service customers link to these where they overlap. |
| `public.generator_proposals` | Read generator details (mfr, model, kW) when converting an awarded gen job → equipment record. |
| `public.app_settings` | Company profile/licenses for invoice headers. |

## CRM → service handoff (automatic on award)

The CRM already creates a `public.projects` row the moment a bid or generator
proposal is awarded. We add an `AFTER INSERT` trigger on `public.projects` that
inserts into `service.project_intake`. The service app shows the intake queue;
each entry auto-creates a service job pre-filled from the project, proposal,
and customer (generator jobs additionally pre-fill an equipment record from
`generator_proposals`). A `processed_at` column keeps it idempotent, and a
startup backfill catches anything inserted while triggers were absent.

## `service` schema — core tables

```
service_customers      id, crm_customer_id?, esc_account_no?, name, billing fields,
                       phone/email, status, balance-related fields, notes
locations              customer_id, label, address, gate/access notes, tax_region
equipment              location_id, kind (generator|ats|panel|other), mfr, model,
                       serial, kw, fuel, install_date, warranty_expires, notes
agreements             customer_id, location_id, plan_name, billing_freq
                       (annual|semiannual|quarterly|monthly), price, start/end,
                       auto_renew, visits_per_year, status
agreement_equipment    agreement_id ↔ equipment_id
jobs                   number, customer_id, location_id, type (pm|repair|install|
                       warranty|callback|project), priority, status, summary,
                       crm_project_id? → public.projects, agreement_id?, equipment_id?
dispatches             job_id, tech_id → public.users, scheduled_start/end,
                       status (scheduled|dispatched|enroute|onsite|complete),
                       time_in/time_out, tech notes, signature, photos (jsonb)
job_lines              job_id, kind (labor|part|flat), description, qty, unit_price
invoices               job_id?, customer_id, number, status (draft|sent|paid|void),
                       totals, tax, qbo_id?, qbo_sync_status
payments               invoice_id, method, amount, received_at, qbo_id?
project_intake         crm_project_id, payload snapshot, processed_at, job_id?
import_batches /       staging + audit for ESC imports (raw rows preserved,
import_rows            row-level status + errors, re-runnable)
```

PM generation: a scheduled task (cron route or pg_cron) walks active agreements
and creates `pm` jobs the configured lead-time ahead of each due visit.

## QuickBooks Online sync (v1)

- OAuth2 connection to QBO stored in `service.qbo_connection` (encrypted tokens).
- Push: customers (on first invoice), invoices, payments. Pull: payment status.
- Sync is queue-based (`qbo_sync_status` per record) so the app never blocks on
  Intuit's API; failures surface in a sync-issues screen.
- Requires an Intuit Developer app (Client ID/Secret) — see checklist.

## ESC import pipeline

1. Owner exports from ESC: customers, locations, equipment, agreements, and
   (if available) service history → Excel/CSV.
2. Files load into `import_rows` untouched (raw jsonb), keyed by batch.
3. Mapping pass normalizes into `service_customers` / `locations` / `equipment` /
   `agreements`, recording per-row status and errors; safe to re-run.
4. Review screen lists unmatched/dirty rows for manual fix-up.
5. ESC account numbers are preserved (`esc_account_no`) for cross-referencing
   during the transition period.

## Auth & roles

Same JWT pattern and shared `users` table as the CRM (same `JWT_SECRET` so a
login works across both apps). Service app honors roles: `owner`,
`administrator`, `accounting` (full), `technician` (tech PWA: own dispatches
only), plus a new `dispatcher` role added to the existing CHECK constraint.

## Deployment

Separate Render web service (`apt-service`), same `DATABASE_URL` as the CRM
(Supabase connection string), own `render.yaml` in this repo.

## Needed from the owner before/while building

1. **ESC exports** — at minimum a sample (even 20 rows) of each: customers,
   locations, equipment, agreements, history. Real column headers drive the
   import mapping.
2. **Supabase connection string** — set as `DATABASE_URL` on the new Render
   service (never committed to git).
3. **`JWT_SECRET`** from the CRM's Render service, so logins are shared.
4. **QuickBooks**: Intuit Developer account + app → Client ID/Secret, and
   confirmation of the QBO company file to sync into.
5. **Business rules**: agreement plan names/pricing/visit frequencies, work
   order numbering preference, sales-tax handling, invoice terms.
6. **Team roster**: technicians and dispatchers (name, email, role).
