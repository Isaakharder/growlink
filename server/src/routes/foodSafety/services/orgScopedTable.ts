import { supabase as defaultClient } from "../../../config/supabase";

type Row = Record<string, unknown>;
type SupabaseClientLike = typeof defaultClient;

/**
 * Wraps a table name + organizationId so every read/write goes through an
 * explicit `.eq("organization_id", organizationId)` filter, reducing the
 * risk of a hand-written Food Safety query forgetting the org filter.
 *
 * This does NOT replace organization isolation elsewhere in the stack:
 *   - routes must still run after requireOrganizationContext
 *   - routes must still enforce requirePermission / requireAnyPermission
 *   - the underlying table must still have RLS policies enabled
 * organizationId is a required, visible argument specifically so cross-org
 * isolation stays easy to test (see services/__tests__/orgScopedTable.test.ts).
 *
 * The optional `client` parameter defaults to the shared service-role
 * Supabase client used everywhere else in the server, and exists only so
 * tests can inject a fake client instead of hitting a real database.
 */
export function orgScopedTable(
  table: string,
  organizationId: string,
  client: SupabaseClientLike = defaultClient
) {
  if (!organizationId) {
    throw new Error(`orgScopedTable("${table}") requires a non-empty organizationId`);
  }

  // Strip fields a caller must never be able to set/override directly:
  // organization_id (would allow writing into another org), id, and
  // created_at. Mirrors the EDITABLE_FIELDS whitelist convention used by
  // server/src/routes/foodSafetyH1.ts.
  function sanitize(values: Row): Row {
    const { organization_id: _organizationId, id: _id, created_at: _createdAt, ...rest } = values;
    return rest;
  }

  // supabase-js/postgrest-js infers query result shapes from the *literal*
  // select-string type, which only works when a Database schema type is
  // supplied to createClient (this project has none — see config/supabase.ts).
  // Passing a plain `string` for `columns` defeats that parser and yields an
  // unusable `GenericStringError` type. Since this helper already narrows
  // everything to the untyped `Row` shape, we deliberately go through `any`
  // here rather than fight postgrest-js's literal-type inference.
  function from(name: string) {
    return client.from(name) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  return {
    table,
    organizationId,

    selectAll(columns = "*") {
      return from(table).select(columns).eq("organization_id", organizationId);
    },

    selectById(id: string, columns = "*") {
      return from(table)
        .select(columns)
        .eq("id", id)
        .eq("organization_id", organizationId)
        .maybeSingle();
    },

    insert(values: Row) {
      return from(table)
        .insert({ ...sanitize(values), organization_id: organizationId })
        .select("*")
        .single();
    },

    // Uses maybeSingle() rather than single() so an id that exists but
    // belongs to another organization resolves to `data: null` (a clean
    // 404 at the route layer) instead of a PostgREST "no rows" error.
    update(id: string, values: Row) {
      return from(table)
        .update(sanitize(values))
        .eq("id", id)
        .eq("organization_id", organizationId)
        .select("*")
        .maybeSingle();
    },

    remove(id: string) {
      return from(table).delete().eq("id", id).eq("organization_id", organizationId);
    }
  };
}

export type OrgScopedTable = ReturnType<typeof orgScopedTable>;
