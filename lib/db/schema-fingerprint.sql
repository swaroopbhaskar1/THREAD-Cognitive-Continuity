WITH definitions AS (
  SELECT 'column:'||table_name||':'||ordinal_position||':'||column_name||':'||
    data_type||':'||udt_name||':'||is_nullable||':'||COALESCE(column_default,'') AS value
    FROM information_schema.columns WHERE table_schema='public'
  UNION ALL
  SELECT 'constraint:'||r.relname||':'||c.conname||':'||c.contype::text||':'||
    pg_get_constraintdef(c.oid,true)||':'||c.convalidated||':'||c.condeferrable||':'||c.condeferred
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'index:'||tablename||':'||indexname||':'||indexdef FROM pg_indexes WHERE schemaname='public'
  UNION ALL
  SELECT 'trigger:'||r.relname||':'||t.tgname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid,true)
    FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'function:'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'sequence:'||sequence_name||':'||data_type||':'||start_value||':'||minimum_value||':'||maximum_value||':'||increment||':'||cycle_option
    FROM information_schema.sequences WHERE sequence_schema='public'
  UNION ALL
  SELECT 'rls:'||r.relname||':'||r.relrowsecurity||':'||r.relforcerowsecurity
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relkind='r'
)
SELECT md5(string_agg(value,E'\n' ORDER BY value)) AS schema_fingerprint,
  COUNT(*)::int AS compared_definitions FROM definitions;
