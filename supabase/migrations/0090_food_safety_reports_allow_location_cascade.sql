-- Bug fix: food_safety_cleaning_reports.location_id is ON DELETE SET NULL
-- (deleting a location must not destroy its historical reports), but the
-- blanket immutability trigger from migration 0088 rejected that cascade
-- UPDATE too — meaning any location with a completed report could never be
-- deleted at all, since the cascade itself would fail.
--
-- This replaces the reports table's trigger function with one that allows
-- exactly that one system-generated mutation (location_id going from a
-- value to null, with every other column byte-for-byte unchanged) while
-- still rejecting every other update and any delete. food_safety_cleaning_
-- report_items keeps the original, fully-strict trigger — it has no such
-- cascade to accommodate.

create or replace function public.food_safety_reports_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and NEW.location_id is null
     and OLD.location_id is not null
     and NEW.id = OLD.id
     and NEW.organization_id = OLD.organization_id
     and NEW.location_name_snapshot = OLD.location_name_snapshot
     and NEW.location_area_snapshot = OLD.location_area_snapshot
     and NEW.period_signature = OLD.period_signature
     and NEW.task_count = OLD.task_count
     and NEW.completed_at = OLD.completed_at
     and NEW.completed_by_user_id is not distinct from OLD.completed_by_user_id
     and NEW.completed_by_name = OLD.completed_by_name
     and NEW.completed_by_initials = OLD.completed_by_initials
  then
    return NEW;
  end if;

  raise exception 'This row is part of an immutable Food Safety report and cannot be changed.'
    using errcode = '42501';
end;
$$;

drop trigger if exists food_safety_cleaning_reports_immutable on public.food_safety_cleaning_reports;
create trigger food_safety_cleaning_reports_immutable
  before update or delete on public.food_safety_cleaning_reports
  for each row execute function public.food_safety_reports_prevent_mutation();
