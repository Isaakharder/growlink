import { test } from "node:test";
import assert from "node:assert/strict";
import { orgScopedTable } from "../orgScopedTable";

// Minimal fake supabase-js client: records every call so we can assert on
// the exact filters/values orgScopedTable produced, without hitting a real
// database. Every terminal method (single/maybeSingle/then) resolves with
// { data, error: null } using whatever `rows` the fake was constructed with.
function makeFakeClient(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ table: string; op: string; values?: unknown; filters: Record<string, unknown> }> = [];

  function builder(table: string) {
    const state = {
      table,
      op: "select" as string,
      values: undefined as unknown,
      filters: {} as Record<string, unknown>
    };

    const chain = {
      select() {
        return chain;
      },
      insert(values: Record<string, unknown>) {
        state.op = "insert";
        state.values = values;
        return chain;
      },
      update(values: Record<string, unknown>) {
        state.op = "update";
        state.values = values;
        return chain;
      },
      delete() {
        state.op = "delete";
        return chain;
      },
      eq(key: string, value: unknown) {
        state.filters[key] = value;
        return chain;
      },
      in(key: string, values: unknown[]) {
        state.filters[key] = values;
        return chain;
      },
      order() {
        return chain;
      },
      single() {
        calls.push({ ...state });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      maybeSingle() {
        calls.push({ ...state });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
        calls.push({ ...state });
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      }
    };

    return chain;
  }

  const client = { from: (table: string) => builder(table) };
  return { calls, client: client as unknown as Parameters<typeof orgScopedTable>[2] };
}

test("orgScopedTable throws when organizationId is empty", () => {
  assert.throws(() => orgScopedTable("food_safety_departments", ""), /organizationId/);
});

test("selectAll always filters by organization_id", async () => {
  const { calls, client } = makeFakeClient([{ id: "row-1" }]);
  const scope = orgScopedTable("food_safety_departments", "org-a", client);

  await scope.selectAll();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filters.organization_id, "org-a");
});

test("insert strips organization_id/id/created_at from the payload and forces organizationId", async () => {
  const { calls, client } = makeFakeClient([{ id: "row-1", organization_id: "org-a", name: "Sanitation" }]);
  const scope = orgScopedTable("food_safety_departments", "org-a", client);

  await scope.insert({
    name: "Sanitation",
    organization_id: "org-b", // attempted cross-org override — must be ignored
    id: "attacker-supplied-id",
    created_at: "2020-01-01T00:00:00.000Z"
  });

  assert.equal(calls.length, 1);
  const values = calls[0].values as Record<string, unknown>;
  assert.equal(values.organization_id, "org-a");
  assert.equal(values.id, undefined);
  assert.equal(values.created_at, undefined);
  assert.equal(values.name, "Sanitation");
});

test("update filters by both id and organization_id, and strips protected fields", async () => {
  const { calls, client } = makeFakeClient([{ id: "row-1", name: "Renamed" }]);
  const scope = orgScopedTable("food_safety_locations", "org-a", client);

  await scope.update("row-1", {
    name: "Renamed",
    organization_id: "org-b",
    id: "attacker-supplied-id"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "update");
  assert.equal(calls[0].filters.id, "row-1");
  assert.equal(calls[0].filters.organization_id, "org-a");
  const values = calls[0].values as Record<string, unknown>;
  assert.equal(values.organization_id, undefined);
  assert.equal(values.id, undefined);
});

test("remove filters by both id and organization_id", async () => {
  const { calls, client } = makeFakeClient([]);
  const scope = orgScopedTable("food_safety_departments", "org-a", client);

  await scope.remove("row-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "delete");
  assert.equal(calls[0].filters.id, "row-1");
  assert.equal(calls[0].filters.organization_id, "org-a");
});
