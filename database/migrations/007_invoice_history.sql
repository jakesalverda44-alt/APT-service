-- 007: Invoice & AR history from ESC (Sales / SalesLed / RecLed / Receivab).
-- Archival like dispatch_history: ESC invoices stay separate from the active
-- service.invoices workflow. Receivables provide paid/balance so the Customer
-- Center can show ESC-style customer balance and aging.

CREATE TABLE IF NOT EXISTS service.invoice_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  esc_invoice_no  TEXT UNIQUE,
  customer_id     UUID REFERENCES service.customers(id) ON DELETE CASCADE,
  location_id     UUID REFERENCES service.locations(id) ON DELETE SET NULL,
  agreement_id    UUID REFERENCES service.agreements(id) ON DELETE SET NULL,
  esc_dispatch_no TEXT,
  inv_date        DATE,
  due_date        DATE,
  inv_type        TEXT,
  po_num          TEXT,
  terms           TEXT,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid            NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_off_date   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_history_customer_idx
  ON service.invoice_history (customer_id, inv_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS invoice_history_open_idx
  ON service.invoice_history (customer_id) WHERE amount > paid;

CREATE TABLE IF NOT EXISTS service.invoice_history_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_history_id UUID NOT NULL REFERENCES service.invoice_history(id) ON DELETE CASCADE,
  esc_line_no        TEXT,
  kind               TEXT,                 -- labor | part | flat (from ESC PType)
  prod               TEXT,
  description        TEXT,
  qty                NUMERIC(12,2),
  unit_price         NUMERIC(12,2),
  amount             NUMERIC(12,2),
  cost               NUMERIC(12,2),
  serial             TEXT,
  UNIQUE (invoice_history_id, esc_line_no)
);

CREATE TABLE IF NOT EXISTS service.payment_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  esc_entry_id    TEXT UNIQUE,
  customer_id     UUID REFERENCES service.customers(id) ON DELETE CASCADE,
  esc_invoice_no  TEXT,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  method          TEXT,
  check_no        TEXT,
  check_date      DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_history_customer_idx ON service.payment_history (customer_id);
CREATE INDEX IF NOT EXISTS payment_history_invoice_idx ON service.payment_history (esc_invoice_no);
