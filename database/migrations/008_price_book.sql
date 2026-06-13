-- 008: Parts & labor price book. ESC invoice lines used product codes 96% of
-- the time — the office works from a catalog. Lines can be seeded from the
-- imported ESC invoice history (latest price/cost per product code) and then
-- maintained in-app. Used by autocomplete on quote/job/field line entry.

CREATE TABLE IF NOT EXISTS service.price_book (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT UNIQUE,
  description TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'part' CHECK (kind IN ('labor','part','flat')),
  cost        NUMERIC(12,2),
  price       NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable     BOOLEAN NOT NULL DEFAULT true,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_book_code_idx ON service.price_book (LOWER(code));
CREATE INDEX IF NOT EXISTS price_book_desc_idx ON service.price_book (LOWER(description));

CREATE TRIGGER price_book_touch BEFORE UPDATE ON service.price_book
  FOR EACH ROW EXECUTE FUNCTION service.touch_updated_at();
