-- =====================================================================================================================
-- Eagle Labs Exam Portal: user lifecycle (deactivate / restore / permanently delete)
--
-- ADDITIVE AND NON-DESTRUCTIVE. This migration changes NO existing row, drops NO table or column, and adds NO table or column.
--   1. users.status may now also be 'deleted'. ('active' and 'suspended' are unchanged: 'suspended' is what the portal shows as
--      "Deactivated".) The CHECK constraint is replaced by a wider one, so every existing row still satisfies it.
--   2. A trigger on eagle.users that enforces two rules inside the database itself, whatever the application code does:
--        - the LAST active administrator can never be deactivated, deleted or demoted (checked under a lock, so two administrators
--          removing each other at the same moment cannot both succeed);
--        - a 'deleted' account is final: it can never be changed again (no re-activation, no new e-mail or password).
--
-- Compatible with the application version that is running now: that version only ever writes 'active' or 'suspended'.
-- Apply it BEFORE deploying the new code (npm run migrate). Back up first: see DEPLOYMENT.md.
-- Permanent deletion never issues a SQL DELETE on users (the application role has no such privilege, by design): the account row is
-- anonymised in place so exam attempts, grades and reports keep their integrity. See lib/userLifecycle.js.
-- =====================================================================================================================

-- 1. Widen the status check. The existing constraint is found by what it checks, not by an assumed name.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'eagle.users'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%suspended%'
  loop
    execute format('alter table eagle.users drop constraint %I', c.conname);
  end loop;
end $$;
alter table eagle.users add constraint users_status_check check (status in ('active', 'suspended', 'deleted'));

-- 2. Guard trigger.
create or replace function eagle.guard_user_lifecycle() returns trigger language plpgsql as $$
begin
  if old.status = 'deleted' then
    raise exception 'a deleted account cannot be changed' using errcode = 'restrict_violation';
  end if;
  if old.role = 'admin' and old.status = 'active' and not (new.role = 'admin' and new.status = 'active') then
    perform pg_advisory_xact_lock(727275);   -- serialises concurrent attempts; the count below then sees the other transaction's result
    if not exists (select 1 from eagle.users where role = 'admin' and status = 'active' and id <> old.id) then
      raise exception 'the last active administrator cannot be removed' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists users_lifecycle_guard on eagle.users;
create trigger users_lifecycle_guard before update on eagle.users
  for each row execute function eagle.guard_user_lifecycle();

insert into eagle.schema_migrations(version, name) values ('20261111000000', 'user_lifecycle') on conflict do nothing;
