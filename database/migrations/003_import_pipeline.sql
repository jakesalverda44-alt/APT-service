-- 003: ESC import pipeline.
-- Raw rows from parsed ESC reports land untouched in import_rows (jsonb),
-- grouped by batch. service.import_normalize(batch) then upserts them into
-- customers/locations keyed on ESC account/location numbers, so re-running a
-- batch (or importing overlapping reports) is idempotent. Rows that fail keep
-- their error message for the review screen.

CREATE TABLE service.import_batches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source     TEXT NOT NULL,                    -- e.g. 'esc_customer_list_pdf'
  filename   TEXT,
  filters    TEXT,                             -- report filter footer, e.g. zip range
  stats      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service.import_rows (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id  UUID NOT NULL REFERENCES service.import_batches(id) ON DELETE CASCADE,
  row_kind  TEXT NOT NULL CHECK (row_kind IN ('customer','location','equipment','agreement')),
  raw       JSONB NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','imported','error','skipped')),
  error     TEXT,
  target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX import_rows_batch_idx ON service.import_rows (batch_id, status);

CREATE OR REPLACE FUNCTION service.import_normalize(p_batch UUID)
RETURNS TABLE (kind TEXT, imported INT, errored INT) AS $$
DECLARE
  r RECORD;
  v_customer UUID;
  n_cust_ok INT := 0; n_cust_err INT := 0;
  n_loc_ok  INT := 0; n_loc_err  INT := 0;
BEGIN
  -- Customers first so locations can resolve their parent.
  FOR r IN SELECT * FROM service.import_rows
           WHERE batch_id = p_batch AND row_kind = 'customer' AND status = 'pending'
           ORDER BY created_at LOOP
    BEGIN
      INSERT INTO service.customers
        (esc_account_no, name, billing_address1, billing_address2,
         billing_city, billing_state, billing_zip, phones, notes)
      VALUES
        (r.raw->>'esc_account_no', r.raw->>'name',
         r.raw->>'address1', r.raw->>'address2',
         r.raw->>'city', r.raw->>'state', r.raw->>'zip',
         COALESCE(r.raw->'phones', '{}'::jsonb), NULLIF(r.raw->>'notes',''))
      ON CONFLICT (esc_account_no) DO UPDATE SET
        name             = EXCLUDED.name,
        billing_address1 = COALESCE(EXCLUDED.billing_address1, service.customers.billing_address1),
        billing_address2 = COALESCE(EXCLUDED.billing_address2, service.customers.billing_address2),
        billing_city     = COALESCE(EXCLUDED.billing_city,  service.customers.billing_city),
        billing_state    = COALESCE(EXCLUDED.billing_state, service.customers.billing_state),
        billing_zip      = COALESCE(EXCLUDED.billing_zip,   service.customers.billing_zip),
        phones           = service.customers.phones || EXCLUDED.phones
      RETURNING id INTO v_customer;

      UPDATE service.import_rows SET status = 'imported', target_id = v_customer, error = NULL
      WHERE id = r.id;
      n_cust_ok := n_cust_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE service.import_rows SET status = 'error', error = SQLERRM WHERE id = r.id;
      n_cust_err := n_cust_err + 1;
    END;
  END LOOP;

  FOR r IN SELECT * FROM service.import_rows
           WHERE batch_id = p_batch AND row_kind = 'location' AND status = 'pending'
           ORDER BY created_at LOOP
    BEGIN
      SELECT id INTO v_customer FROM service.customers
      WHERE esc_account_no = r.raw->>'customer_esc_account_no';
      IF v_customer IS NULL THEN
        RAISE EXCEPTION 'parent customer % not found', r.raw->>'customer_esc_account_no';
      END IF;

      INSERT INTO service.locations
        (customer_id, esc_location_no, name, address1, address2,
         city, state, zip, access_notes, phones, notes)
      VALUES
        (v_customer, r.raw->>'esc_location_no', r.raw->>'name',
         r.raw->>'address1', r.raw->>'address2',
         r.raw->>'city', r.raw->>'state', r.raw->>'zip',
         NULLIF(r.raw->>'access_notes',''),
         COALESCE(r.raw->'phones', '{}'::jsonb), NULLIF(r.raw->>'notes',''))
      ON CONFLICT (customer_id, esc_location_no) DO UPDATE SET
        name         = EXCLUDED.name,
        address1     = COALESCE(EXCLUDED.address1, service.locations.address1),
        address2     = COALESCE(EXCLUDED.address2, service.locations.address2),
        city         = COALESCE(EXCLUDED.city,  service.locations.city),
        state        = COALESCE(EXCLUDED.state, service.locations.state),
        zip          = COALESCE(EXCLUDED.zip,   service.locations.zip),
        access_notes = COALESCE(EXCLUDED.access_notes, service.locations.access_notes),
        phones       = service.locations.phones || EXCLUDED.phones
      RETURNING id INTO STRICT v_customer;  -- reuse var for location id

      UPDATE service.import_rows SET status = 'imported', target_id = v_customer, error = NULL
      WHERE id = r.id;
      n_loc_ok := n_loc_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE service.import_rows SET status = 'error', error = SQLERRM WHERE id = r.id;
      n_loc_err := n_loc_err + 1;
    END;
  END LOOP;

  UPDATE service.import_batches
  SET stats = stats || jsonb_build_object(
    'customers_imported', n_cust_ok, 'customers_errored', n_cust_err,
    'locations_imported', n_loc_ok,  'locations_errored', n_loc_err,
    'normalized_at', now())
  WHERE id = p_batch;

  RETURN QUERY VALUES ('customer', n_cust_ok, n_cust_err), ('location', n_loc_ok, n_loc_err);
END $$ LANGUAGE plpgsql;
