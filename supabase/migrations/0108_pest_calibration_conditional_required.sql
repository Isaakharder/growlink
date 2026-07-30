-- Calibration module — forward-compatible placeholder for conditional
-- required fields (e.g. "Corrective action is required only when Result =
-- Fail").
--
-- Deliberately inert: nothing in the server (validation.ts, devices.ts) or
-- client reads or writes these columns yet. Full conditional-required logic
-- (evaluating one field's answer against another during validation, and
-- the builder UI to configure it) was judged too large to bundle with the
-- grouped/repeating-task work this migration accompanies, so only the
-- schema is added now, per explicit instruction, so a later pass can wire
-- up the actual behavior without another migration.
--
-- required_when_field_id references another field ON THE SAME TEMPLATE
-- (enforcement of that constraint is left to the API layer when this is
-- implemented, same as parent_field_id's one-level-of-nesting rule below
-- it — a DB CHECK can't easily validate "same template" across a
-- self-referencing FK without a trigger). required_when_equals holds the
-- value that field must equal for this field to become required (shape
-- deliberately left open — jsonb rather than a fixed type — since the
-- referenced field could be boolean (pass_fail), text (multiple_choice),
-- etc.).

alter table public.pest_calibration_template_fields
  add column if not exists required_when_field_id uuid references public.pest_calibration_template_fields(id) on delete set null;

alter table public.pest_calibration_template_fields
  add column if not exists required_when_equals jsonb;
