-- Run ONLY against the newly approved empty external database.
-- Fixtures live inside an exception subtransaction and are always rolled back.
-- No provider calls, AI outputs, or production execution records are fabricated.
DO $verification$
DECLARE
  m uuid := gen_random_uuid();
  w uuid := gen_random_uuid();
  cp uuid := gen_random_uuid();
  review uuid := gen_random_uuid();
  started timestamptz := clock_timestamp();
  c record;
  n bigint;
BEGIN
  FOR c IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', c.tablename) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'Verification requires empty application tables: %', c.tablename; END IF;
  END LOOP;
  BEGIN
    INSERT INTO public.missions(id,owner,title,subject,goal)
      VALUES(m,'controlled-isolated-verification','CONTROLLED DATABASE TEST','No real learner','Rolled back');
    INSERT INTO public.workflows(id,owner,mission_id,operation)
      VALUES(w,'controlled-isolated-verification',m,'controlled.database-verification');
    INSERT INTO public.drafts(mission_id,notes) VALUES(m,'original notes');
    INSERT INTO public.checkpoints(id,mission_id,workflow_id,notes,understanding,questions,reasoning,next_action,recall_question)
      VALUES(cp,m,w,'original notes','original understanding','original questions','original reasoning','original action','controlled question');
    IF (SELECT notes FROM public.checkpoints WHERE id=cp) <> 'original notes' THEN RAISE EXCEPTION 'Checkpoint readback failed'; END IF;
    BEGIN
      UPDATE public.checkpoints SET notes='must never persist' WHERE id=cp;
      RAISE EXCEPTION 'Checkpoint immutability not enforced';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'Checkpoints are immutable; create a new checkpoint instead' THEN RAISE; END IF;
    END;
    INSERT INTO public.ai_jobs(checkpoint_id,owner,workflow_id,failure_injection)
      VALUES(cp,'controlled-isolated-verification',w,true);
    BEGIN
      INSERT INTO public.ai_jobs(checkpoint_id,owner,workflow_id) VALUES(cp,'controlled-isolated-verification',w);
      RAISE EXCEPTION 'Duplicate job unexpectedly accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    UPDATE public.ai_jobs SET status='running',attempts=1,lease_until=now()-interval '1 second',lease_token=gen_random_uuid()
      WHERE checkpoint_id=cp;
    UPDATE public.ai_jobs SET status='queued',lease_until=NULL,lease_token=NULL,available_at=now()+interval '1 minute'
      WHERE checkpoint_id=cp AND lease_until<now();
    IF NOT EXISTS(SELECT 1 FROM public.ai_jobs WHERE checkpoint_id=cp AND status='queued' AND attempts=1 AND available_at>now())
      THEN RAISE EXCEPTION 'Durable delayed lease-recovery state failed'; END IF;
    UPDATE public.ai_jobs SET source='fallback',result='{"label":"CONTROLLED SQL fixture; no AI call"}'::jsonb WHERE checkpoint_id=cp;
    IF (SELECT notes FROM public.checkpoints WHERE id=cp) <> 'original notes' THEN RAISE EXCEPTION 'Original notes altered by separate job state'; END IF;
    INSERT INTO public.review_schedules(id,checkpoint_id,mission_id,owner,due_at)
      VALUES(review,cp,m,'controlled-isolated-verification',now()+interval '1 day');
    INSERT INTO public.recall_attempts(review_id,schedule_version,question,question_source,reference,workflow_id)
      VALUES(review,0,'Controlled question','fallback','{}'::jsonb,w);
    BEGIN
      INSERT INTO public.recall_attempts(review_id,schedule_version,question,question_source,reference,workflow_id)
        VALUES(review,0,'Duplicate','fallback','{}'::jsonb,w);
      RAISE EXCEPTION 'Duplicate review attempt unexpectedly accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.drafts(mission_id) VALUES(gen_random_uuid());
      RAISE EXCEPTION 'Broken foreign key unexpectedly accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    INSERT INTO public.execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details,source_component,destination_component)
      VALUES(w,1,'Controlled database verification','database','success',
        EXTRACT(epoch FROM clock_timestamp()-started)*1000,
        'Measured SQL verification; rolled back; no external AI call','SQL verification','PostgreSQL');
    BEGIN
      INSERT INTO public.execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details)
        VALUES(w,1,'Controlled duplicate','database','success',EXTRACT(epoch FROM clock_timestamp()-started)*1000,'Rolled back');
      RAISE EXCEPTION 'Duplicate event sequence unexpectedly accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    INSERT INTO public.request_records(owner,operation,key,hash,response)
      VALUES('controlled-isolated-verification','controlled.database-verification','one-key','controlled-fixture','{}'::jsonb);
    BEGIN
      INSERT INTO public.request_records(owner,operation,key,hash,response)
        VALUES('controlled-isolated-verification','controlled.database-verification','one-key','controlled-fixture','{}'::jsonb);
      RAISE EXCEPTION 'Duplicate idempotency key unexpectedly accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE SQLSTATE 'ZX001' USING MESSAGE='ROLLBACK_CONTROLLED_FIXTURES';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  FOR c IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', c.tablename) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'Fixture rollback failed: %', c.tablename; END IF;
  END LOOP;
END;
$verification$;
