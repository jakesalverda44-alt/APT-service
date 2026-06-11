-- 002: Automatic CRM -> service handoff.
-- The CRM inserts into public.projects the moment a bid or generator proposal
-- is awarded. This trigger snapshots that row into service.project_intake so
-- the service program can turn it into a job. Guarded: on a bare database
-- (no CRM) the trigger is skipped; the backfill below also recovers anything
-- awarded while the trigger didn't exist yet.

CREATE OR REPLACE FUNCTION service.enqueue_awarded_project() RETURNS trigger AS $$
BEGIN
  INSERT INTO service.project_intake (crm_project_id, source_type, payload)
  VALUES (NEW.id, NEW.source_type, to_jsonb(NEW))
  ON CONFLICT (crm_project_id) DO NOTHING;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS service_project_intake ON public.projects;
    CREATE TRIGGER service_project_intake
      AFTER INSERT ON public.projects
      FOR EACH ROW EXECUTE FUNCTION service.enqueue_awarded_project();

    -- Backfill: queue any existing active projects not yet seen.
    INSERT INTO service.project_intake (crm_project_id, source_type, payload, received_at)
    SELECT p.id, p.source_type, to_jsonb(p), p.created_at
    FROM public.projects p
    WHERE p.deleted_at IS NULL
    ON CONFLICT (crm_project_id) DO NOTHING;
  END IF;
END $$;
