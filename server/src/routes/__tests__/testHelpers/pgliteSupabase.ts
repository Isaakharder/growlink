// A minimal supabase-js stand-in backed by a real PGlite database, so route
// tests run real SQL — table constraints, unique keys, RLS-free service-role
// access and plpgsql functions — with no server, Docker or network.
// Implements only what the routes under test use: select / eq / neq / gte /
// lte / gt / not(col,"is",null) / order / limit / range / maybeSingle /
// single / upsert (onConflict, ignoreDuplicates) / insert / update / delete /
// rpc. Identifiers come from the code under test, never from request input.
import type { PGlite } from "@electric-sql/pglite";

type Result = { data: unknown; error: { message: string; code?: string } | null };

const toParam = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

export function createPgliteSupabase(db: PGlite) {
  function from(table: string) {
    const where: string[] = [];
    const params: unknown[] = [];
    const orderBy: string[] = [];
    let columns = "*";
    let limit: number | null = null;
    let offset = 0;
    let mutation:
      | { kind: "upsert" | "insert"; rows: Record<string, unknown>[]; onConflict?: string; ignoreDuplicates?: boolean }
      | { kind: "update"; values: Record<string, unknown> }
      | { kind: "delete" }
      | null = null;
    let returning: string | null = null;

    const p = (v: unknown) => {
      params.push(toParam(v));
      return `$${params.length}`;
    };

    function sql(): string {
      const w = where.length ? ` where ${where.join(" and ")}` : "";
      if (!mutation) {
        const o = orderBy.length ? ` order by ${orderBy.join(", ")}` : "";
        const l = limit !== null ? ` limit ${limit}` : "";
        return `select ${columns} from public.${table}${w}${o}${l} offset ${offset}`;
      }
      const ret = returning ? ` returning ${returning}` : "";
      if (mutation.kind === "delete") return `delete from public.${table}${w}${ret}`;
      if (mutation.kind === "update") {
        const sets = Object.entries(mutation.values).map(([k, v]) => `${k} = ${p(v)}`);
        return `update public.${table} set ${sets.join(", ")}${w}${ret}`;
      }
      const cols = Array.from(new Set(mutation.rows.flatMap((r) => Object.keys(r))));
      const values = mutation.rows.map((r) => `(${cols.map((c) => (c in r ? p(r[c]) : "default")).join(", ")})`);
      let conflict = "";
      if (mutation.kind === "upsert") {
        const target = (mutation.onConflict ?? "id").split(",").map((c) => c.trim());
        const updates = cols.filter((c) => !target.includes(c));
        conflict = mutation.ignoreDuplicates || updates.length === 0
          ? ` on conflict (${target.join(", ")}) do nothing`
          : ` on conflict (${target.join(", ")}) do update set ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}`;
      }
      return `insert into public.${table} (${cols.join(", ")}) values ${values.join(", ")}${conflict}${ret}`;
    }

    async function run(): Promise<Result> {
      try {
        const text = sql();
        const res = await db.query<Record<string, unknown>>(text, params);
        return { data: mutation && !returning ? null : res.rows, error: null };
      } catch (e) {
        const err = e as { message: string; code?: string };
        return { data: null, error: { message: err.message, code: err.code } };
      }
    }

    const builder = {
      select(cols = "*") {
        if (mutation) returning = cols;
        else columns = cols;
        return builder;
      },
      eq: (c: string, v: unknown) => (where.push(`${c} = ${p(v)}`), builder),
      neq: (c: string, v: unknown) => (where.push(`${c} is distinct from ${p(v)}`), builder),
      gt: (c: string, v: unknown) => (where.push(`${c} > ${p(v)}`), builder),
      gte: (c: string, v: unknown) => (where.push(`${c} >= ${p(v)}`), builder),
      lte: (c: string, v: unknown) => (where.push(`${c} <= ${p(v)}`), builder),
      in: (c: string, vs: unknown[]) => (where.push(vs.length ? `${c} in (${vs.map(p).join(", ")})` : "false"), builder),
      not: (c: string, op: string, v: unknown) => {
        if (op !== "is" || v !== null) throw new Error(`pglite adapter: unsupported not(${op})`);
        where.push(`${c} is not null`);
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => (orderBy.push(`${c} ${o?.ascending === false ? "desc" : "asc"}`), builder),
      limit: (n: number) => ((limit = n), builder),
      range: (a: number, b: number) => ((offset = a), (limit = b - a + 1), builder),
      upsert: (rows: Record<string, unknown> | Record<string, unknown>[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
        (mutation = { kind: "upsert", rows: Array.isArray(rows) ? rows : [rows], onConflict: o?.onConflict, ignoreDuplicates: o?.ignoreDuplicates }), builder
      ),
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => ((mutation = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] }), builder),
      update: (values: Record<string, unknown>) => ((mutation = { kind: "update", values }), builder),
      delete: () => ((mutation = { kind: "delete" }), builder),
      async maybeSingle(): Promise<Result> {
        const r = await run();
        if (r.error) return r;
        const rows = r.data as unknown[];
        if (rows.length > 1) return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
        return { data: rows[0] ?? null, error: null };
      },
      async single(): Promise<Result> {
        const r = await run();
        if (r.error) return r;
        const rows = r.data as unknown[];
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "expected one row", code: "PGRST116" } };
      },
      then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T) {
        return run().then(resolve, reject);
      }
    };
    return builder;
  }

  async function rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
    const keys = Object.keys(args);
    try {
      const res = await db.query<{ r: unknown }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => toParam(args[k])));
      return { data: res.rows[0]?.r ?? null, error: null };
    } catch (e) {
      const err = e as { message: string; code?: string };
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }

  return { from, rpc, auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } } };
}
