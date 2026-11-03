-- Development-only defense in depth. Apply explicitly after Drizzle push.
-- This is not a server startup or production deployment migration.
CREATE OR REPLACE FUNCTION prevent_checkpoint_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Checkpoints are immutable; create a new checkpoint instead';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'checkpoints_immutable'
      AND tgrelid = 'checkpoints'::regclass
  ) THEN
    CREATE TRIGGER checkpoints_immutable
      BEFORE UPDATE ON checkpoints
      FOR EACH ROW EXECUTE FUNCTION prevent_checkpoint_update();
  END IF;
END;
$$;
