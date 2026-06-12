# ESC → APT Service nightly sync (parallel-run phase)

While the office still runs dESCO ESC as the system of record, the new program
follows it automatically: a Windows scheduled task on the ESC server re-exports
the live database every night and pushes the CSVs to the app's import API.
Every importer is idempotent (keyed on ESC numbers), so the nightly push
updates records in place — new customers appear, renewals update, dispatches
and invoices append. Nothing duplicates.

## One-time setup

1. **Render dashboard → apt-service → Environment:** add `IMPORT_API_KEY` with
   a long random value (40+ chars). Save (the service restarts).
2. **On the ESC server**, have Claude Code create:
   - the export script (it already has this — same SELECT-only export it ran
     against `APT-SRV1\ECS2017 → AccuratePower`, writing the CSVs to a folder);
   - an upload step that POSTs each CSV to the app:

   ```powershell
   $key  = "<IMPORT_API_KEY value>"
   $base = "https://<your-app>.onrender.com/api/import/esc-csv"
   $dir  = "C:\esc_sync\csv"
   foreach ($f in @('customers.csv','locations.csv','agreements.csv',
                    'agreement_recurrence.csv','agreement_tasks.csv','equipment.csv',
                    'dispatches.csv','invoices.csv','invoice_lines.csv',
                    'payments.csv','receivables.csv')) {
     Invoke-RestMethod -Method Post -Uri "$base?filename=$f" `
       -Headers @{ 'x-api-key' = $key } -ContentType 'text/csv' `
       -InFile (Join-Path $dir $f)
   }
   ```
   (Order matters on the FIRST run only; after that any order works.)

   **Large tables must be exported in parts** (the app server rejects giant
   single requests): write `dispatches.csv` and `dispatch_notes.csv` as
   numbered part files of ≤15,000 rows each — `dispatches_001.csv`,
   `dispatches_002.csv`, … Each part repeats the header row. The importer
   detects the table from the header, so filenames don't matter; just POST
   every part. (The browser Import screen does this splitting automatically —
   this note is only for the scripted sync.)
3. **Task Scheduler:** run export + upload nightly (e.g. 2:00 AM), as a user
   with read access to the SQL instance. Log output to a file.

## Rules during the parallel run

- **ESC is the source of truth for ESC-owned data.** Edit customers,
  locations, and agreements in ESC; the nightly sync brings changes over. If
  you edit those same fields in the new app, the next sync overwrites them
  with ESC's values.
- **Sync is one-way (ESC → app).** Jobs, quotes, and invoices created in the
  new app do NOT flow back to ESC. During testing, treat new-app work as
  practice unless you've decided a workflow has switched over for good.
- **Switch-over per workflow is fine.** e.g. quotes can go fully to the new
  app (ESC never had yours anyway) while dispatching stays in ESC — the sync
  doesn't touch new-app-native records.
- When you cut over for real: turn off the scheduled task, run one final
  export/import, and ESC becomes read-only history.
