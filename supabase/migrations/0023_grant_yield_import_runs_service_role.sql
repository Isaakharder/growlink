-- Fix permissions for server-side lot-history checks.
-- Keep table protected by RLS and only grant what the API server needs.

GRANT SELECT, INSERT ON TABLE public.yield_import_runs TO service_role;
