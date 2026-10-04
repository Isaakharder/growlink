// CropLink integration v2 routes. Built by a factory so tests can supply an
// in-memory store and a stub authenticator; croplinkIntegration.ts wires the
// real Supabase store and the scoped integration-key middleware.
import { RequestHandler, Request, Response, Router } from "express";
import {
  DeletionRow, ManifestRow, YieldWeekRow, KeysetCursor, MANIFEST_TTL_MS, PhysicalArea,
  manifestHeader, pageOf, parseListParams, parseManifestPage, toYieldWeekItem
} from "../lib/croplinkV2";

export interface CroplinkV2Store {
  /** Rows ordered by (updated_at, id) ascending, strictly after `cursor` (or `after`), at most `limit` rows. */
  listYieldWeeks(organizationId: string, opts: { cursor: KeysetCursor | null; after: string | null; year: number | null; limit: number }): Promise<YieldWeekRow[]>;
  /** Rows ordered by (deleted_at, id) ascending. */
  listDeletions(organizationId: string, opts: { cursor: KeysetCursor | null; after: string | null; limit: number }): Promise<DeletionRow[]>;
  /** Snapshots every current yield entry id for the organization into an immutable manifest. */
  createManifest(organizationId: string, ttlMs: number): Promise<ManifestRow>;
  getManifest(organizationId: string, manifestId: string): Promise<ManifestRow | null>;
  /** Physical (measured greenhouse-row) area per variety id. */
  physicalAreas(organizationId: string): Promise<Map<string, PhysicalArea>>;
}

export interface CroplinkV2Deps {
  store: CroplinkV2Store;
  authenticate: RequestHandler;
  now?: () => Date;
  timeZone: string;
  log?: (message: string, err?: unknown) => void;
}

const BASE = "/integrations/croplink/v2";

export function createCroplinkV2Router(deps: CroplinkV2Deps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m, e) => console.error(m, e));
  const fail = (res: Response, message: string, err: unknown) => {
    log(`CropLink v2: ${message}`, err);
    return res.status(500).json({ message });
  };

  router.get(`${BASE}/yield-weeks`, deps.authenticate, async (req: Request, res: Response) => {
    const params = parseListParams(req.query as Record<string, unknown>, "updatedAfter");
    if (!params.ok) return res.status(400).json({ message: params.message });
    const { limit, cursor, after, year } = params.value;
    try {
      const rows = await deps.store.listYieldWeeks(req.organizationId, { cursor, after: cursor ? null : after, year, limit: limit + 1 });
      const page = pageOf(rows, limit, r => ({ at: r.updated_at, id: r.id }), cursor);
      const areas = page.items.length ? await deps.store.physicalAreas(req.organizationId) : new Map<string, PhysicalArea>();
      const at = now();
      return res.json({ items: page.items.map(r => toYieldWeekItem(r, at, deps.timeZone, areas.get(r.variety_id))), nextCursor: page.nextCursor, resumeCursor: page.resumeCursor, hasMore: page.hasMore, serverTime: at.toISOString() });
    } catch (err) {
      return fail(res, "Failed to load yield weeks.", err);
    }
  });

  router.get(`${BASE}/yield-week-deletions`, deps.authenticate, async (req: Request, res: Response) => {
    const params = parseListParams(req.query as Record<string, unknown>, "deletedAfter");
    if (!params.ok) return res.status(400).json({ message: params.message });
    const { limit, cursor, after } = params.value;
    try {
      const rows = await deps.store.listDeletions(req.organizationId, { cursor, after: cursor ? null : after, limit: limit + 1 });
      const page = pageOf(rows, limit, r => ({ at: r.deleted_at, id: r.id }), cursor);
      return res.json({
        items: page.items.map(r => ({ tombstoneId: r.id, yieldEntryId: r.entity_id, varietyId: r.variety_id, packingYear: r.year, packingWeek: r.week, deletedAt: r.deleted_at })),
        nextCursor: page.nextCursor,
        resumeCursor: page.resumeCursor,
        hasMore: page.hasMore,
        serverTime: now().toISOString()
      });
    } catch (err) {
      return fail(res, "Failed to load deletions.", err);
    }
  });

  router.post(`${BASE}/yield-week-manifests`, deps.authenticate, async (req: Request, res: Response) => {
    try {
      const manifest = await deps.store.createManifest(req.organizationId, MANIFEST_TTL_MS);
      return res.status(201).json(manifestHeader(manifest));
    } catch (err) {
      return fail(res, "Failed to create manifest.", err);
    }
  });

  router.get(`${BASE}/yield-week-manifests/:manifestId/ids`, deps.authenticate, async (req: Request, res: Response) => {
    const page = parseManifestPage(req.query as Record<string, unknown>);
    if (!page.ok) return res.status(400).json({ message: page.message });
    try {
      const manifest = await deps.store.getManifest(req.organizationId, String(req.params.manifestId));
      if (!manifest) return res.status(404).json({ message: "Manifest not found." });
      if (Date.parse(manifest.expires_at) <= now().getTime()) return res.status(410).json({ message: "Manifest expired; create a new one." });
      const { offset, limit } = page.value;
      if (offset > manifest.entity_ids.length) return res.status(400).json({ message: "cursor is past the end of the manifest." });
      const ids = manifest.entity_ids.slice(offset, offset + limit);
      const next = offset + ids.length;
      return res.json({
        ...manifestHeader(manifest),
        offset,
        ids,
        nextCursor: next < manifest.entity_ids.length ? String(next) : null,
        hasMore: next < manifest.entity_ids.length
      });
    } catch (err) {
      return fail(res, "Failed to load manifest page.", err);
    }
  });

  return router;
}
