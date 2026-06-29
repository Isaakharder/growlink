# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Run everything (server + client + forecasting):**
```
npm run dev              # from repo root
```

**Individual services:**
```
npm run dev:server       # Express API on port 4000
npm run dev:client       # Vite SPA on port 5173
npm run dev:forecasting  # FastAPI on port 8000
```

**Server:**
```
cd server
npm run dev              # tsx watch (hot-reload)
npm run build            # tsc → dist/
npm run start            # node dist/index.js
npx tsc --noEmit         # type-check only (no output)
node --require tsx/cjs --test src/utils/__tests__/flowMasterPdfParser.test.ts  # run one test
```

**Client:**
```
cd client
npm run dev              # Vite dev server
npm run build            # tsc -b && vite build
```

No lint step is configured. There is no test runner for the client.

## Architecture

Three independent services share one repository:

| Service | Stack | Port | Entry |
|---|---|---|---|
| `server/` | Node.js + Express + TypeScript | 4000 | `src/index.ts` |
| `client/` | React 18 + Vite + TypeScript | 5173 | `index.html` / `mobile.html` |
| `forecasting/` | Python + FastAPI | 8000 | `app/main.py` |

Database is Supabase (PostgreSQL). Migrations live in `supabase/migrations/` numbered sequentially (`0001_`, `0002_`, …). The current count is 66.

## Server

**Route registration order in `app.ts` matters.** `requireOrganizationContext` is registered mid-chain as a `use("/api", ...)` middleware. Routes registered *before* it (admin routes, agent upload routes, public invites, health) do not get `req.userId` / `req.organizationId` set automatically — they handle their own auth. Routes registered *after* it require a valid Bearer token.

**Two separate auth paths:**

1. **Browser users** — `requireOrganizationContext`: extracts Bearer token from `Authorization` header, calls `supabase.auth.getUser()`, looks up `memberships` table, sets `req.userId` and `req.organizationId`.

2. **Agent/machine uploads** — `requireUploadKey`: reads `X-Upload-Key` header, SHA-256 hashes it, looks up `organization_upload_keys` table, sets `req.organizationId`, `req.uploadKeyId`, `req.uploadKeyLabel`, and `req.dataSourceType`.

**Three-tier access control:**

- **Platform admin** — `requireAdminUser` middleware; user ID must be in `ADMIN_USER_IDS` env var. Used for cross-org management routes.
- **Org owner/admin** — `requirePermission` / `requireAnyPermission`; role check against `memberships.role`. Owners and admins bypass all permission key checks.
- **Org member** — Same middleware; checks `memberships.permissions` JSONB for a specific key being `true` (e.g. `"irrigation:view"`).

**Error handling pattern:** use `sendSafeError(res, status, clientMessage, logContext, error)` from `utils/safeError.ts`. It logs the full error server-side and sends only the safe client message.

**Supabase client** (`src/config/supabase.ts`) uses the service-role key on the backend. It never throws — always returns `{ data, error }`. Always destructure and check `error` before using `data`.

`app.set("trust proxy", 1)` is required and must appear before rate-limiter middleware because Railway runs behind an nginx reverse proxy.

## Client

**Two separate HTML shells:** `index.html` (desktop, served for all non-`/mobile` routes) and `mobile.html` (served for `/mobile/*`). Both are Vite entry points configured in `vite.config.ts`. The Vite dev server and service worker both enforce this split.

**All API calls go through `apiFetch(path, options)`** in `src/lib/api.ts`. It automatically injects the Supabase session token as `Authorization: Bearer`. Never use raw `fetch` for backend calls.

**Direct Supabase calls** (from `src/lib/supabase.ts` with the anon key) are used for auth only (`supabase.auth.*`) and for a small number of client-side membership lookups. Business data goes through the Express API.

**PWA:** Vite PWA plugin with `autoUpdate`. API and Supabase responses are `NetworkOnly` — never cached by the service worker. Static assets are precached.

