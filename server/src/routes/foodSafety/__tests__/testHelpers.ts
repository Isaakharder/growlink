// Shared test-only helpers for exercising the real, unmodified
// requirePermission/requireAnyPermission middleware without a database.
// Not itself a test file (no .test.ts suffix) so node:test does not try to
// run it directly — imported by permissions.test.ts and
// templatePermissions.test.ts.
import type { Request, Response } from "express";
import type { TestContext } from "node:test";
import { supabase } from "../../../config/supabase";

export type MembershipRow = { role: string; permissions?: Record<string, boolean> };

export function stubMembership(t: TestContext, row: MembershipRow | null) {
  const fakeFrom = ((table: string) => {
    if (table !== "memberships") {
      throw new Error(`Unexpected table in test stub: ${table}`);
    }
    return {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle() {
        return Promise.resolve({ data: row, error: null });
      }
    };
  }) as unknown as typeof supabase.from;

  t.mock.method(supabase, "from", fakeFrom);
}

export function fakeReqRes(userId: string, organizationId: string) {
  const req = { userId, organizationId } as Request;
  let statusCode: number | null = null;
  let body: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    }
  } as unknown as Response;
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, getResult: () => ({ statusCode, body, nextCalled }) };
}
