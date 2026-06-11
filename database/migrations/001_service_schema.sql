-- 001: The "service" schema — everything the service program owns lives here.
-- The CRM owns "public"; we read its tables (users, customers, projects,
-- generator_proposals, app_settings) but never create or alter them, except
-- the explicitly-guarded role addition below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS service;

-- ---------------------------------------------------------------------------
-- Customers & locations
--
-- ESC model preserved: an account-numbered customer (homeowner up to a
-- municipality) with one-to-many locations. The location is the working unit:
-- it carries the site address, access notes (gate codes), equipment, and all
-- job history. Phone labels in ESC vary by record vintage (Work/Home/Fax/
-- Cellular vs Phone/Mobile/Alt Phone), so phones are stored lossless as jsonb
-- {label: number}.
-- ---------------------------------------------------------------------------

CREATE TABLE service.customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  esc_account_no  TEXT UNIQUE,                 -- ESC Customer # (e.g. 0204179)
  crm_customer_id UUID,                        -- link to public.customers (FK added below if CRM present)
  name            TEXT NOT NULL,
  billing_address1 TEXT,
  billing_address2 TEXT,
  billing_city    TEXT,
  billing_state   TEXT,
  billing_zip     TEXT,
  phones          JSONB NOT NULL DEFAULT '{}',
  email           TEXT,
  credit_terms    TEXT,                        -- e.g. DUE ON RECEIPT
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customers_name_idx ON service.customers (LOWER(name));

CREATE TABLE service.locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES service.customers(id) ON DELETE CASCADE,
  esc_location_no TEXT,                        -- ESC per-customer Location # (e.g. 00001)
  name            TEXT,
  address1        TEXT,
  address2        TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  access_notes    TEXT,                        -- gate codes, dogs, key boxes
  contact_name    TEXT,
  phones          JSONB NOT NULL DEFAULT '{}',
  email           TEXT,
  tax_code        TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, esc_location_no)
);

CREATE INDEX locations_customer_idx ON service.locations (customer_id);
CREATE INDEX locations_name_idx     ON service.locations (LOWER(name));
CREATE INDEX locations_zip_idx      ON service.locations (zip);

CREATE TABLE service.equipment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID NOT NULL REFERENCES service.locations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'generator'
                CHECK (kind IN ('generator','ats','panel','pump','other')),
  manufacturer  TEXT,
  model         TEXT,
  serial        TEXT,
  kw            NUMERIC(8,2),
  fuel          TEXT CHECK (fuel IN ('natural_gas','propane','diesel','gasoline','other') OR fuel IS NULL),
  install_date  DATE,
  warranty_expires DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX equipment_location_idx ON service.equipment (location_id);

