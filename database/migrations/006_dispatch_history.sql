-- 006: Service history from ESC dispatches.
-- Historical ESC dispatches are archival (53k+ rows) — they belong in their own
-- table, not the active jobs/board workflow. The Customer Center shows them as
-- "Recent Dispatches" (matching ESC's panel); the note text is preserved.

CREATE TABLE IF NOT EXISTS service.dispatch_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  esc_dispatch_no TEXT UNIQUE,
  customer_id     UUID REFERENCES service.customers(id) ON DELETE CASCADE,
  location_id     UUID REFERENCES service.locations(id) ON DELETE SET NULL,
  agreement_id    UUID REFERENCES service.agreements(id) ON DELETE SET NULL,
  esc_agreement_no TEXT,
  type            TEXT,
  priority        TEXT,
  received_date   DATE,
  completed_date  DATE,
  invoice_no      TEXT,
  summary         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_history_customer_idx
  ON service.dispatch_history (customer_id, received_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS dispatch_history_location_idx
  ON service.dispatch_history (location_id, received_date DESC NULLS LAST);
