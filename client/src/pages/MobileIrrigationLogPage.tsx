import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { enqueue } from "../services/offlineQueue";
import { useMembership } from "../contexts/MembershipContext";
import { getDefaultRoute } from "../utils/getDefaultRoute";

type GroupType = "phase" | "zone" | "color";

type LinkedEquipment = {
  id: string;
  name: string;
  group_id: string;
  dripper_count: number;
  status: "active" | "inactive";
};

type ExistingLog = {
  id: string;
  log_date: string;
  tracking_mode: GroupType;
  group_id: string | null;
  group_key: string;
  group_name: string;
  feed_valve_ids: string[];
  drain_bucket_ids: string[];
  feed_ph: number | null;
  feed_ec: number | null;
  drain_ph: number | null;
  drain_ec: number | null;
  feed_valve_readings?: Array<{ id: string; name: string; volume_ml: number | null }>;
  drain_bucket_readings?: Array<{ id: string; name: string; volume_ml: number | null }>;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type IrrigationLogGroup = {
  id: string;
  type: GroupType;
  name: string;
  feedValves: LinkedEquipment[];
  drainBuckets: LinkedEquipment[];
  existingLog: ExistingLog | null;
};

type IrrigationLogResponse = {
  log_date: string;
  tracking_mode: GroupType | null;
  groups: IrrigationLogGroup[];
};

// A single discriminated state instead of separate loading/error/groups
// booleans+arrays -- structurally guarantees only one of loading/loaded/error
// is ever "current" at once, so a failed or in-flight request can never be
// mistaken for a genuine zero-groups response (the bug this replaces: groups
// previously stayed [] on error, which the empty-state card couldn't tell
// apart from a real empty setup).
type PageState =
  | { status: "loading" }
  | { status: "loaded"; trackingMode: GroupType | null; groups: IrrigationLogGroup[] }
  | { status: "error"; message: string };

const LOAD_ERROR_MESSAGE = "Unable to load irrigation groups. Please check your connection and try again.";
const EMPTY_SETUP_MESSAGE = "No active irrigation groups have been set up yet.";

type GroupDraft = {
  feed_ph: string;
  feed_ec: string;
  drain_ph: string;
  drain_ec: string;
  notes: string;
  feed_valve_volumes: Record<string, string>;
  drain_bucket_volumes: Record<string, string>;
};

const IRRIGATION_LOG_URL = "/api/mobile/irrigation-log";

const TRACKING_LABELS: Record<GroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

function toDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toInputValue(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "";
  }

  return String(value);
}

