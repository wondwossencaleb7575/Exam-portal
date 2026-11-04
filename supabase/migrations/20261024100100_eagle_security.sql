-- =====================================================================================================================
-- Eagle Labs Exam Portal: database security
--
-- THREAT MODEL. The browser never connects to Supabase. Only the application server does, through the DB role
-- "eagle_app". Student/teacher/admin permissions are enforced by that server (lib/auth.js, routes/*), exactly as before.
-- The database adds independent locks so that a leaked anon key, a leaked service-role key, or a mistake in the Data API
-- settings still cannot reach student data or answer keys:
--
--   Lock 1  The schema "eagle" is not exposed by the Data API (leave it out of Settings > API > Exposed schemas).
--   Lock 2  anon, authenticated and service_role have NO privileges on the schema, its tables, sequences or functions.
--   Lock 3  Row Level Security is ENABLED on every table, and the ONLY policy names the application role "eagle_app".
--           anon/authenticated therefore match no policy: even if a grant were added by mistake, they would see zero rows.
--   Lock 4  eagle_app has only the table privileges the application really uses (no DELETE on users/attempts/answers, and
--           no UPDATE/DELETE at all on audit and grade_history). It is not a superuser, does not bypass RLS and cannot do DDL.
--
-- The "using (true)" policies below are deliberately scoped TO eagle_app only. They are not "open access": the server is the
-- trusted component, and per-user rules are enforced in code and covered by tests/api.test.js and tests/hardening.test.js.
-- =====================================================================================================================

-- ---------- the application role (no password is stored in Git: set it once, see docs/SUPABASE.md step 4) ----------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'eagle_app') then
    create role eagle_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
alter role eagle_app set search_path = eagle, pg_temp;

-- ---------- Locks 1 and 2: nothing for the API roles ----------
revoke all on schema eagle from public, anon, authenticated, service_role;
revoke all on all tables    in schema eagle from public, anon, authenticated, service_role;
revoke all on all sequences in schema eagle from public, anon, authenticated, service_role;
revoke all on all functions in schema eagle from public, anon, authenticated, service_role;

-- Future tables/functions created in this schema must not become reachable by the API roles either, whoever creates them.
do $$
begin
  execute format('alter default privileges for role %I in schema eagle revoke all on tables    from public, anon, authenticated, service_role', current_user);
  execute format('alter default privileges for role %I in schema eagle revoke all on sequences from public, anon, authenticated, service_role', current_user);
  execute format('alter default privileges for role %I in schema eagle revoke all on functions from public, anon, authenticated, service_role', current_user);
end $$;

-- ---------- Lock 4: exactly the privileges the application uses ----------
grant usage on schema eagle to eagle_app;
grant select, insert, update          on eagle.users           to eagle_app;
grant select, insert, delete          on eagle.sessions        to eagle_app;
grant select, insert                  on eagle.subjects        to eagle_app;
grant select, insert, update          on eagle.classes         to eagle_app;
grant select, insert, delete          on eagle.class_members   to eagle_app;
grant select, insert                  on eagle.images          to eagle_app;
grant select, insert, update          on eagle.questions       to eagle_app;
grant select, insert, update, delete  on eagle.exams           to eagle_app;
grant select, insert, delete          on eagle.exam_classes    to eagle_app;
grant select, insert, delete          on eagle.exam_students   to eagle_app;
grant select, insert, update, delete  on eagle.exam_questions  to eagle_app;
grant select, insert, update          on eagle.accommodations  to eagle_app;
grant select, insert, update          on eagle.attempts        to eagle_app;
grant select, insert, update          on eagle.answers         to eagle_app;
grant select, insert, update, delete  on eagle.grades          to eagle_app;
grant select, insert                  on eagle.grade_history   to eagle_app;   -- append-only
grant select, insert                  on eagle.attempt_events  to eagle_app;
grant select, insert                  on eagle.audit           to eagle_app;   -- append-only
grant select, update                  on eagle.school_settings to eagle_app;
grant select, insert, update, delete  on eagle.otp_challenges  to eagle_app;
grant select, insert, delete          on eagle.otp_events      to eagle_app;
grant select                          on eagle.schema_migrations to eagle_app;

-- ---------- Lock 3: Row Level Security on EVERY table ----------
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'eagle' and c.relkind = 'r' order by 1
  loop
    execute format('alter table eagle.%I enable row level security', t);
    execute format('create policy eagle_app_only on eagle.%I for all to eagle_app using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- self-check: this migration FAILS (and rolls back) if the result is not what the comments above promise ----------
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'eagle' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'Row Level Security is not enabled on: %', bad; end if;

  select string_agg(distinct table_name || ' -> ' || grantee, ', ') into bad from information_schema.role_table_grants
   where table_schema = 'eagle' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');
  if bad is not null then raise exception 'API roles still hold table privileges: %', bad; end if;

  select string_agg(distinct p.policyname || ' on ' || p.tablename, ', ') into bad from pg_policies p
   where p.schemaname = 'eagle' and not (p.roles = array['eagle_app']::name[]);
  if bad is not null then raise exception 'A policy is not restricted to eagle_app only: %', bad; end if;
end $$;

insert into eagle.schema_migrations(version, name) values ('20261024100100', 'eagle_security') on conflict do nothing;