-- ---------------------------------------------------------------------------
-- Agreements (maintenance plans)
--
-- Mirrors ESC: numbered agreements with short type codes (SAR/SLC/GLC/PAR/FAR
-- = tier x residential/commercial), original-contract vs last-renewal vs
-- expiration dates, and major/minor visit counters ("3 YEAR SILVER, 3 MAJOR
-- REMAINING"). Tasks carry the per-visit checklist and next-due date that PM
-- job generation reads.
-- ---------------------------------------------------------------------------

CREATE TABLE service.agreements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  esc_agreement_no TEXT UNIQUE,
  customer_id      UUID NOT NULL REFERENCES service.customers(id),
  location_id      UUID REFERENCES service.locations(id),
  type_code        TEXT,                       -- SAR, SLC, GLC, PAR, FAR ...
  plan_name        TEXT,                       -- Silver, Gold, Platinum ...
  billing_freq     TEXT CHECK (billing_freq IN ('annual','semiannual','quarterly','monthly') OR billing_freq IS NULL),
  price            NUMERIC(12,2),
  original_contract_date DATE,
  last_renewal_date      DATE,
  expires_on             DATE,
  auto_renew       BOOLEAN NOT NULL DEFAULT false,
  visits_major_total     INT,
  visits_major_remaining INT,
  visits_minor_total     INT,
  visits_minor_remaining INT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agreements_customer_idx ON service.agreements (customer_id);
CREATE INDEX agreements_expiry_idx   ON service.agreements (expires_on) WHERE status = 'active';

CREATE TABLE service.agreement_equipment (
  agreement_id UUID NOT NULL REFERENCES service.agreements(id) ON DELETE CASCADE,
  equipment_id UUID NOT NULL REFERENCES service.equipment(id)  ON DELETE CASCADE,
  PRIMARY KEY (agreement_id, equipment_id)
);

CREATE TABLE service.agreement_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES service.agreements(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                 -- e.g. "Silver Service Plan for Air-cooled"
  kind          TEXT NOT NULL DEFAULT 'minor' CHECK (kind IN ('major','minor')),
  interval_months INT,
  next_due_on   DATE,
  checklist     JSONB NOT NULL DEFAULT '[]',   -- ["Change Engine Oil", "Replace Oil Filter", ...]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agreement_tasks_due_idx ON service.agreement_tasks (next_due_on);

-- ---------------------------------------------------------------------------
-- Jobs & dispatches
--
-- A job is the unit of work (ESC: dispatch ticket); a dispatch is one
-- scheduled tech visit against it. ESC keeps every reschedule as its own
-- schedule row — we do the same with multiple dispatches per job. Internal
-- time (vacation, shop) is a job type so the board shows availability.
-- Job numbers continue past ESC's range (~152xxx) to avoid collisions.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE service.job_number_seq START 200000;

CREATE TABLE service.jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number          BIGINT NOT NULL UNIQUE DEFAULT nextval('service.job_number_seq'),
  customer_id     UUID REFERENCES service.customers(id),
  location_id     UUID REFERENCES service.locations(id),
  equipment_id    UUID REFERENCES service.equipment(id),
  agreement_id    UUID REFERENCES service.agreements(id),
  agreement_task_id UUID REFERENCES service.agreement_tasks(id),
  crm_project_id  UUID,                        -- public.projects.id (FK added below if CRM present)
  type            TEXT NOT NULL DEFAULT 'repair'
                  CHECK (type IN ('pm','repair','install','warranty','callback','project','internal')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('emergency','high','normal','low')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('intake','pending','scheduled','in_progress','complete','invoiced','cancelled')),
  summary         TEXT,
  customer_po     TEXT,
  created_by      UUID,                        -- public.users.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX jobs_status_idx   ON service.jobs (status);
CREATE INDEX jobs_location_idx ON service.jobs (location_id);
CREATE INDEX jobs_crm_idx      ON service.jobs (crm_project_id);

CREATE TABLE service.dispatches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES service.jobs(id) ON DELETE CASCADE,
  tech_id         UUID,                        -- public.users.id (FK added below if CRM present)
  scheduled_start TIMESTAMPTZ,
  scheduled_end   TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','dispatched','enroute','onsite','complete','cancelled')),
  time_in         TIMESTAMPTZ,
  time_out        TIMESTAMPTZ,
  signature       TEXT,                        -- data-url from signature pad
  photos          JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX dispatches_job_idx   ON service.dispatches (job_id);
CREATE INDEX dispatches_board_idx ON service.dispatches (tech_id, scheduled_start);

-- Append-only note timeline per job (admin scheduling notes + tech field
-- notes), matching ESC's dispatch-notes behavior: notes are never edited or
-- deleted, only added.
CREATE TABLE service.job_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES service.jobs(id) ON DELETE CASCADE,
  author_id  UUID,                             -- public.users.id
  author_name TEXT,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX job_notes_job_idx ON service.job_notes (job_id, created_at);

CREATE TABLE service.job_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES service.jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'part' CHECK (kind IN ('labor','part','flat')),
  description TEXT NOT NULL,
  qty         NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_cost   NUMERIC(12,2),
  unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX job_lines_job_idx ON service.job_lines (job_id);

-- ---------------------------------------------------------------------------
-- Invoices & payments (QBO-sync ready)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE service.invoice_number_seq START 50000;

CREATE TABLE service.invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number       BIGINT NOT NULL UNIQUE DEFAULT nextval('service.invoice_number_seq'),
  customer_id  UUID NOT NULL REFERENCES service.customers(id),
  location_id  UUID REFERENCES service.locations(id),
  job_id       UUID REFERENCES service.jobs(id),
  agreement_id UUID REFERENCES service.agreements(id),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','void')),
  terms        TEXT,
  customer_po  TEXT,
  subtotal     NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_due  NUMERIC(12,2) NOT NULL DEFAULT 0,
  issued_on    DATE,
  due_on       DATE,
  qbo_id           TEXT,
  qbo_sync_status  TEXT NOT NULL DEFAULT 'unsynced'
                   CHECK (qbo_sync_status IN ('unsynced','pending','synced','error')),
  qbo_sync_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invoices_customer_idx ON service.invoices (customer_id);
CREATE INDEX invoices_status_idx   ON service.invoices (status);
CREATE INDEX invoices_qbo_idx      ON service.invoices (qbo_sync_status) WHERE qbo_sync_status IN ('pending','error');

CREATE TABLE service.payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES service.invoices(id),
  method      TEXT NOT NULL DEFAULT 'check' CHECK (method IN ('check','card','cash','ach','other')),
  amount      NUMERIC(12,2) NOT NULL,
  reference   TEXT,
  received_on DATE NOT NULL DEFAULT CURRENT_DATE,
  qbo_id      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_invoice_idx ON service.payments (invoice_id);

-- ---------------------------------------------------------------------------
-- CRM intake queue: awarded projects land here (trigger added in 002).
-- ---------------------------------------------------------------------------

CREATE TABLE service.project_intake (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_project_id UUID NOT NULL UNIQUE,
  source_type    TEXT,                         -- 'elec' | 'gen'
  payload        JSONB NOT NULL DEFAULT '{}',  -- snapshot of the project row at award time
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  job_id         UUID REFERENCES service.jobs(id)
);

-- ---------------------------------------------------------------------------
-- Conditional links into the CRM schema. Guarded so this migration also runs
-- on a bare database (local dev / CI) where the CRM tables don't exist.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.customers') IS NOT NULL THEN
    ALTER TABLE service.customers
      ADD CONSTRAINT customers_crm_fk FOREIGN KEY (crm_customer_id) REFERENCES public.customers(id);
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    ALTER TABLE service.jobs
      ADD CONSTRAINT jobs_crm_project_fk FOREIGN KEY (crm_project_id) REFERENCES public.projects(id);
    ALTER TABLE service.project_intake
      ADD CONSTRAINT intake_crm_project_fk FOREIGN KEY (crm_project_id) REFERENCES public.projects(id);
  END IF;

  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE service.dispatches
      ADD CONSTRAINT dispatches_tech_fk FOREIGN KEY (tech_id) REFERENCES public.users(id);
    -- Add the dispatcher role to the CRM's shared users table (additive only).
    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN (
      'owner','administrator','sales_manager','salesperson','estimator',
      'project_manager','technician','accounting','read_only','dispatcher'
    ));
  END IF;
END $$;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION service.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','locations','equipment','agreements','jobs','dispatches','invoices'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON service.%I FOR EACH ROW EXECUTE FUNCTION service.touch_updated_at()',
      t, t);
  END LOOP;
END $$;
