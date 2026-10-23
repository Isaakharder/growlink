# Case history backup, reset and restore (one organization)

Prepared for: clearing an organization's existing GrowLink case history and
re-entering it pack by pack with Manual Add Case Entry. **Nothing here runs
automatically and nothing has been run against production.**

Run as `postgres` in the Supabase SQL editor (or `psql`), one step at a time.
Replace `ORG_ID` with the organization's id (`select id, name from organizations;`).

## What is cleared

| Table | Rows | Cleared? |
|---|---|---|
| `color_case_entries` | all of the org's weekly colour totals — DockLink colour sync rows **and** older manual colour entries, every year | **Yes, always** |
| `manual_pack_case_entries` | manual pack entries (e.g. test entries made while trying the new screen) | Only with `clear_manual_entries => true` |
| `case_week_sources` | per-week source choices | Only with `clear_manual_entries => true` |
| `historical_packs` | old-invoice pack definitions | No (backed up) |
| `pack_case_measurements` | weekly kg/case and rainbow measurements | No (backed up) |
| `docklink_pack_sync_state`, `docklink_packs`, `docklink_pack_weekly_shipments` | DockLink's pack catalogue and pack shipments | No (backed up; owned by the DockLink sync) |
| Every other table (harvest `yield_entries`, varieties, projections, …) | — | No, and not backed up |

Only rows with `organization_id = ORG_ID` are read, backed up or deleted.

## Before you start

1. **The DockLink colour sync re-imports colour totals.** Clearing
   `color_case_entries` does not stop "Sync DockLink Cases" from bringing every
   week DockLink has colour totals for back on the next sync. That is safe for
   weeks you have re-entered — a week with manual entries records
   *manual pack entries* as its source when the first entry is saved, so synced
   colour totals for it are kept but not counted. Weeks you have not re-entered
   yet will show synced colour totals again until you do. If that is not what
   you want, don't run the sync until the re-entry is finished.
2. Deploy migrations 0143 and 0144 first and check that the new screen works in
   production with a test entry or two (clear them with `clear_manual_entries => true`).
3. Optional off-database copy: Table editor → `color_case_entries` → filter
   `organization_id = ORG_ID` → Export CSV.

## Steps

```sql
-- 1. Install the tooling (safe to re-run).
\i supabase/maintenance/case_history_reset/01_setup.sql   -- or paste the file into the SQL editor

-- 2. Back up. Keep the returned backup_id.
select case_history_backup.take_backup('ORG_ID', 'before pack re-entry');

-- 3. Check what was captured.
select backup_id, label, created_at, row_counts from case_history_backup.backups
 where organization_id = 'ORG_ID' order by created_at desc;

-- 4. Reset (refuses if anything changed since the backup, or if the confirmation text is wrong).
select case_history_backup.reset_case_history('ORG_ID', 'BACKUP_ID', false, 'RESET ORG_ID');
--    use true instead of false to also clear manual pack entries and week choices
```

The reset returns the number of rows deleted per table. Everything happens in
one transaction: an error leaves the data unchanged.

## Restore

```sql
select case_history_backup.restore_case_history('ORG_ID', 'BACKUP_ID', 'RESTORE ORG_ID');
```

- Puts back exactly the backed-up rows (same ids, same values) of the tables a
  reset clears, and verifies them by checksum.
- Rows written after the backup — colour totals re-synced, entries re-entered —
  are replaced, so they are first saved automatically in a new backup labelled
  `pre-restore of BACKUP_ID` (its id is in the result). Restoring that one
  undoes the restore.
- Fails, changing nothing, if a manual entry in the backup points at a
  historical pack that has since been deleted.
- Measurements, historical packs and DockLink pack data are never changed by a
  reset, so they are not restored either; their backed-up copies are in
  `case_history_backup.<table>` (`where backup_id = 'BACKUP_ID'`) if needed.

## Audit and clean-up

```sql
select * from case_history_backup.operations where organization_id = 'ORG_ID' order by performed_at;
-- When the backup is no longer needed (after the re-entry is confirmed):
-- drop schema case_history_backup cascade;
```

The schema has no privileges for the API roles and is not exposed through the API.
Tested end to end (backup, refused resets, reset, re-sync, restore, organization
isolation) by `server/src/__tests__/caseHistoryReset.pglite.test.ts`.
