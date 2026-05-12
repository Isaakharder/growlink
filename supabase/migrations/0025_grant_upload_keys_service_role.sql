-- Grant the API server service role the access it needs for upload key validation.

GRANT SELECT, INSERT, UPDATE ON TABLE public.organization_upload_keys TO service_role;
