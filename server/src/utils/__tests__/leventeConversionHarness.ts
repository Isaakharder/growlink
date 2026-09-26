// Shared PGlite setup for the migration 0139 tests: the production tables
// 0139 touches, loaded with First Light's read-only 2026 snapshot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const ROOT = join(__dirname, "..", "..", "..", "..");
export const M0139 = readFileSync(join(ROOT, "supabase", "migrations", "0139_convert_legacy_levente.sql"), "utf-8");
export const ROLLBACK = readFileSync(join(ROOT, "supabase", "maintenance", "rollback_0139_levente_conversion.sql"), "utf-8");

export type Entry = {
  id: string;
  variety_id: string;
  year: number;
  week: number;
  size_kg: Record<string, number>;
  total_kg: number;
  average_fruit_weight_g: number | null;
  kg_per_m2: number;
  total_cases: number;
  created_at: string;
  updated_at: string;
  organization_id: string;
  packed_date: string | null;
};
export type Fixture = {
  organization: { id: string; name: string };
  groups: Array<{ id: string; type: string; name: string }>;
  varieties: Array<{ id: string; name: string; area_m2: number; case_kg: number; status: string; color: string; created_at: string; updated_at: string }>;
  sizes: Array<{ id: string; name: string; sort_order: number }>;
  entries: Entry[];
  breakdowns: Array<{ id: string; yield_entry_id: string; packed_date: string | null; size_kg: Record<string, number>; total_kg: number; average_fruit_weight_g: number | null; created_at: string; updated_at: string }>;
  samples: Array<{ id: string; variety_id: string; phase_id: string }>;
  rows: Array<{ group_id: string; row_number: number; width_meters: number | null; length_meters: number | null; section_id: string | null }>;
  sections: Array<{ id: string; width_meters: number | null; length_meters: number | null }>;
  assignments: Array<{ group_id: string; variety_id: string; start_row: number; end_row: number; assignment_pattern: string }>;
};
export const FX = JSON.parse(readFileSync(join(__dirname, "fixtures", "levente-conversion", "production.json"), "utf-8")) as Fixture;

export const ORG = FX.organization.id;
export async function database() {
  const db = new PGlite();
  await db.exec(`
    create role authenticated;
    create role service_role;
    create table public.organizations (id uuid primary key, name text not null);
    create table public.varieties (
      id uuid primary key, organization_id uuid not null references public.organizations(id), name text not null,
      area_m2 numeric not null default 0, case_kg numeric not null default 0,
      status text not null default 'active' check (status in ('active', 'inactive')), color text,
      created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.yield_entries (
      id uuid primary key default gen_random_uuid(), variety_id uuid not null references public.varieties(id),
      year int not null, week int not null, size_kg jsonb not null default '{}', total_kg numeric not null default 0,
      average_fruit_weight_g numeric, kg_per_m2 numeric not null default 0, total_cases numeric not null default 0,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      organization_id uuid not null references public.organizations(id), packed_date date,
      constraint yield_entries_org_variety_year_week_key unique (organization_id, variety_id, year, week));
    create table public.yield_entry_daily_breakdown (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
      yield_entry_id uuid not null references public.yield_entries(id) on delete cascade, packed_date date,
      size_kg jsonb not null default '{}', total_kg numeric not null default 0,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), average_fruit_weight_g numeric);
    create table public.daily_yield_samples (
      id uuid primary key, variety_id uuid not null references public.varieties(id), phase_id uuid);
  `);
  await db.query("insert into public.organizations values ($1, $2)", [ORG, FX.organization.name]);
  for (const v of FX.varieties) {
    await db.query("insert into public.varieties values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      v.id, ORG, v.name, v.area_m2, v.case_kg, v.status, v.color, v.created_at, v.updated_at
    ]);
  }
  for (const e of FX.entries) {
    await db.query("insert into public.yield_entries values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", [
      e.id, e.variety_id, e.year, e.week, JSON.stringify(e.size_kg), e.total_kg, e.average_fruit_weight_g, e.kg_per_m2,
      e.total_cases, e.created_at, e.updated_at, ORG, e.packed_date
    ]);
  }
  for (const b of FX.breakdowns) {
    await db.query("insert into public.yield_entry_daily_breakdown values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      b.id, ORG, b.yield_entry_id, b.packed_date, JSON.stringify(b.size_kg), b.total_kg, b.created_at, b.updated_at, b.average_fruit_weight_g
    ]);
  }
  for (const s of FX.samples) await db.query("insert into public.daily_yield_samples values ($1, $2, $3)", [s.id, s.variety_id, s.phase_id]);
  return db;
}

