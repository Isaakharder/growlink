// Offline test support for code that takes an injectable Supabase client
// (the `db: DbClient` parameter on csvMappingTemplates.ts's source-file
// read paths), or that is pointed at the fake by swapping the shared
// client's from(). Import this module FIRST in a test file: it gives
// config/supabase.ts dummy credentials when real ones aren't loaded, so the
// module can be imported without a .env, and the default client can never
// reach a live database — only the in-memory fake below is ever queried.
process.env.SUPABASE_URL ??= "http://offline.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline-test-key";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
export type RecordedQuery = { table: string; eq: Array<[string, unknown]> };
export type RecordedWrite = { table: string; op: "insert" | "update" | "upsert" | "delete"; values: unknown; rowCount: number };

/**
 * Minimal in-memory stand-in for the supabase-js query builder: supports
 * select / eq / in / not(col, "is", null) / order / limit / maybeSingle /
 * single, update / insert / upsert / delete, and awaiting the builder
 * directly. Filters really filter, so code that forgets an organization_id
 * filter visibly leaks another organization's rows; writes really apply
 * and are recorded, so a test can assert exactly what was changed.
 */
export function createFakeDb(tables: Record<string, Row[]>) {
  const queriedTables: string[] = [];
  /** Every query issued, with its eq() filters — lets a test assert a query was never made. */
  const queries: RecordedQuery[] = [];
  /** Every write applied, in order. */
  const writes: RecordedWrite[] = [];

  function query(table: string) {
    queriedTables.push(table);
    const recorded: RecordedQuery = { table, eq: [] };
    queries.push(recorded);
    const filters: Filter[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitCount: number | null = null;
    let mutation: { op: RecordedWrite["op"]; values: unknown } | null = null;

    const matching = (): Row[] => (tables[table] ??= []).filter((row) => filters.every((f) => f(row)));

    const run = (): Row[] => {
      if (mutation) return applyMutation();
      let rows = matching();
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      return rows.map((r) => ({ ...r }));
    };

    const applyMutation = (): Row[] => {
      const { op, values } = mutation!;
      const target = (tables[table] ??= []);
      let affected: Row[];
      if (op === "insert" || op === "upsert") {
        affected = (Array.isArray(values) ? values : [values]).map((v) => ({ ...(v as Row) }));
        target.push(...affected);
      } else if (op === "update") {
        affected = matching();
        for (const row of affected) Object.assign(row, values as Row);
      } else {
        affected = matching();
        tables[table] = target.filter((row) => !affected.includes(row));
      }
      writes.push({ table, op, values, rowCount: affected.length });
      mutation = null; // a builder applies its write exactly once
      return affected.map((r) => ({ ...r }));
    };

    const builder = {
      select: () => builder,
      eq(column: string, value: unknown) {
        recorded.eq.push([column, value]);
        filters.push((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== "is" || value !== null) throw new Error(`fake db: unsupported not(${operator}, ${String(value)})`);
        filters.push((row) => row[column] !== null && row[column] !== undefined);
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orderBy = { column, ascending: options?.ascending ?? true };
        return builder;
      },
      limit(count: number) {
        limitCount = count;
        return builder;
      },
      update(values: Row) {
        mutation = { op: "update", values };
        return builder;
      },
      insert(values: Row | Row[]) {
        mutation = { op: "insert", values };
        return builder;
      },
      upsert(values: Row | Row[]) {
        mutation = { op: "upsert", values };
        return builder;
      },
      delete() {
        mutation = { op: "delete", values: null };
        return builder;
      },
      async maybeSingle() {
        const rows = run();
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = run();
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not exactly one row" } };
      },
      then<T>(resolve: (value: { data: Row[]; error: null }) => T, reject?: (reason: unknown) => T) {
        return Promise.resolve()
          .then(() => ({ data: run(), error: null as null }))
          .then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    // Cast at the call site: this implements only the query-builder surface
    // these tests exercise.
    client: { from: query } as unknown,
    from: query,
    tables,
    queriedTables,
    queries,
    writes
  };
}
