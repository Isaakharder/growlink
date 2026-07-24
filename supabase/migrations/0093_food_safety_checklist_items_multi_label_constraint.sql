-- Bug fix: the unique constraint on (checklist_id, task_id) from migration
-- 0085 assumed one checklist item per task. Since 0092, a checkbox task
-- with multiple labels legitimately expands into multiple items sharing the
-- same task_id — which violated that constraint the moment a task had more
-- than one checkbox. Replace it with (checklist_id, task_id,
-- action_label_snapshot), which still catches genuine accidental duplicates
-- (e.g. a concurrent double-run of the get-or-create RPC) while allowing
-- one row per configured label.

alter table public.food_safety_cleaning_checklist_items
  drop constraint if exists food_safety_cleaning_checklist_items_checklist_task_key;

alter table public.food_safety_cleaning_checklist_items
  add constraint food_safety_cleaning_checklist_items_checklist_task_label_key
  unique (checklist_id, task_id, action_label_snapshot);
