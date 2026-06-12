-- 004: Quotes (ESC quote module) — used for quoting repairs. A quote carries
-- its own parts/labor lines; accepting it creates the job and copies the
-- lines over, so the invoice later matches what was quoted.

CREATE SEQUENCE service.quote_number_seq START 70000;

CREATE TABLE service.quotes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number       BIGINT NOT NULL UNIQUE DEFAULT nextval('service.quote_number_seq'),
  customer_id  UUID NOT NULL REFERENCES service.customers(id),
  location_id  UUID REFERENCES service.locations(id),
  equipment_id UUID REFERENCES service.equipment(id),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','accepted','declined','expired')),
  summary      TEXT,
  tax          NUMERIC(12,2) NOT NULL DEFAULT 0,
  valid_until  DATE,
  notes        TEXT,
  job_id       UUID REFERENCES service.jobs(id),   -- set when accepted
  accepted_at  TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quotes_customer_idx ON service.quotes (customer_id);
CREATE INDEX quotes_status_idx   ON service.quotes (status);

CREATE TABLE service.quote_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    UUID NOT NULL REFERENCES service.quotes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'part' CHECK (kind IN ('labor','part','flat')),
  description TEXT NOT NULL,
  qty         NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_cost   NUMERIC(12,2),
  unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quote_lines_quote_idx ON service.quote_lines (quote_id);

CREATE TRIGGER quotes_touch BEFORE UPDATE ON service.quotes
  FOR EACH ROW EXECUTE FUNCTION service.touch_updated_at();
