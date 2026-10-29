-- Remove the retired Yield → Data Entry → Projected feature.
--
-- yield_projections (0043/0044/0045) held only the manual weekly projections
-- entered on that tab, and was read and written only by its routes
-- (server/src/routes/yieldProjections.ts, removed in the same change). No
-- other table, view, function or foreign key references it; its varieties
-- reference points outward, so dropping it leaves varieties untouched. The
-- mobile Daily Yield sampling projection is a separate system and does not
-- use this table.
--
-- Production held 45 rows (one organization, colour-level kg, 2026), last
-- written 2026-06-20 13:26:15 UTC. They were exported to a restore script
-- before this migration was applied.

-- Abort rather than drop rows written after that export.
do $$
begin
  if exists (
    select 1 from public.yield_projections
    where greatest(created_at, updated_at) > '2026-06-20 13:26:15.298448+00'
  ) then
    raise exception 'yield_projections has rows written after the 2026-10-28 export; take a new backup before dropping';
  end if;
end $$;

-- No CASCADE: if anything unexpected depends on this table, the drop fails
-- instead of removing it too. Its indexes, constraints and RLS policies go
-- with the table.
drop table public.yield_projections;
