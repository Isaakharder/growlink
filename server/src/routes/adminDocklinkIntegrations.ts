import { Router } from "express";
import { supabase } from "../config/supabase";
import { docklinkSupabase, isDocklinkConfigured } from "../config/docklink";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { sendSafeError } from "../utils/safeError";

const adminDocklinkIntegrationsRouter = Router();

// GET /api/admin/docklink-organizations — list orgs available in DockLink
adminDocklinkIntegrationsRouter.get("/admin/docklink-organizations", requireAdminUser, async (req, res) => {
  console.log("[docklink-organizations GET] reached userId=%s dlConfigured=%s", req.userId, isDocklinkConfigured());

  if (!isDocklinkConfigured()) {
    return res.status(503).json({ message: "DockLink is not configured on this server." });
  }

  const { data, error } = await docklinkSupabase!
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });

  console.log("[docklink-organizations GET] rows=%d error=%s", data?.length ?? -1, error?.message ?? "none");

  if (error) {
    return sendSafeError(res, 500, "Failed to load DockLink organizations.", "DockLink orgs fetch error:", error);
  }

  return res.json({ success: true, organizations: data ?? [] });
});

// GET /api/admin/docklink-integrations
adminDocklinkIntegrationsRouter.get("/admin/docklink-integrations", requireAdminUser, async (req, res) => {
  console.log("[docklink-integrations GET] reached userId=%s", req.userId);
  try {
    const [orgsResult, integrationsResult] = await Promise.all([
      supabase.from("organizations").select("id, name").order("name", { ascending: true }),
      // select("*") so this query succeeds whether or not migration 0053 has been applied.
      // Explicitly listing connected_by_user_id/connected_at would fail with
      // "column does not exist" on databases where the migration is pending.
      supabase
        .from("organization_integrations")
        .select("*")
        .eq("integration_name", "docklink")
    ]);

    console.log(
      "[docklink-integrations GET] orgs=%d orgsErr=%s integrations=%d integrationsErr=%s",
      orgsResult.data?.length ?? -1,
      orgsResult.error?.message ?? "none",
      integrationsResult.data?.length ?? -1,
      integrationsResult.error?.message ?? "none"
    );

    if (orgsResult.error) {
      return sendSafeError(res, 500, "Failed to load organizations.", "Orgs fetch error:", orgsResult.error);
    }
    if (integrationsResult.error) {
      return sendSafeError(res, 500, "Failed to load integrations.", "Integrations fetch error:", integrationsResult.error);
    }

    const orgs = orgsResult.data ?? [];
    const integrations = integrationsResult.data ?? [];

    const integrationByOrgId = new Map<string, (typeof integrations)[0]>();
    for (const i of integrations) {
      integrationByOrgId.set(i.organization_id, i);
    }

    const connectedOrgIds = integrations.map((i) => i.organization_id);

    // Collect unique user IDs that need email lookup
    const uniqueUserIds = [
      ...new Set(
        integrations
          .map((i) => i.connected_by_user_id as string | null)
          .filter((id): id is string => id !== null)
      )
    ];

    // Fetch sync timestamps and admin user emails in parallel
    const [syncResults, emailByUserId] = await Promise.all([
      connectedOrgIds.length > 0
        ? Promise.all(
            connectedOrgIds.map(async (orgId) => {
              const [casesRes, wasteRes] = await Promise.all([
                supabase
                  .from("color_case_entries")
                  .select("synced_at")
                  .eq("organization_id", orgId)
                  .not("synced_at", "is", null)
                  .order("synced_at", { ascending: false })
                  .limit(1)
                  .maybeSingle(),
                supabase
                  .from("waste_imports")
                  .select("synced_at")
                  .eq("organization_id", orgId)
                  .not("synced_at", "is", null)
                  .order("synced_at", { ascending: false })
                  .limit(1)
                  .maybeSingle()
              ]);
              return {
                orgId,
                casesSync: (casesRes.data?.synced_at as string | null) ?? null,
                wasteSync: (wasteRes.data?.synced_at as string | null) ?? null
              };
            })
          )
        : Promise.resolve([] as Array<{ orgId: string; casesSync: string | null; wasteSync: string | null }>),
      (async () => {
        const map = new Map<string, string>();
        if (uniqueUserIds.length > 0) {
          await Promise.all(
            uniqueUserIds.map(async (uid) => {
              const { data } = await supabase.auth.admin.getUserById(uid);
              if (data.user?.email) {
                map.set(uid, data.user.email);
              }
            })
          );
        }
        return map;
      })()
    ]);

    const syncByOrg = new Map<string, { casesSync: string | null; wasteSync: string | null }>();
    for (const { orgId, casesSync, wasteSync } of syncResults) {
      syncByOrg.set(orgId, { casesSync, wasteSync });
    }

    const result = orgs.map((org) => {
      const integration = integrationByOrgId.get(org.id);
      const sync = syncByOrg.get(org.id);
      const connectedByUserId = (integration?.connected_by_user_id as string | null) ?? null;
      return {
        organizationId: org.id,
        organizationName: org.name,
        integrationId: integration?.id ?? null,
        externalOrganizationId: integration?.external_organization_id ?? null,
        enabled: integration?.enabled ?? false,
        connected: integration != null,
        lastCasesSync: sync?.casesSync ?? null,
        lastWasteSync: sync?.wasteSync ?? null,
        connectedByUserId,
        connectedByEmail: connectedByUserId ? (emailByUserId.get(connectedByUserId) ?? null) : null,
        connectedAt: (integration?.connected_at as string | null) ?? null
      };
    });

    return res.json({ success: true, integrations: result });
  } catch (err) {
    return sendSafeError(res, 500, "Unexpected error loading DockLink integrations.", "DockLink list error:", err);
  }
});

