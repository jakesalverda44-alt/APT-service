# APT Service Program

Field-service management for Accurate Power & Technology — dispatch board,
service agreements / preventive maintenance, work orders, and invoicing with
QuickBooks Online sync. Replaces dESCO ESC. Runs standalone but shares the
company's Supabase Postgres database (and logins) with the sales CRM
([Electrical-program](https://github.com/jakesalverda44-alt/Electrical-program)).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Layout

```
database/   service-schema migrations + migrate.sh runner
tools/      ESC data importers (see tools/import)
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
