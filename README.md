# APT Service Program

Field-service management for Accurate Power & Technology — dispatch board,
service agreements / preventive maintenance, work orders, and invoicing with
QuickBooks Online sync. Replaces dESCO ESC. Runs standalone but shares the
company's Supabase Postgres database (and logins) with the sales CRM
([Electrical-program](https://github.com/jakesalverda44-alt/Electrical-program)).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Features (ESC equivalents)

| Screen | ESC equivalent | Notes |
|---|---|---|
| Customer Center | Customer Center | Search grid + detail panel; locations, equipment, agreements, job/invoice history; New Job / Edit / Add Location / Add Equipment |
| Dispatch Board | Dispatch Board | Tech columns + "To Schedule" tray; color-coded cards; click to advance status, drag to reassign; Block Time Off (non-customer time) |
| Jobs | Dispatch List | Filterable grid; append-only note timeline; parts & labor lines; Mark Complete → Create Invoice |
| Quotes | Quotes | Repair quotes with parts/labor lines, validity dates, printable; Accept converts to a job with the quoted lines copied over |
| Agreements | Agreement List | Type codes, plan tiers, visit counters (major/minor), tasks with checklists & next-due dates, Renew, on-demand PM generation |
| Invoices | Invoicing/Receivables | Created from jobs; tax/terms; payments with partial/paid status; printable; QBO sync fields ready |
| Intake | — (new) | Awarded CRM projects arrive automatically; Accept → service job |
| Import | — (new) | Upload ESC Customer List Report PDFs from the browser; idempotent |
| My Day | ESC Mobile Tech | Phone-first tech view: my dispatches, advance status with time in/out, directions, call links, field notes |

The PM scheduler runs at startup and every 12 hours (and on demand from the
Agreements page): agreement tasks within 14 days of due generate `pm` jobs into
the board's tray; completing one advances the task and decrements the
agreement's visits-remaining counter.

## Layout

```
backend/    Express 5 + pg API; serves built frontend in production
frontend/   React + Vite (light ESC-style theme, APT navy/gold)
database/   service-schema migrations (auto-applied at boot) + migrate.sh
tools/      offline ESC importer (same parser ships in-app under /import)
docs/       architecture plan
```

The service program owns the `service` Postgres schema; the CRM owns `public`.
Awarded CRM projects flow in automatically via a trigger on `public.projects`
into `service.project_intake`.

## Database

```sh
DATABASE_URL=postgres://... ./database/migrate.sh
```

Safe to re-run; applied migrations are tracked in `service.schema_migrations`.
Migrations are guarded so they also work on a bare database without the CRM
tables (local dev / CI).

## Importing ESC data

Parse an ESC "Customer List Report" PDF and load it:

```sh
python3 tools/import/esc_customer_list.py "Customer List Report.pdf" --out build/
psql "$DATABASE_URL" -f build/load.sql
```

Requires `pdftotext` (`apt install poppler-utils`). Imports are idempotent —
records upsert on ESC account/location numbers, so overlapping or repeated
reports are safe. Failed rows stay in `service.import_rows` with their error
for review.