// POST /api/admin/docklink-integrations — connect or reconnect an org
adminDocklinkIntegrationsRouter.post("/admin/docklink-integrations", requireAdminUser, async (req, res) => {
  const { organizationId, externalOrganizationId } = req.body as {
    organizationId?: unknown;
    externalOrganizationId?: unknown;
  };

  if (!organizationId || typeof organizationId !== "string") {
    return res.status(400).json({ message: "organizationId is required." });
  }
  if (!externalOrganizationId || typeof externalOrganizationId !== "string" || !externalOrganizationId.trim()) {
    return res.status(400).json({ message: "externalOrganizationId is required." });
  }

  const { error } = await supabase.from("organization_integrations").upsert(
    {
      organization_id: organizationId,
      integration_name: "docklink",
      external_organization_id: externalOrganizationId.trim(),
      enabled: true,
      connected_by_user_id: req.userId ?? null,
      connected_at: new Date().toISOString()
    },
    { onConflict: "organization_id,integration_name" }
  );

  if (error) {
    return sendSafeError(res, 500, "Failed to save integration.", "DockLink upsert error:", error);
  }

  return res.json({ success: true, message: "DockLink integration connected." });
});

// PATCH /api/admin/docklink-integrations/:id — update external org ID
adminDocklinkIntegrationsRouter.patch("/admin/docklink-integrations/:id", requireAdminUser, async (req, res) => {
  const { id } = req.params;
  const { externalOrganizationId } = req.body as { externalOrganizationId?: unknown };

  if (!externalOrganizationId || typeof externalOrganizationId !== "string" || !externalOrganizationId.trim()) {
    return res.status(400).json({ message: "externalOrganizationId is required." });
  }

  const { error } = await supabase
    .from("organization_integrations")
    .update({
      external_organization_id: externalOrganizationId.trim(),
      enabled: true,
      connected_by_user_id: req.userId ?? null,
      connected_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("integration_name", "docklink");

  if (error) {
    return sendSafeError(res, 500, "Failed to update integration.", "DockLink update error:", error);
  }

  return res.json({ success: true, message: "DockLink integration updated." });
});

// POST /api/admin/docklink-integrations/:id/test — test both DockLink views for an org
adminDocklinkIntegrationsRouter.post("/admin/docklink-integrations/:id/test", requireAdminUser, async (req, res) => {
  const { id } = req.params;

  if (!isDocklinkConfigured()) {
    return res.status(503).json({ message: "DockLink is not configured on this server." });
  }

  const { data: integration, error: fetchError } = await supabase
    .from("organization_integrations")
    .select("external_organization_id, enabled")
    .eq("id", id)
    .eq("integration_name", "docklink")
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load integration.", "DockLink test fetch error:", fetchError);
  }
  if (!integration) {
    return res.status(404).json({ message: "Integration not found." });
  }

  const externalOrgId = integration.external_organization_id as string;

  const [casesResult, wasteResult] = await Promise.allSettled([
    docklinkSupabase!
      .from("growlink_weekly_color_totals")
      .select("organization_id")
      .eq("organization_id", externalOrgId)
      .limit(1),
    docklinkSupabase!
      .from("growlink_weekly_waste_totals")
      .select("organization_id")
      .eq("organization_id", externalOrgId)
      .limit(1)
  ]);

  function summarizeResult(
    settled: PromiseSettledResult<{ data: unknown[] | null; error: { message: string } | null }>
  ): { ok: boolean; rowCount?: number; error?: string } {
    if (settled.status === "rejected") {
      const msg =
        settled.reason instanceof Error ? settled.reason.message : "Unexpected error";
      return { ok: false, error: msg };
    }
    const { data, error } = settled.value;
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, rowCount: data?.length ?? 0 };
  }

  return res.json({
    casesView: summarizeResult(casesResult),
    wasteView: summarizeResult(wasteResult)
  });
});

// POST /api/admin/docklink-integrations/:id/disable
adminDocklinkIntegrationsRouter.post("/admin/docklink-integrations/:id/disable", requireAdminUser, async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from("organization_integrations")
    .update({ enabled: false })
    .eq("id", id)
    .eq("integration_name", "docklink");

  if (error) {
    return sendSafeError(res, 500, "Failed to disable integration.", "DockLink disable error:", error);
  }

  return res.json({ success: true, message: "DockLink integration disabled." });
});

export { adminDocklinkIntegrationsRouter };
