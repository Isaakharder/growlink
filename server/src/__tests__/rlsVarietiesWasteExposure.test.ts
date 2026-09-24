import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Static guard for the confirmed anonymous / cross-tenant exposure on varieties and the waste_* tables.
// It cannot see live drift (the legacy "Allow ... varieties" policies were created outside the migrations);
// supabase/audits/rls_isolation_audit.sql is the live check. This test guarantees the fix stays in the
// migration history, names every policy explicitly, keeps authenticated access to varieties limited to
// SELECT/INSERT/UPDATE/DELETE, never touches memberships/organizations, and that nothing re-grants anon access.
const DIR = process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, "../../../supabase/migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const strip = (s: string) => s.replace(/--.*$/gm, "");
const norm = (s: string) => strip(s).replace(/\s+/g, " ").toLowerCase();

const fixFile = files.find((f) => /drop policy if exists "allow read varieties"/i.test(readFileSync(path.join(DIR, f), "utf8")));
const fixText = fixFile ? norm(readFileSync(path.join(DIR, fixFile), "utf8")) : "";

const LEGACY_VARIETIES = ["Allow read varieties", "Allow insert varieties", "Allow update varieties", "Allow delete varieties"];
const WASTE = ["waste_imports", "waste_variety_mappings"];
const VERBS = ["select", "insert", "update", "delete"];

test("a migration exists that drops the legacy wide-open varieties policies", () => {
  assert.ok(fixFile, "fix migration not found");
});

test("legacy wide-open varieties policies are dropped by exact name", () => {
  for (const name of LEGACY_VARIETIES) {
    assert.ok(fixText.includes(`drop policy if exists "${name.toLowerCase()}" on public.varieties`), `missing explicit drop of "${name}"`);
  }
});

test("wide-open waste_* policies are dropped by exact name inside the fix migration", () => {
  for (const t of WASTE) for (const v of VERBS) {
    assert.ok(fixText.includes(`drop policy if exists ${t}_${v}_all on public.${t}`), `fix migration must explicitly drop ${t}_${v}_all`);
  }
});

test("varieties: anon loses every privilege; authenticated loses only TRUNCATE/REFERENCES/TRIGGER", () => {
  assert.match(fixText, /revoke all on table public\.varieties from anon;/);
  assert.match(fixText, /revoke truncate, references, trigger on table public\.varieties from authenticated;/);
  // authenticated must keep SELECT/INSERT/UPDATE/DELETE (governed by varieties_*_org): never revoked wholesale
  assert.doesNotMatch(fixText, /revoke all on table public\.varieties from [^;]*authenticated/);
  assert.doesNotMatch(fixText, /revoke [^;]*\b(select|insert|update|delete)\b[^;]* on table public\.varieties from [^;]*authenticated/);
});

test("waste_*: server-only, so neither anon nor authenticated keeps any privilege", () => {
  for (const t of WASTE) assert.match(fixText, new RegExp(`revoke all on table public\\.${t} from anon, authenticated;`));
});

test("the fix asserts its own end state and aborts otherwise", () => {
  assert.match(fixText, /raise exception 'rls fix aborted: public\/anon policies remain/);
  assert.match(fixText, /has_table_privilege\('anon'/);
  assert.match(fixText, /has_any_column_privilege\('anon'/);
  assert.match(fixText, /has_table_privilege\('authenticated', 'public\.varieties', p\)/);
  assert.match(fixText, /varieties_select_org', 'varieties_insert_org', 'varieties_update_org', 'varieties_delete_org'/);
});

test("no migration re-grants privileges on the fixed tables to anon/public after the fix", () => {
  const fixIdx = files.indexOf(fixFile as string);
  assert.ok(fixIdx >= 0);
  for (const f of files.slice(fixIdx + 1)) {
    const text = norm(readFileSync(path.join(DIR, f), "utf8"));
    for (const t of ["varieties", ...WASTE]) {
      assert.doesNotMatch(text, new RegExp(`grant [^;]* on (table )?public\\.${t} to [^;]*\\b(anon|public)\\b`), `${f} re-grants ${t}`);
      assert.doesNotMatch(text, new RegExp(`create policy [^;]* on public\\.${t} [^;]*to (public|anon)\\b`), `${f} re-adds a public/anon policy on ${t}`);
    }
  }
});

test("the fix never drops, alters or creates memberships/organizations policies, nor revokes their authenticated access", () => {
  assert.doesNotMatch(fixText, /(drop|alter|create) policy [^;]* on public\.(memberships|organizations)\b/);
  assert.doesNotMatch(fixText, /revoke [^;]* on (table )?public\.(memberships|organizations)\b/);
});

test("the fix uses no dynamic SQL, so no policy is ever removed by pattern or expression text", () => {
  assert.doesNotMatch(fixText, /\bexecute\b/);
  assert.doesNotMatch(fixText, /for \w+ in select/);
});

test("the quality_* TV policies are left unchanged by this fix (separate follow-up)", () => {
  assert.doesNotMatch(fixText, /quality_(checks|employees)/);
});
