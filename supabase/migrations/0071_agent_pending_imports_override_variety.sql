-- Migration 0071: manual variety override for agent pending imports
--
-- Lets a reviewer reassign an individual FlowMaster PDF/lot reading to a
-- different variety before import, for cases where the warehouse operator
-- forgot to change the variety name on the FlowMaster computer. The PDF's
-- raw parsed variety_name is preserved untouched; override_variety_id takes
-- precedence over the name-matched variety when both GET and PATCH
-- /api/agent-pending-imports resolve the effective variety for a row.

ALTER TABLE public.agent_pending_imports
  ADD COLUMN override_variety_id uuid NULL REFERENCES public.varieties(id) ON DELETE SET NULL;

CREATE INDEX agent_pending_imports_override_variety_idx
  ON public.agent_pending_imports (override_variety_id)
  WHERE override_variety_id IS NOT NULL;
