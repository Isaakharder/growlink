import type { NextFunction, Request, Response } from "express";
import { requirePermission } from "../../../middleware/requirePermission";

/**
 * Runs the real, unmodified requirePermission(key) middleware against the
 * current request and resolves to whether it would have called next()
 * (true) or responded with an error (false) — without actually sending a
 * response. This exists for the few places a route needs a conditional,
 * in-handler permission check (e.g. "drafts are only visible to managers,
 * published versions are visible to viewers too") rather than a route-level
 * gate, without duplicating requirePermission's role/permissions lookup
 * logic here or modifying the shared middleware file for one call site.
 */
export function userHasPermission(req: Request, permissionKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const stubRes = {
      status() {
        return this;
      },
      json() {
        if (!settled) {
          settled = true;
          resolve(false);
        }
        return this;
      }
    } as unknown as Response;

    const next: NextFunction = () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    };

    void requirePermission(permissionKey)(req, stubRes, next);
  });
}
