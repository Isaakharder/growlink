-- Adds 'csv_template' as a valid organization_upload_keys.data_source_type,
-- alongside the existing 'flowmaster' and 'generic_csv'. An org's upload
-- key can now route CSV uploads through the generic CSV Import Template
-- Builder (csv_mapping_templates) instead of the hard-coded FlowMaster
-- parser or the admin-only import_source_templates system. Default stays
-- 'flowmaster' — no existing key is affected until an admin explicitly
-- changes it.

ALTER TABLE public.organization_upload_keys
  DROP CONSTRAINT organization_upload_keys_data_source_type_check;

ALTER TABLE public.organization_upload_keys
  ADD CONSTRAINT organization_upload_keys_data_source_type_check
  CHECK (data_source_type IN ('flowmaster', 'generic_csv', 'csv_template'));
