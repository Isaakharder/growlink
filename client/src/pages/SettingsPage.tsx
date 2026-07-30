import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";

// ── types ────────────────────────────────────────────────────────────────────

type AccessState = "loading" | "denied" | "allowed";
type FormState = "idle" | "submitting" | "success" | "error";

type ImportRunRow = {
  id: string;
  lotNumber: string;
  sourceFilename: string | null;
  varietyName: string | null;
  isoYear: number | null;
  isoWeek: number | null;
  importedAt: string;
};

type InviteRow = {
  id: string;
  email: string;
  position: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

type UserRow = {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  position: string | null;
  permissions: Record<string, boolean>;
  createdAt: string;
};

// ── permission definitions ────────────────────────────────────────────────────

type PermDef   = { key: string; label: string };
type PermGroup = { label: string; perms: PermDef[] };

const PERMISSION_GROUPS: PermGroup[] = [
  {
    label: "Desktop Features",
    perms: [
      { key: "yield:view",            label: "Yield — View" },
      { key: "yield:edit",            label: "Yield — Edit" },
      { key: "irrigation:view",       label: "Irrigation — View" },
      { key: "irrigation:edit",       label: "Irrigation — Edit" },
      { key: "pest:view",             label: "Pest — View" },
      { key: "pest:edit",             label: "Pest — Edit" },
      { key: "quality:view",          label: "Quality — View" },
      { key: "quality:edit",          label: "Quality — Edit" },
      { key: "quality:bonuses_view",  label: "Quality — Bonuses View" },
      { key: "quality:bonuses_edit",  label: "Quality — Bonuses Edit" },
      { key: "greenhouse_setup:view", label: "Greenhouse Setup — View" },
      { key: "greenhouse_setup:edit", label: "Greenhouse Setup — Edit" },
      { key: "cases:view",            label: "Cases — View" },
      { key: "cases:edit",            label: "Cases — Edit" },
      { key: "payroll:view",          label: "Payroll — View" },
      { key: "payroll:edit",          label: "Payroll — Edit" },
      { key: "food_safety:view",      label: "Food Safety — View" },
      { key: "food_safety:edit",      label: "Food Safety — Edit" },
      { key: "food_safety:delete_reports", label: "Food Safety — Delete Reports" },
      { key: "calibration:view",      label: "Calibration — View" },
      { key: "calibration:edit",      label: "Calibration — Edit" },
      { key: "calibration:delete_records", label: "Calibration — Delete Records" },
    ],
  },
  {
    label: "Mobile Features",
    perms: [
      { key: "mobile:access",       label: "Mobile — Access" },
      { key: "mobile:daily_yield",  label: "Mobile — Daily Yield" },
      { key: "mobile:irrigation",   label: "Mobile — Irrigation" },
      { key: "mobile:pest",         label: "Mobile — Pest" },
      { key: "mobile:quality",      label: "Mobile — Quality" },
      { key: "mobile:payroll",      label: "Mobile — Payroll" },
      { key: "mobile:food_safety",  label: "Mobile — Food Safety" },
      { key: "mobile:calibration",  label: "Mobile — Calibration" },
    ],
  },
  {
    label: "Admin",
    perms: [
      { key: "admin:invite_users",  label: "Invite Users" },
    ],
  },
];

function initialChecked(): Record<string, boolean> {
  return Object.fromEntries(
    PERMISSION_GROUPS.flatMap(g => g.perms).map(p => [p.key, false])
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const msg = (body as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim().length > 0 ? msg : fallback;
}

function inviteStatus(row: InviteRow): "Accepted" | "Expired" | "Pending" {
  if (row.accepted_at) return "Accepted";
  if (new Date(row.expires_at) < new Date()) return "Expired";
  return "Pending";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// ── component ─────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [position, setPosition] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>(initialChecked);
  const [formState, setFormState] = useState<FormState>("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── users management state ────────────────────────────────────────────────
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("member");
  const [editPosition, setEditPosition] = useState("");
  const [editChecked, setEditChecked] = useState<Record<string, boolean>>(initialChecked);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);
  const [removeInProgress, setRemoveInProgress] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // ── import history reset ──────────────────────────────────────────────────
  const [importRuns, setImportRuns] = useState<ImportRunRow[]>([]);
  const [importRunsLoading, setImportRunsLoading] = useState(false);
  const [importRunsError, setImportRunsError] = useState<string | null>(null);
  const [importFilterYear, setImportFilterYear] = useState("");
  const [importFilterWeek, setImportFilterWeek] = useState("");
  const [importFilterFilename, setImportFilterFilename] = useState("");
  const [importDeleteResult, setImportDeleteResult] = useState<string | null>(null);
  const [importDeleting, setImportDeleting] = useState(false);
  const [importDeleteConfirm, setImportDeleteConfirm] = useState<{ title: string; ids: string[] } | null>(null);

  // ── pending invite actions ─────────────────────────────────────────────────
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [pendingActionError, setPendingActionError] = useState<string | null>(null);
  const [resendSuccessId, setResendSuccessId] = useState<string | null>(null);

  useEffect(() => {
    void loadInvites();
    void loadUsers();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setCurrentUserId(user?.id ?? null);
    });
  }, []);

  async function loadInvites() {
    try {
      const res = await apiFetch("/api/invites");

      if (res.status === 401 || res.status === 403) {
        setAccessState("denied");
        return;
      }

      const body = (await res.json().catch(() => ({}))) as { invites?: InviteRow[]; message?: string };

      if (!res.ok) {
        setListError(getResponseMessage(body, "Failed to load invites."));
        setAccessState("allowed");
        return;
      }

      setInvites(Array.isArray(body.invites) ? body.invites : []);
      setListError(null);
      setAccessState("allowed");
    } catch {
      setListError("Network error while loading invites.");
      setAccessState("allowed");
    }
  }

  function togglePermission(key: string) {
    setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function buildPermissionsObject(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(checked)) {
      if (val) out[key] = true;
    }
    return out;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormState("submitting");
    setFormError(null);

    try {
      const res = await apiFetch("/api/invites", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          position: position.trim() || undefined,
          permissions: buildPermissionsObject(),
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        inviteUrl?: string;
      };

      if (res.status === 401 || res.status === 403) {
        setFormState("error");
        setFormError("Only owners and admins can invite users.");
        return;
      }

      if (!res.ok) {
        setFormState("error");
        setFormError(getResponseMessage(body, "Failed to create invite. Please try again."));
        return;
      }

      setInviteUrl(typeof body.inviteUrl === "string" ? body.inviteUrl : null);
      setFormState("success");
      void loadInvites();
    } catch {
      setFormState("error");
      setFormError("Network error. Please try again.");
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available — user can copy manually
    }
  }

  async function loadUsers() {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await apiFetch("/api/users");
      if (res.status === 401 || res.status === 403) {
        setUsersLoading(false);
        return; // silently skip — access already shown via accessState
      }
      const body = (await res.json().catch(() => ({}))) as { users?: UserRow[]; message?: string };
      if (!res.ok) {
        setUsersError(getResponseMessage(body, "Failed to load team members."));
        setUsersLoading(false);
        return;
      }
      setUsers(Array.isArray(body.users) ? body.users : []);
    } catch {
      setUsersError("Network error while loading team members.");
    } finally {
      setUsersLoading(false);
    }
  }

  function handleEditOpen(user: UserRow) {
    setEditingMembershipId(user.membershipId);
    setEditRole(user.role);
    setEditPosition(user.position ?? "");
    const checked = { ...initialChecked() };
    for (const key of Object.keys(user.permissions)) {
      if (key in checked) checked[key] = user.permissions[key] === true;
    }
    setEditChecked(checked);
    setEditError(null);
    setRemovingMembershipId(null);
    setRemoveError(null);
  }

  function handleEditCancel() {
    setEditingMembershipId(null);
    setEditError(null);
  }

  function toggleEditPermission(key: string) {
    setEditChecked(prev => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleEditSave() {
    if (!editingMembershipId) return;
    setEditSaving(true);
    setEditError(null);
    const permissions: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(editChecked)) {
      if (val) permissions[key] = true;
    }
    try {
      const res = await apiFetch(`/api/users/${editingMembershipId}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: editRole,
          position: editPosition.trim() || null,
          permissions,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setEditError(getResponseMessage(body, "Failed to save changes."));
        return;
      }
      setEditingMembershipId(null);
      void loadUsers();
    } catch {
      setEditError("Network error. Please try again.");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleRemove(membershipId: string) {
    setRemoveInProgress(true);
    setRemoveError(null);
    try {
      const res = await apiFetch(`/api/users/${membershipId}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setRemoveError(getResponseMessage(body, "Failed to remove user."));
        return;
      }
      setRemovingMembershipId(null);
      void loadUsers();
    } catch {
      setRemoveError("Network error. Please try again.");
    } finally {
      setRemoveInProgress(false);
    }
  }

  async function handleCancelInvite(inviteId: string) {
    setPendingActionId(inviteId);
    setPendingActionError(null);
    try {
      const res = await apiFetch(`/api/invites/${inviteId}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setPendingActionError(getResponseMessage(body, "Failed to cancel invite."));
        return;
      }
      setCancelConfirmId(null);
      void loadInvites();
    } catch {
      setPendingActionError("Network error. Please try again.");
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleResendInvite(inviteId: string) {
    setPendingActionId(inviteId);
    setPendingActionError(null);
    setResendSuccessId(null);
    try {
      const res = await apiFetch(`/api/invites/${inviteId}/resend`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setPendingActionError(getResponseMessage(body, "Failed to resend invite."));
        return;
      }
      setResendSuccessId(inviteId);
      setTimeout(() => setResendSuccessId(null), 3000);
      void loadInvites();
    } catch {
      setPendingActionError("Network error. Please try again.");
    } finally {
      setPendingActionId(null);
    }
  }

  function handleSendAnother() {
    setEmail("");
    setPosition("");
    setChecked(initialChecked());
    setInviteUrl(null);
    setCopied(false);
    setFormState("idle");
    setFormError(null);
  }

  // ── import history ────────────────────────────────────────────────────────

  const currentUserRole = useMemo(
    () => (currentUserId ? (users.find((u) => u.userId === currentUserId)?.role ?? null) : null),
    [currentUserId, users]
  );

  const isOrgOwnerOrAdmin = currentUserRole === "owner" || currentUserRole === "admin";

  useEffect(() => {
    if (isOrgOwnerOrAdmin) void loadImportRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrgOwnerOrAdmin]);

  async function loadImportRuns() {
    setImportRunsLoading(true);
    setImportRunsError(null);
    try {
      const res = await apiFetch("/api/settings/import-runs");
      if (res.status === 401 || res.status === 403) {
        setImportRunsLoading(false);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { runs?: ImportRunRow[]; message?: string };
      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to load import history."));
        setImportRunsLoading(false);
        return;
      }
      setImportRuns(Array.isArray(body.runs) ? body.runs : []);
    } catch {
      setImportRunsError("Network error while loading import history.");
    } finally {
      setImportRunsLoading(false);
    }
  }

  const importFilteredRuns = useMemo(() => {
    return importRuns.filter((r) => {
      if (importFilterYear && String(r.isoYear ?? "") !== importFilterYear) return false;
      if (importFilterWeek && String(r.isoWeek ?? "").padStart(2, "0") !== importFilterWeek.padStart(2, "0")) return false;
      if (importFilterFilename && !(r.sourceFilename ?? "").toLowerCase().includes(importFilterFilename.toLowerCase())) return false;
      return true;
    });
  }, [importRuns, importFilterYear, importFilterWeek, importFilterFilename]);

  const importAvailableYears = useMemo(() => {
    return Array.from(new Set(importRuns.map((r) => String(r.isoYear ?? "")).filter(Boolean))).sort().reverse();
  }, [importRuns]);

  const importAvailableWeeks = useMemo(() => {
    const source = importFilterYear
      ? importRuns.filter((r) => String(r.isoYear ?? "") === importFilterYear)
      : importRuns;
    return Array.from(new Set(source.map((r) => String(r.isoWeek ?? "")).filter(Boolean)))
      .sort((a, b) => Number(a) - Number(b));
  }, [importRuns, importFilterYear]);

  function handleDeleteImportRuns() {
    if (importFilteredRuns.length === 0) return;
    const ids = importFilteredRuns.map((r) => r.id);
    const count = ids.length;
    const parts: string[] = [];
    if (importFilterYear) parts.push(importFilterYear);
    if (importFilterWeek) parts.push(`Week ${importFilterWeek.padStart(2, "0")}`);
    const suffix = parts.length > 0 ? ` for ${parts.join(" ")}` : "";
    setImportDeleteConfirm({ title: `Delete ${count} import run${count === 1 ? "" : "s"}${suffix}?`, ids });
  }

  async function executeDeleteImportRuns(ids: string[]) {
    setImportDeleting(true);
    setImportDeleteResult(null);
    setImportRunsError(null);
    try {
      const res = await apiFetch("/api/settings/import-runs/delete", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const body = (await res.json().catch(() => ({}))) as { deletedCount?: number; message?: string };
      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to delete import history."));
        return;
      }
      const deleted = typeof body.deletedCount === "number" ? body.deletedCount : ids.length;
      setImportDeleteResult(`Deleted ${deleted} import run${deleted === 1 ? "" : "s"}. Those lots can now be resent by the agent.`);
      setImportFilterYear("");
      setImportFilterWeek("");
      setImportFilterFilename("");
      void loadImportRuns();
    } catch {
      setImportRunsError("Network error. Please try again.");
    } finally {
      setImportDeleting(false);
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Invite Users</h2>
        <p style={descriptionStyle}>
          Send an email invite so a new team member can create their GrowLink account.
        </p>

        {accessState === "loading" && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading...</p>
        )}

        {accessState === "denied" && (
          <p style={errorBannerStyle}>Only owners and admins can invite users.</p>
        )}

        {accessState === "allowed" && formState !== "success" && (
          <form onSubmit={handleSubmit} style={cardStyle}>
            <div style={fieldRowStyle}>
              <label htmlFor="invite-email" style={labelStyle}>
                Email <span style={{ color: "#c0392b" }}>*</span>
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                style={inputStyle}
              />
            </div>

            <div style={fieldRowStyle}>
              <label htmlFor="invite-position" style={labelStyle}>
                Position{" "}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="invite-position"
                type="text"
                value={position}
                onChange={e => setPosition(e.target.value)}
                placeholder="e.g. Grower, Packline operator"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <span style={labelStyle}>Permissions</span>
              {PERMISSION_GROUPS.map(group => (
                <div key={group.label} style={permGroupStyle}>
                  <span style={permGroupLabelStyle}>{group.label}</span>
                  <div style={permGridStyle}>
                    {group.perms.map(p => (
                      <label key={p.key} style={checkLabelStyle}>
                        <input
                          type="checkbox"
                          checked={checked[p.key] ?? false}
                          onChange={() => togglePermission(p.key)}
                          style={{ marginRight: "0.4rem", accentColor: "var(--brand)" }}
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {formState === "error" && formError && (
              <p style={errorBannerStyle}>{formError}</p>
            )}

            <button
              type="submit"
              disabled={formState === "submitting"}
              style={primaryButtonStyle}
            >
              {formState === "submitting" ? "Sending invite..." : "Send invite email"}
            </button>
          </form>
        )}

        {accessState === "allowed" && formState === "success" && inviteUrl && (
          <div style={successCardStyle}>
            <p style={{ margin: "0 0 0.4rem", fontWeight: 600, color: "var(--brand)" }}>
              Invite email sent
            </p>
            <p style={{ margin: "0 0 0.6rem", fontSize: "0.83rem", color: "var(--text-muted)" }}>
              A GrowLink invite email was sent. Keep this link as a backup in case delivery fails.
            </p>
            <div style={monoBoxStyle}>{inviteUrl}</div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
              <button type="button" onClick={handleCopy} style={secondaryButtonStyle}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
              <button type="button" onClick={handleSendAnother} style={secondaryButtonStyle}>
                Invite another user
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Team Members ──────────────────────────────────────────────────── */}
      {accessState === "allowed" && (
        <section style={sectionStyle}>
          <h2 style={titleStyle}>Team Members</h2>
          <p style={descriptionStyle}>
            Manage roles and permissions for existing members of your organization.
          </p>

          {usersError && <p style={errorBannerStyle}>{usersError}</p>}

          {/* Edit panel — shown instead of the table when editing */}
          {editingMembershipId && (() => {
            const editingUser = users.find(u => u.membershipId === editingMembershipId);
            const displayName = editingUser
              ? (editingUser.displayName ?? editingUser.email ?? "Unknown user")
              : "User";
            return (
              <div style={cardStyle}>
                <p style={{ margin: "0 0 0.8rem", fontWeight: 600, color: "var(--text)" }}>
                  Editing: {displayName}
                </p>

                <div style={fieldRowStyle}>
                  <label style={labelStyle}>Role</label>
                  <select
                    value={editRole}
                    onChange={e => setEditRole(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                </div>

                <div style={fieldRowStyle}>
                  <label style={labelStyle}>
                    Position{" "}
                    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={editPosition}
                    onChange={e => setEditPosition(e.target.value)}
                    placeholder="e.g. Grower, Packline operator"
                    style={inputStyle}
                  />
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <span style={labelStyle}>Permissions</span>
                  <p style={{ margin: "0.2rem 0 0.5rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    Ignored for owner and admin — they have full access.
                  </p>
                  {PERMISSION_GROUPS.map(group => (
                    <div key={group.label} style={permGroupStyle}>
                      <span style={permGroupLabelStyle}>{group.label}</span>
                      <div style={permGridStyle}>
                        {group.perms.map(p => (
                          <label key={p.key} style={checkLabelStyle}>
                            <input
                              type="checkbox"
                              checked={editChecked[p.key] ?? false}
                              onChange={() => toggleEditPermission(p.key)}
                              style={{ marginRight: "0.4rem", accentColor: "var(--brand)" }}
                            />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {editError && <p style={errorBannerStyle}>{editError}</p>}

                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={handleEditSave}
                    disabled={editSaving}
                    style={primaryButtonStyle}
                  >
                    {editSaving ? "Saving..." : "Save changes"}
                  </button>
                  <button
                    type="button"
                    onClick={handleEditCancel}
                    style={{ ...secondaryButtonStyle, marginTop: 0 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Users table — shown when not editing */}
          {!editingMembershipId && (
            <div style={cardStyle}>
              {usersLoading ? (
                <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.875rem" }}>
                  Loading members...
                </p>
              ) : users.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.875rem" }}>
                  No members found.
                </p>
              ) : (
                <>
                  {removeError && <p style={{ ...errorBannerStyle, marginBottom: "0.6rem" }}>{removeError}</p>}
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Name / Email</th>
                        <th style={thStyle}>Position</th>
                        <th style={thStyle}>Role</th>
                        <th style={thStyle}>Permissions</th>
                        <th style={thStyle}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map(user => {
                        const isMe = user.userId === currentUserId;
                        const isConfirmingRemove = removingMembershipId === user.membershipId;
                        return (
                          <tr key={user.membershipId}>
                            <td style={tdStyle}>
                              <div style={{ fontWeight: 500 }}>
                                {user.displayName ?? user.email ?? "—"}
                              </div>
                              {user.displayName && user.email && (
                                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                                  {user.email}
                                </div>
                              )}
                              {isMe && (
                                <span style={youBadgeStyle}>you</span>
                              )}
                            </td>
                            <td style={tdStyle}>
                              {user.position ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                            </td>
                            <td style={tdStyle}>
                              <span style={roleBadgeStyle(user.role)}>{user.role}</span>
                            </td>
                            <td style={tdStyle}>
                              {permissionsSummary(user.role, user.permissions)}
                            </td>
                            <td style={tdStyle}>
                              {isMe ? (
                                <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>—</span>
                              ) : isConfirmingRemove ? (
                                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                                  <span style={{ fontSize: "0.78rem", color: "#8f2d1f" }}>Remove?</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRemove(user.membershipId)}
                                    disabled={removeInProgress}
                                    style={dangerButtonStyle}
                                  >
                                    {removeInProgress ? "..." : "Confirm"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setRemovingMembershipId(null); setRemoveError(null); }}
                                    style={smallSecondaryButtonStyle}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div style={{ display: "flex", gap: "0.4rem" }}>
                                  <button
                                    type="button"
                                    onClick={() => handleEditOpen(user)}
                                    style={smallSecondaryButtonStyle}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setRemovingMembershipId(user.membershipId); setRemoveError(null); }}
                                    style={dangerButtonStyle}
                                  >
                                    Remove
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {accessState === "allowed" && (
        <section style={sectionStyle}>
          <h2 style={titleStyle}>Pending Invites</h2>
          <p style={descriptionStyle}>
            Manage open invites for your organization. Resend or cancel invites that have not yet been accepted.
          </p>

          {listError && <p style={errorBannerStyle}>{listError}</p>}
          {pendingActionError && (
            <p style={{ ...errorBannerStyle, marginBottom: "0.6rem" }}>{pendingActionError}</p>
          )}

          <div style={cardStyle}>
            {(() => {
              const nonAccepted = invites.filter(r => !r.accepted_at);
              if (nonAccepted.length === 0 && !listError) {
                return (
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    No pending invites.
                  </p>
                );
              }
              return (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Email</th>
                      <th style={thStyle}>Position</th>
                      <th style={thStyle}>Created</th>
                      <th style={thStyle}>Expires</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nonAccepted.map(row => {
                      const status = inviteStatus(row);
                      const isActing = pendingActionId === row.id;
                      const isConfirmingCancel = cancelConfirmId === row.id;
                      const justResent = resendSuccessId === row.id;
                      return (
                        <tr key={row.id}>
                          <td style={tdStyle}>{row.email}</td>
                          <td style={tdStyle}>
                            {row.position ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                          </td>
                          <td style={tdStyle}>{formatDate(row.created_at)}</td>
                          <td style={tdStyle}>{formatDate(row.expires_at)}</td>
                          <td style={tdStyle}>
                            <span style={statusBadgeStyle(status)}>{status}</span>
                          </td>
                          <td style={tdStyle}>
                            {isConfirmingCancel ? (
                              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ fontSize: "0.78rem", color: "#8f2d1f" }}>Cancel invite?</span>
                                <button
                                  type="button"
                                  onClick={() => handleCancelInvite(row.id)}
                                  disabled={isActing}
                                  style={dangerButtonStyle}
                                >
                                  {isActing ? "..." : "Confirm"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setCancelConfirmId(null); setPendingActionError(null); }}
                                  style={smallSecondaryButtonStyle}
                                >
                                  Keep
                                </button>
                              </div>
                            ) : (
                              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                                {justResent ? (
                                  <span style={{ fontSize: "0.78rem", color: "#1f7a42" }}>Sent!</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleResendInvite(row.id)}
                                    disabled={isActing}
                                    style={smallSecondaryButtonStyle}
                                  >
                                    {isActing ? "..." : "Resend"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => { setCancelConfirmId(row.id); setPendingActionError(null); }}
                                  disabled={isActing}
                                  style={dangerButtonStyle}
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </section>
      )}

      {accessState === "allowed" && isOrgOwnerOrAdmin && (
        <section style={sectionStyle}>
          <h2 style={titleStyle}>Import History</h2>
          <p style={descriptionStyle}>
            Delete FlowMaster import records so the same lots and files can be resent by the agent. This does not delete any yield entries.
          </p>

          {importDeleteResult && (
            <div style={importSuccessBannerStyle}>{importDeleteResult}</div>
          )}
          {importRunsError && <p style={errorBannerStyle}>{importRunsError}</p>}

          <div style={cardStyle}>
            {/* Filters */}
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.8rem", alignItems: "flex-end" }}>
              <div>
                <label style={labelStyle}>Year</label>
                <select
                  value={importFilterYear}
                  onChange={(e) => { setImportFilterYear(e.target.value); setImportFilterWeek(""); }}
                  style={{ ...inputStyle, width: "auto", minWidth: 90 }}
                >
                  <option value="">All years</option>
                  {importAvailableYears.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Week</label>
                <select
                  value={importFilterWeek}
                  onChange={(e) => setImportFilterWeek(e.target.value)}
                  style={{ ...inputStyle, width: "auto", minWidth: 90 }}
                >
                  <option value="">All weeks</option>
                  {importAvailableWeeks.map((w) => (
                    <option key={w} value={w}>W{w.padStart(2, "0")}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={labelStyle}>Source filename</label>
                <input
                  type="text"
                  value={importFilterFilename}
                  onChange={(e) => setImportFilterFilename(e.target.value)}
                  placeholder="Filter by filename…"
                  style={inputStyle}
                />
              </div>
              {(importFilterYear || importFilterWeek || importFilterFilename) && (
                <button
                  type="button"
                  onClick={() => { setImportFilterYear(""); setImportFilterWeek(""); setImportFilterFilename(""); }}
                  style={secondaryButtonStyle}
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* Delete button */}
            {importFilteredRuns.length > 0 && (
              <div style={{ marginBottom: "0.8rem" }}>
                <button
                  type="button"
                  onClick={handleDeleteImportRuns}
                  disabled={importDeleting}
                  style={importDeleteButtonStyle}
                >
                  {importDeleting
                    ? "Deleting…"
                    : `Delete import history${importFilterYear ? ` for ${importFilterYear}${importFilterWeek ? `-W${importFilterWeek.padStart(2, "0")}` : ""}` : ""} (${importFilteredRuns.length})`}
                </button>
              </div>
            )}

            {/* Table */}
            {importRunsLoading ? (
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading import history…</p>
            ) : importFilteredRuns.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.875rem" }}>
                {importRuns.length === 0 ? "No import history found." : "No records match the current filters."}
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Source File</th>
                      <th style={thStyle}>Lot Number</th>
                      <th style={thStyle}>Year</th>
                      <th style={thStyle}>Week</th>
                      <th style={thStyle}>Variety</th>
                      <th style={thStyle}>Imported At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importFilteredRuns.map((run) => (
                      <tr key={run.id}>
                        <td style={tdStyle}>{run.sourceFilename ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                        <td style={tdStyle}>{run.lotNumber}</td>
                        <td style={tdStyle}>{run.isoYear ?? "—"}</td>
                        <td style={tdStyle}>{run.isoWeek != null ? `W${String(run.isoWeek).padStart(2, "0")}` : "—"}</td>
                        <td style={tdStyle}>{run.varietyName ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                        <td style={tdStyle}>{formatDate(run.importedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {importDeleteConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>{importDeleteConfirm.title}</h3>
            <p style={modalBodyStyle}>This only deletes import history.</p>
            <p style={modalBodyStyle}>Yield entries will not be deleted.</p>
            <p style={modalBodyStyle}>Deleting import history allows the same lots/files to be resent and appear in pending imports again.</p>
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setImportDeleteConfirm(null)} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = importDeleteConfirm.ids;
                  setImportDeleteConfirm(null);
                  void executeDeleteImportRuns(ids);
                }}
                style={modalDangerButtonStyle}
              >
                Delete Import History
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "1.5rem 1rem 2rem",
};

const sectionStyle: CSSProperties = {
  marginBottom: "1.5rem",
};

const titleStyle: CSSProperties = {
  fontSize: "1.15rem",
  fontWeight: 600,
  marginBottom: "0.2rem",
  color: "var(--text)",
};

const descriptionStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  marginBottom: "0.8rem",
  marginTop: 0,
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "0.9rem",
};

const successCardStyle: CSSProperties = {
  background: "var(--brand-soft)",
  border: "1px solid var(--brand)",
  borderRadius: 8,
  padding: "0.8rem",
};

const fieldRowStyle: CSSProperties = {
  marginBottom: "0.85rem",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 500,
  marginBottom: "0.3rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.65rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none",
  boxSizing: "border-box",
};

const permGroupStyle: CSSProperties = {
  marginTop: "0.6rem",
};

const permGroupLabelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.74rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-muted)",
  marginBottom: "0.35rem",
};

const permGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.4rem 1rem",
};

const checkLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: "0.83rem",
  color: "var(--text)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.75rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 600,
};

const secondaryButtonStyle: CSSProperties = {
  padding: "0.42rem 0.65rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.8rem",
  fontWeight: 500,
};

const errorBannerStyle: CSSProperties = {
  margin: "0 0 0.75rem",
  padding: "0.55rem 0.7rem",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#c0392b",
};

const monoBoxStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "0.78rem",
  background: "var(--surface-soft)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.55rem 0.7rem",
  wordBreak: "break-all",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.83rem",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontWeight: 600,
  padding: "0.45rem",
};

const tdStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  padding: "0.5rem 0.45rem",
  verticalAlign: "middle",
};

const importSuccessBannerStyle: CSSProperties = {
  margin: "0 0 0.75rem",
  padding: "0.55rem 0.7rem",
  background: "#f0faf4",
  border: "1px solid #a3d9b5",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#1f7a42",
};

const importDeleteButtonStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalPanelStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "1.5rem",
  maxWidth: 420,
  width: "calc(100% - 2rem)",
};

const modalTitleStyle: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--text)",
  margin: "0 0 0.75rem",
};

const modalBodyStyle: CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--text-muted)",
  margin: "0 0 0.4rem",
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  justifyContent: "flex-end",
  marginTop: "1.25rem",
};

const modalDangerButtonStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
};

function permissionsSummary(role: string, permissions: Record<string, boolean>): string {
  if (role === "owner" || role === "admin") return "Full access";
  const count = Object.values(permissions).filter(Boolean).length;
  if (count === 0) return "No permissions";
  return `${count} permission${count === 1 ? "" : "s"}`;
}

function roleBadgeStyle(role: string): CSSProperties {
  if (role === "owner") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "0.1rem 0.45rem",
      fontSize: "0.72rem",
      background: "#fef3c7",
      color: "#92400e",
      border: "1px solid #fde68a",
    };
  }
  if (role === "admin") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "0.1rem 0.45rem",
      fontSize: "0.72rem",
      background: "#ede9fe",
      color: "#5b21b6",
      border: "1px solid #ddd6fe",
    };
  }
  return {
    display: "inline-block",
    borderRadius: 999,
    padding: "0.1rem 0.45rem",
    fontSize: "0.72rem",
    background: "var(--surface-soft)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
  };
}

const youBadgeStyle: CSSProperties = {
  display: "inline-block",
  marginLeft: "0.4rem",
  borderRadius: 999,
  padding: "0.05rem 0.4rem",
  fontSize: "0.68rem",
  background: "var(--brand-soft)",
  color: "var(--brand)",
  border: "1px solid var(--brand)",
  fontWeight: 600,
};

const dangerButtonStyle: CSSProperties = {
  padding: "0.3rem 0.55rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 600,
};

const smallSecondaryButtonStyle: CSSProperties = {
  padding: "0.3rem 0.55rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 500,
};

function statusBadgeStyle(status: "Pending" | "Accepted" | "Expired"): CSSProperties {
  if (status === "Accepted") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "0.1rem 0.45rem",
      fontSize: "0.72rem",
      background: "#e8f8ef",
      color: "#1f7a42",
      border: "1px solid #bfe9cf",
    };
  }
  if (status === "Expired") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "0.1rem 0.45rem",
      fontSize: "0.72rem",
      background: "#f9eaea",
      color: "#8f2d1f",
      border: "1px solid #f0c5be",
    };
  }
  return {
    display: "inline-block",
    borderRadius: 999,
    padding: "0.1rem 0.45rem",
    fontSize: "0.72rem",
    background: "#eef3fb",
    color: "#2c5282",
    border: "1px solid #bee3f8",
  };
}
