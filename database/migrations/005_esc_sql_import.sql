-- 005: Support the full ESC SQL-Server export (CSV per table).
-- Adds the ESC keys needed for idempotent upserts of equipment and agreement
-- tasks, and opens import_rows to the new row kinds.

ALTER TABLE service.equipment ADD COLUMN IF NOT EXISTS esc_counter TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS equipment_esc_uniq
  ON service.equipment (location_id, esc_counter) WHERE esc_counter IS NOT NULL;

ALTER TABLE service.agreement_tasks ADD COLUMN IF NOT EXISTS esc_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agreement_tasks_esc_uniq
  ON service.agreement_tasks (agreement_id, esc_key) WHERE esc_key IS NOT NULL;

-- Location rows from the SQL export carry the ESC contact name; customers
-- carry no email (ESC stores email on the location).
ALTER TABLE service.import_rows DROP CONSTRAINT IF EXISTS import_rows_row_kind_check;
