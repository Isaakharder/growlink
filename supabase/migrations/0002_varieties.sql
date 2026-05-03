create extension if not exists pgcrypto;

create table if not exists public.varieties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  area_m2 numeric not null default 0 check (area_m2 >= 0),
  case_kg numeric not null default 0 check (case_kg >= 0),
  planting_date date,
  pull_out_date date,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
