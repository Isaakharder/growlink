-- Add new columns to pest_chemicals
alter table public.pest_chemicals
  add column if not exists phi text,
  add column if not exists chemical_group text,
  add column if not exists chemical_type text,
  add column if not exists active_ingredients text,
  add column if not exists registration_number text,
  add column if not exists label_pdf_path text;

-- Add check constraint for chemical_type (allows null)
alter table public.pest_chemicals
  add constraint pest_chemicals_chemical_type_check
  check (
    chemical_type is null
    or chemical_type in ('fungicide', 'insecticide', 'herbicide', 'pesticide')
  );

-- Make rate_value and rate_basis nullable for backward compatibility.
-- The existing check constraints (>= 0, in (...)) still hold for non-null values.
alter table public.pest_chemicals
  alter column rate_value drop not null,
  alter column rate_basis drop not null;

-- Supabase Storage bucket for chemical label PDFs.
-- The server uses the service-role key, which bypasses storage RLS,
-- so no additional storage policies are required for server-side uploads/signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pest-chemical-labels',
  'pest-chemical-labels',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do nothing;