function parseOptionalNonNegativeNumber(value: string, fieldLabel: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldLabel} must be 0 or greater.`);
  }

  return parsed;
}

function parseValidVolumeValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function averageOf(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function calculateDrainPercent(params: {
  feedVolume: number;
  feedDripperCount: number | null | undefined;
  drainVolume: number;
  drainDripperCount: number | null | undefined;
}) {
  const safeFeedDrippers = Number(params.feedDripperCount) > 0 ? Number(params.feedDripperCount) : 1;
  const safeDrainDrippers = Number(params.drainDripperCount) > 0 ? Number(params.drainDripperCount) : 1;

  const feedPerDripper = Number(params.feedVolume) / safeFeedDrippers;
  const drainPerDripper = Number(params.drainVolume) / safeDrainDrippers;

  if (!Number.isFinite(feedPerDripper) || feedPerDripper <= 0) {
    return 0;
  }

  if (!Number.isFinite(drainPerDripper) || drainPerDripper < 0) {
    return 0;
  }

  return (drainPerDripper / feedPerDripper) * 100;
}

function parseNormalizedVolume(volume: string, dripperCount: number | null | undefined): number | null {
  const parsedVolume = parseValidVolumeValue(volume);
  if (parsedVolume === null) {
    return null;
  }

  const safeDrippers = Number(dripperCount) > 0 ? Number(dripperCount) : 1;
  return parsedVolume / safeDrippers;
}

function formatMetric(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(decimals);
}

export function MobileIrrigationLogPage() {
  const { isOnline } = useOnlineStatus();
  const navigate = useNavigate();
  const { role, permissions } = useMembership();
  const [pageState, setPageState] = useState<PageState>({ status: "loading" });
  // Save-time errors (validation, PUT failures) are a distinct concern from
  // the page's load state above -- kept separate so a save error can never
  // be confused with (or hide/be hidden by) the load error/empty states.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [logDate, setLogDate] = useState(() => toDateString(new Date()));
  const [selectedGroupId, setSelectedGroupId] = useState("");

  const groups = pageState.status === "loaded" ? pageState.groups : [];
  const trackingMode = pageState.status === "loaded" ? pageState.trackingMode : null;
  const [draft, setDraft] = useState<GroupDraft>({
    feed_ph: "",
    feed_ec: "",
    drain_ph: "",
    drain_ec: "",
    notes: "",
    feed_valve_volumes: {},
    drain_bucket_volumes: {}
  });
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");

  const trackingModeLabel = useMemo(
    () => (trackingMode ? TRACKING_LABELS[trackingMode] : null),
    [trackingMode]
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId]
  );

  const feedVolumeValues = useMemo(() => {
    if (!selectedGroup) {
      return [] as number[];
    }

    return selectedGroup.feedValves
      .map((valve) => parseValidVolumeValue(draft.feed_valve_volumes[valve.id] ?? ""))
      .filter((value): value is number => value !== null);
  }, [selectedGroup, draft.feed_valve_volumes]);

  const drainVolumeValues = useMemo(() => {
    if (!selectedGroup) {
      return [] as number[];
    }

    return selectedGroup.drainBuckets
      .map((bucket) => parseValidVolumeValue(draft.drain_bucket_volumes[bucket.id] ?? ""))
      .filter((value): value is number => value !== null);
  }, [selectedGroup, draft.drain_bucket_volumes]);

  const normalizedFeedVolumeValues = useMemo(() => {
    if (!selectedGroup) {
      return [] as number[];
    }

    return selectedGroup.feedValves
      .map((valve) => parseNormalizedVolume(draft.feed_valve_volumes[valve.id] ?? "", valve.dripper_count))
      .filter((value): value is number => value !== null);
  }, [selectedGroup, draft.feed_valve_volumes]);

  const normalizedDrainVolumeValues = useMemo(() => {
    if (!selectedGroup) {
      return [] as number[];
    }

    return selectedGroup.drainBuckets
      .map((bucket) => parseNormalizedVolume(draft.drain_bucket_volumes[bucket.id] ?? "", bucket.dripper_count))
      .filter((value): value is number => value !== null);
  }, [selectedGroup, draft.drain_bucket_volumes]);

  const avgFeedMl = useMemo(() => averageOf(feedVolumeValues), [feedVolumeValues]);
  const avgDrainMl = useMemo(() => averageOf(drainVolumeValues), [drainVolumeValues]);
  const avgFeedMlPerDripper = useMemo(() => averageOf(normalizedFeedVolumeValues), [normalizedFeedVolumeValues]);
  const avgDrainMlPerDripper = useMemo(() => averageOf(normalizedDrainVolumeValues), [normalizedDrainVolumeValues]);
  // avgFeedMlPerDripper / avgDrainMlPerDripper are already normalised per dripper.
  // Pass dripper counts as 1 so calculateDrainPercent does not divide again.
  const drainPercent = useMemo(() => {
    if (avgFeedMlPerDripper === null || avgDrainMlPerDripper === null) {
      return null;
    }

    return calculateDrainPercent({
      feedVolume: avgFeedMlPerDripper,
      feedDripperCount: 1,
      drainVolume: avgDrainMlPerDripper,
      drainDripperCount: 1
    });
  }, [avgDrainMlPerDripper, avgFeedMlPerDripper]);

  function buildGroupDraft(group: IrrigationLogGroup): GroupDraft {
    const existingFeedReadings = new Map(
      (group.existingLog?.feed_valve_readings ?? []).map((reading) => [reading.id, reading])
    );
    const existingDrainReadings = new Map(
      (group.existingLog?.drain_bucket_readings ?? []).map((reading) => [reading.id, reading])
    );

    const feed_valve_volumes = group.feedValves.reduce<Record<string, string>>(
      (accumulator, valve) => {
        const saved = existingFeedReadings.get(valve.id)?.volume_ml;
        accumulator[valve.id] = saved === null || saved === undefined ? "" : String(saved);
        return accumulator;
      },
      {}
    );

    const drain_bucket_volumes = group.drainBuckets.reduce<Record<string, string>>(
      (accumulator, bucket) => {
        const saved = existingDrainReadings.get(bucket.id)?.volume_ml;
        accumulator[bucket.id] = saved === null || saved === undefined ? "" : String(saved);
        return accumulator;
      },
      {}
    );

    return {
      feed_ph: toInputValue(group.existingLog?.feed_ph),
      feed_ec: toInputValue(group.existingLog?.feed_ec),
      drain_ph: toInputValue(group.existingLog?.drain_ph),
      drain_ec: toInputValue(group.existingLog?.drain_ec),
      notes: group.existingLog?.notes ?? "",
      feed_valve_volumes,
      drain_bucket_volumes
    };
  }

  async function fetchLogData() {
    setPageState({ status: "loading" });

    try {
      const params = new URLSearchParams({ log_date: logDate });
      const response = await apiFetch(`${IRRIGATION_LOG_URL}?${params.toString()}`);

      if (response.status === 401 || response.status === 403) {
        // Permissions changed (or the session expired) while this page was
        // open. Never show stale groups or the empty-state card here --
        // clear to a neutral loading state and leave immediately for the
        // user's normal authorized landing page (there is no permissions
        // refetch/invalidation mechanism in this app yet to attempt instead
        // -- see MembershipContext.tsx).
        setPageState({ status: "loading" });
        navigate(getDefaultRoute(role, permissions), { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error("request-failed");
      }

      const data = (await response.json()) as IrrigationLogResponse;
      const nextGroups = data.groups ?? [];

      setPageState({ status: "loaded", trackingMode: data.tracking_mode ?? null, groups: nextGroups });

      setSelectedGroupId((current) => {
        if (current && nextGroups.some((group) => group.id === current)) {
          return current;
        }

        return nextGroups[0]?.id ?? "";
      });
      setSavedMessage("");
    } catch {
      setPageState({ status: "error", message: LOAD_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    void fetchLogData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logDate]);

  useEffect(() => {
    if (!selectedGroup) {
      setDraft({
        feed_ph: "",
        feed_ec: "",
        drain_ph: "",
        drain_ec: "",
        notes: "",
        feed_valve_volumes: {},
        drain_bucket_volumes: {}
      });
      return;
    }

    setDraft(buildGroupDraft(selectedGroup));
  }, [selectedGroup]);

  async function saveGroupLog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError(null);

    if (!trackingMode) {
      setSaveError("No irrigation tracking mode is configured yet.");
      return;
    }

    if (!selectedGroup) {
      setSaveError("Please select a tracking group.");
      return;
    }

    let feedPh: number | null;
    let feedEc: number | null;
    let drainPh: number | null;
    let drainEc: number | null;

    try {
      feedPh = parseOptionalNonNegativeNumber(draft.feed_ph, "Feed pH");
      feedEc = parseOptionalNonNegativeNumber(draft.feed_ec, "Feed EC");
      drainPh = parseOptionalNonNegativeNumber(draft.drain_ph, "Drain pH");
      drainEc = parseOptionalNonNegativeNumber(draft.drain_ec, "Drain EC");
    } catch (parseError) {
      setSaveError(parseError instanceof Error ? parseError.message : "Invalid irrigation value");
      return;
    }

    let feedValveReadings: Array<{ id: string; name: string; volume_ml: number | null }>;
    let drainBucketReadings: Array<{ id: string; name: string; volume_ml: number | null }>;

    try {
      feedValveReadings = selectedGroup.feedValves.map((valve) => {
        const volume = draft.feed_valve_volumes[valve.id] ?? "";

        return {
          id: valve.id,
          name: valve.name,
          volume_ml: parseOptionalNonNegativeNumber(volume, `${valve.name} volume ml`)
        };
      });

      drainBucketReadings = selectedGroup.drainBuckets.map((bucket) => {
        const volume = draft.drain_bucket_volumes[bucket.id] ?? "";

        return {
          id: bucket.id,
          name: bucket.name,
          volume_ml: parseOptionalNonNegativeNumber(volume, `${bucket.name} volume ml`)
        };
      });
    } catch (parseError) {
      setSaveError(parseError instanceof Error ? parseError.message : "Invalid volume value");
      return;
    }

    const putBody = JSON.stringify({
      log_date: logDate,
      tracking_mode: trackingMode,
      feed_valve_ids: selectedGroup.feedValves.map((valve) => valve.id),
      drain_bucket_ids: selectedGroup.drainBuckets.map((bucket) => bucket.id),
      feed_valve_readings: feedValveReadings,
      drain_bucket_readings: drainBucketReadings,
      feed_ph: feedPh,
      feed_ec: feedEc,
      drain_ph: drainPh,
      drain_ec: drainEc,
      notes: draft.notes.trim() || null
    });

    setSaving(true);
    setSavedMessage("");

    try {
      if (!isOnline) {
        await enqueue({
          module: "irrigation",
          url: `${IRRIGATION_LOG_URL}/${selectedGroup.id}`,
          method: "PUT",
          body: putBody,
        });
        setSavedMessage(`Saved offline — ${selectedGroup.name} will sync when connected`);
        return;
      }

      const response = await apiFetch(`${IRRIGATION_LOG_URL}/${selectedGroup.id}`, {
        method: "PUT",
        body: putBody,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save irrigation log");
      }

      const saved = (await response.json()) as ExistingLog;

      setPageState((current) =>
        current.status === "loaded"
          ? {
              ...current,
              groups: current.groups.map((entry) =>
                entry.id === selectedGroup.id ? { ...entry, existingLog: saved } : entry
              )
            }
          : current
      );

      setSavedMessage(`Saved ${selectedGroup.name} for ${logDate}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save irrigation log");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mobile-page mobile-irrigation-page">
      <h2>Irrigation Log</h2>
      <p>Log feed and drain readings once per tracking group.</p>
      <p>Drain % is normalized by configured dripper counts.</p>

      {trackingModeLabel ? <p>Tracking by {trackingModeLabel}</p> : null}
      <p>Log date: {logDate}</p>

      {/* Exactly one of loading / error / empty-setup / loaded-with-groups
          renders at a time -- pageState.status is a single discriminant, so
          none of these branches can ever appear alongside another. */}
      {pageState.status === "loading" ? <p>Loading...</p> : null}

      {pageState.status === "error" ? (
        <div className="mobile-yield-card">
          <p className="form-error">{pageState.message}</p>
          <button type="button" onClick={() => void fetchLogData()}>
            Retry
          </button>
        </div>
      ) : null}

      {pageState.status === "loaded" && groups.length === 0 ? (
        <div className="mobile-yield-card">
          <p>{EMPTY_SETUP_MESSAGE}</p>
        </div>
      ) : null}

      {saveError ? <p className="form-error">{saveError}</p> : null}

      {groups.length > 0 ? (
        <article className="mobile-yield-card mobile-irrigation-card">
          <form className="mobile-yield-form" onSubmit={(event) => void saveGroupLog(event)}>
            <label>
              Select {trackingModeLabel ?? "Group"}
              <select
                value={selectedGroupId}
                onChange={(event) => {
                  setSelectedGroupId(event.target.value);
                  setSavedMessage("");
                }}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            {selectedGroup ? (
              <>
                <h3>{selectedGroup.name}</h3>
                <p>
                  {TRACKING_LABELS[selectedGroup.type]} group | {selectedGroup.feedValves.length} feed valve(s) |{" "}
                  {selectedGroup.drainBuckets.length} drain bucket(s)
                </p>

                <div>
                  <h4>Feed Valves ({selectedGroup.feedValves.length})</h4>
                  {selectedGroup.feedValves.length === 0 ? (
                    <p>None linked</p>
                  ) : (
                    <ul className="mobile-irrigation-equipment-list">
                      {selectedGroup.feedValves.map((valve) => (
                        <li key={valve.id} className="mobile-irrigation-reading-row">
                          <div>
                            <strong>{valve.name}</strong>
                          </div>
                          <label>
                            Volume ml
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              value={draft.feed_valve_volumes[valve.id] ?? ""}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  feed_valve_volumes: {
                                    ...current.feed_valve_volumes,
                                    [valve.id]: event.target.value
                                  }
                                }))
                              }
                            />
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <h4>Drain Buckets ({selectedGroup.drainBuckets.length})</h4>
                  {selectedGroup.drainBuckets.length === 0 ? (
                    <p>None linked</p>
                  ) : (
                    <ul className="mobile-irrigation-equipment-list">
                      {selectedGroup.drainBuckets.map((bucket) => (
                        <li key={bucket.id} className="mobile-irrigation-reading-row">
                          <div>
                            <strong>{bucket.name}</strong>
                          </div>
                          <label>
                            Volume ml
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              value={draft.drain_bucket_volumes[bucket.id] ?? ""}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  drain_bucket_volumes: {
                                    ...current.drain_bucket_volumes,
                                    [bucket.id]: event.target.value
                                  }
                                }))
                              }
                            />
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mobile-irrigation-bottom-section">
                  <div className="mobile-irrigation-input-grid">
                    <label>
                      Feed EC
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.feed_ec}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, feed_ec: event.target.value }))
                        }
                      />
                    </label>

                    <label>
                      Feed pH
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.feed_ph}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, feed_ph: event.target.value }))
                        }
                      />
                    </label>

                    <label>
                      Drain EC
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.drain_ec}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, drain_ec: event.target.value }))
                        }
                      />
                    </label>

                    <label>
                      Drain pH
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.drain_ph}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, drain_ph: event.target.value }))
                        }
                      />
                    </label>
                  </div>

                  <label>
                    Notes
                    <textarea
                      className="mobile-irrigation-notes"
                      rows={3}
                      value={draft.notes}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, notes: event.target.value }))
                      }
                    />
                  </label>

                  <div className="mobile-irrigation-metrics">
                    <p>Average feed ml: {formatMetric(avgFeedMl)}</p>
                    <p>Average drain ml: {formatMetric(avgDrainMl)}</p>
                    <p>Drain percent: {drainPercent === null ? "--" : `${formatMetric(drainPercent)}%`}</p>
                  </div>
                </div>

                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : `Save ${selectedGroup.name} Log`}
                </button>

                {savedMessage ? <p className="mobile-irrigation-saved">{savedMessage}</p> : null}
              </>
            ) : null}
          </form>
        </article>
      ) : null}
    </section>
  );
}