## Database conventions

**Every migration file must:**
- Include `ENABLE ROW LEVEL SECURITY` on new tables
- Include `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ... TO service_role`
- Use `gen_random_uuid()` for UUID primary keys

**Supabase upsert `onConflict` requires a named `UNIQUE CONSTRAINT`, not just a `CREATE UNIQUE INDEX`.** Use `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX existing_idx` to promote an index. A bare unique index causes PostgREST to return "there is no unique or exclusion constraint matching the ON CONFLICT specification" with `ignoreDuplicates: true` or `DO UPDATE`.

**Generated columns** (`GENERATED ALWAYS AS ... STORED`) can be used as upsert conflict targets since they are real stored columns. They cannot appear in INSERT value lists.

**Organization isolation** is enforced at two layers: RLS policies in the DB, and `eq("organization_id", orgId)` filters in every server query. Never omit the org filter.

## Key domain tables

| Table | Purpose |
|---|---|
| `organizations`, `memberships` | Multi-tenant core; `memberships.permissions` JSONB for fine-grained access |
| `organization_upload_keys` | Machine-auth keys for the GrowLink Agent; `data_source_type` = `flowmaster` or `generic_csv` |
| `import_source_templates` | Per-upload-key CSV column mapping config; `import_type` = `yield_kg` or `weather_station` — only present for `generic_csv` keys |
| `climate_imports` | One row per weather station CSV file uploaded; `file_hash` SHA-256 for dedup |
| `climate_readings` | EAV time-series from weather station CSVs; `zone_key` generated column handles NULL zone dedup |
| `daily_light_logs` | Daily radiation totals (J/cm²) synced from `climate_readings` on each import |
| `agent_pending_imports` | Staging table for yield CSVs awaiting admin review |
| `yield_import_runs` | Committed yield imports |

## GrowLink Agent upload key types

There are two unrelated key types that share the same `POST /api/agent/pdf-import` endpoint. **FlowMaster keys are not weather station keys.**

| Key type (`data_source_type`) | What it processes | Where data lands |
|---|---|---|
| `flowmaster` | FlowMaster PDF/CSV yield exports | `agent_pending_imports` (review queue) |
| `generic_csv` | Any CSV; behaviour driven by `import_source_templates` | Depends on `import_type` (see below) |

For a `generic_csv` key, the matching `import_source_templates` row controls processing:

| `import_type` | What it processes | Where data lands |
|---|---|---|
| `yield_kg` (default) | AWETA/packline CSV exports | `agent_pending_imports` (review queue) |
| `weather_station` | Ridder Synopta key/value CSV exports | `climate_imports` → `climate_readings` → `daily_light_logs` |

**Weather station uploads require:**
1. Upload key with `data_source_type = generic_csv`
2. A linked `import_source_templates` row with `import_type = weather_station` and `column_mappings` that maps row labels (e.g. `radiation_sum_key`) to the CSV row keys in the file
3. Filenames following the pattern `*_YYYYMMDD_HHMMSS.csv` so the timestamp can be extracted

**Agent HTTP response semantics.** The GrowLink Agent treats any HTTP 200 as success and moves the uploaded file to its "Uploaded" folder. This means:
- Per-file `status` fields inside a 200 response (`"pending_template"`, `"queued"`) are **not** seen by the agent as failures.
- A misconfigured template or missing migration causes the handler to silently fall through to the wrong code path and return 200, which the agent misreads as full success.
- **When a file cannot be processed as intended, the endpoint must return a non-200 status** (4xx/5xx) so the agent retains the file for retry. Return HTTP 500 for server/DB failures; reserve 200 only for files that were actually written to their target tables or correctly identified as duplicates.

## Deployment

The server deploys to Railway. Supabase migrations must be applied separately (they are not run automatically on deploy). When adding a new migration, increment the number prefix and test that it applies cleanly on top of the existing schema.
