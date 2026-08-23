-- Migration 0025 granted service_role only SELECT/INSERT/UPDATE on
-- organization_upload_keys, never DELETE. This means the existing
-- DELETE /api/admin/upload-keys/:id route (adminUploadKeys.ts) has always
-- failed with "permission denied for table organization_upload_keys" —
-- discovered while writing integration tests for the csv_template Agent
-- branch that needed to delete their own throwaway upload keys during
-- cleanup. Purely additive; no behavior of any existing, working route
-- changes.

GRANT DELETE ON TABLE public.organization_upload_keys TO service_role;
