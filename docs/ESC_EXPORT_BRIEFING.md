# ESC → APT Service: data export briefing

**You are Claude Code running on the Windows machine that has dESCO ESC
installed.** Another Claude built a replacement service program (this repo).
Your job: get **all** of ESC's data out as CSV files so it can be imported into
the new system. This document tells you what to extract and the shape it needs.

> **Read-only. Never modify, repair, or write to the ESC database.** Make a copy
> of the data folder before doing anything if that's easy. Export only.

## Background

ESC by dESCO (later FieldEdge) is a Windows desktop app backed by a
**Pervasive PSQL / Actian Zen (Btrieve)** database. The data files live in a
data directory (often under `C:\ProgramData\dESCO\ESC\`, `C:\ESC\`, or a
mapped network drive — find the real one). Tables are exposed through an
**ODBC** data source (a DSN, often named `ESC` or similar).

## How to get the data out (in order of preference)

1. **ODBC → CSV (best).** If an ODBC DSN for ESC exists (check
   *ODBC Data Source Administrator* → System DSN), connect and dump every
   table. From Python: `pyodbc` + `pandas.read_sql` → `to_csv`. From
   PowerShell: `System.Data.Odbc`. List all tables first, then export each.
2. **ESC's own export.** Many ESC list/report screens have a right-click or
   menu *Export to Excel/CSV*. Slower and per-screen, but needs no driver.
3. **Pervasive Control Center / DDF files.** If the Actian/Pervasive tools are
   installed, use them to read the schema (FILE.DDF / FIELD.DDF) and export.
4. If the ODBC driver is missing, that's normal — install the Actian Zen client
   (or ask dESCO/FieldEdge support for a full data export, since ESC is being
   sunset). Walk the user through whichever path is realistic.

First, **report the schema**: list every table and its columns and write a
`schema.txt`. That alone is hugely valuable — it reveals ESC's real structure.

## What the new system needs (target shape)

Export each of these to its own CSV. Column names don't have to match exactly —
just include the data; the importer on the other side maps them. Keep ESC's
**account numbers, location numbers, and agreement numbers** verbatim; they're
the keys that tie everything together and let imports re-run safely.

### 1. Customers  → `customers.csv`
account number, name, company, billing address (street/city/state/zip),
phone numbers (all of them, with their labels — Work/Home/Fax/Cellular), email,
credit terms, active/inactive, notes.

### 2. Locations  → `locations.csv`
parent account number, location number, location name, site address
(street/city/state/zip), site contact name + phones, **access notes (gate
codes, key/alarm info)**, tax code, active/inactive, notes. One row per
location (a customer can have hundreds).

### 3. Equipment  → `equipment.csv`
parent account + location number, kind (generator/ATS/panel/pump/other),
manufacturer, model, **serial number**, kW, fuel type, install date,
warranty expiration, notes.

### 4. Agreements (service contracts)  → `agreements.csv`
agreement number, account number, location number, **type code** (e.g. SAR,
SLC, GLC, PAR, FAR), plan/tier name (Silver/Gold/…), billing frequency, price,
**original contract date, last renewal date, expiration date**, auto-renew,
and the **visit counters**: major visits per term + remaining, minor visits per
term + remaining. Status (active/expired/cancelled).

### 5. Agreement tasks / service checklists  → `agreement_tasks.csv`
agreement number, task name, major vs minor, interval (months), next-due date,
and the **checklist items** (e.g. change oil, oil filter, air filter, spark
plugs, no-load/transfer test).

### 6. Dispatch / job history  → `dispatches.csv`
dispatch/job number, account + location number, type, status, scheduled
date(s), technician, completion date, customer PO, and the **note timeline**
(the timestamped dispatch notes — these are the service history; capture them
even if it means one row per note in a `dispatch_notes.csv`).

### 7. Invoices & payments  → `invoices.csv` / `invoice_lines.csv` / `payments.csv`
invoice number, account/location, dates, terms, customer PO, line items
(part/labor, description, qty, cost, price, taxable), subtotal/tax/total,
payments (date, method, reference, amount), balance.

## Priority

If you can't do it all at once, export in this order — it unblocks the most on
the other side:

1. **Agreements + agreement tasks + equipment** (the new system's PM engine is
   built and idle waiting for these).
2. **Full customers + locations** (the Leesburg/34748 subset is already
   imported; everything else is missing).
3. **Dispatch history, then invoices.**

## Output / handoff

Put the CSVs (and `schema.txt`) in a folder, then have the user upload them to
**Google Drive**. The other Claude reads them from Drive and builds the matching
importers. Note any quirks you hit (encodings, weird columns, split phone
fields) in a `notes.md` so the import side knows what to expect.

## Reference (already built on the import side)

- `database/migrations/001_service_schema.sql` — the exact target tables/columns.
- `tools/import/esc_customer_list.py` — the customer importer already written;
  shows how customers/locations are normalized and matched on ESC numbers.
- `docs/ARCHITECTURE.md` — full design and ESC findings.
