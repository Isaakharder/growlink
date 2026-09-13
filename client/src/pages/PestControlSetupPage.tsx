import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

type CalibrationRecord = {
  id: string;
  sprayer_id: string;
  psi: number;
  nozzle_1_ml_per_min: number;
  nozzle_2_ml_per_min: number;
  nozzle_3_ml_per_min: number;
  avg_ml_per_min: number;
  notes: string | null;
};

type CalibrationFormPsiRow = {
  nozzle_1: string;
  nozzle_2: string;
  nozzle_3: string;
};

type CalibrationFormState = {
  readings: Record<number, CalibrationFormPsiRow>;
  notes: string;
};

const CALIBRATION_PSI_POINTS = [50, 100, 150, 200] as const;

const EMPTY_PSI_ROW: CalibrationFormPsiRow = { nozzle_1: "", nozzle_2: "", nozzle_3: "" };

const INITIAL_CAL_FORM: CalibrationFormState = {
  readings: { 50: { ...EMPTY_PSI_ROW }, 100: { ...EMPTY_PSI_ROW }, 150: { ...EMPTY_PSI_ROW }, 200: { ...EMPTY_PSI_ROW } },
  notes: ""
};

type SprayerTank = { id: string; name: string; volume_liters: number };

type Sprayer = {
  id: string;
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  speed_m_per_min: number | null;
  min_speed_m_per_min: number | null;
  max_speed_m_per_min: number | null;
  speed_step_m_per_min: number | null;
  has_tank: boolean;
  tank_volume_liters: number | null;
  tank_id: string | null;
  tank: SprayerTank | null;
  created_at: string;
  updated_at: string;
};

type SprayerFormState = {
  name: string;
  nozzle_count: string;
  nozzle_volume_l_per_min: string;
  nozzle_psi: string;
  min_speed_m_per_min: string;
  max_speed_m_per_min: string;
  speed_step_m_per_min: string;
  has_tank: boolean;
  tank_volume_liters: string;
  tank_id: string;
};

type Tank = {
  id: string;
  name: string;
  volume_liters: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type TankFormState = {
  name: string;
  volume_liters: string;
  active: boolean;
};

type BogaertsRobot = {
  id: string;
  name: string;
  tank_volume_liters: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type BogaertsRobotFormState = {
  name: string;
  tank_volume_liters: string;
  active: boolean;
};

type BogaertsNozzleType = {
  id: string;
  name: string;
  color: string | null;
  spray_tip_code: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type BogaertsNozzleTypeFormState = {
  name: string;
  color: string;
  spray_tip_code: string;
  active: boolean;
};

const SPRAYERS_URL = "/api/pest/sprayers";
const TANKS_URL = "/api/pest/tanks";
const CALIBRATIONS_URL = "/api/pest/calibrations";
const BOGAERTS_ROBOTS_URL = "/api/pest/bogaerts/robots";
const BOGAERTS_NOZZLE_TYPES_URL = "/api/pest/bogaerts/nozzle-types";

const INITIAL_SPRAYER_FORM: SprayerFormState = {
  name: "",
  nozzle_count: "1",
  nozzle_volume_l_per_min: "0",
  nozzle_psi: "0",
  min_speed_m_per_min: "",
  max_speed_m_per_min: "",
  speed_step_m_per_min: "",
  has_tank: false,
  tank_volume_liters: "",
  tank_id: ""
};

const INITIAL_TANK_FORM: TankFormState = {
  name: "",
  volume_liters: "",
  active: true
};

const INITIAL_BOGAERTS_ROBOT_FORM: BogaertsRobotFormState = {
  name: "",
  tank_volume_liters: "300",
  active: true
};

const INITIAL_BOGAERTS_NOZZLE_TYPE_FORM: BogaertsNozzleTypeFormState = {
  name: "",
  color: "",
  spray_tip_code: "",
  active: true
};

function toBogaertsRobotFormState(robot: BogaertsRobot): BogaertsRobotFormState {
  return {
    name: robot.name,
    tank_volume_liters: String(robot.tank_volume_liters),
    active: robot.active
  };
}

function toBogaertsNozzleTypeFormState(nozzleType: BogaertsNozzleType): BogaertsNozzleTypeFormState {
  return {
    name: nozzleType.name,
    color: nozzleType.color ?? "",
    spray_tip_code: nozzleType.spray_tip_code ?? "",
    active: nozzleType.active
  };
}

function toSprayerFormState(sprayer: Sprayer): SprayerFormState {
  return {
    name: sprayer.name,
    nozzle_count: String(sprayer.nozzle_count),
    nozzle_volume_l_per_min: String(sprayer.nozzle_volume_l_per_min),
    nozzle_psi: String(sprayer.nozzle_psi),
    min_speed_m_per_min:
      sprayer.min_speed_m_per_min != null
        ? String(sprayer.min_speed_m_per_min)
        : sprayer.speed_m_per_min != null
          ? String(sprayer.speed_m_per_min)
          : "",
    max_speed_m_per_min:
      sprayer.max_speed_m_per_min != null
        ? String(sprayer.max_speed_m_per_min)
        : sprayer.speed_m_per_min != null
          ? String(sprayer.speed_m_per_min)
          : "",
    speed_step_m_per_min:
      sprayer.speed_step_m_per_min != null ? String(sprayer.speed_step_m_per_min) : "",
    has_tank: sprayer.has_tank,
    tank_volume_liters: sprayer.tank_volume_liters != null ? String(sprayer.tank_volume_liters) : "",
    tank_id: sprayer.tank_id ?? ""
  };
}

function toTankFormState(tank: Tank): TankFormState {
  return {
    name: tank.name,
    volume_liters: String(tank.volume_liters),
    active: tank.active
  };
}

export function PestControlSetupPage() {
  const [sprayers, setSprayers] = useState<Sprayer[]>([]);
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [bogaertsRobots, setBogaertsRobots] = useState<BogaertsRobot[]>([]);
  const [bogaertsNozzleTypes, setBogaertsNozzleTypes] = useState<BogaertsNozzleType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sprayer modal state
  const [sprayerForm, setSprayerForm] = useState<SprayerFormState>(INITIAL_SPRAYER_FORM);
  const [editingSprayerId, setEditingSprayerId] = useState<string | null>(null);
  const [isSprayerModalOpen, setIsSprayerModalOpen] = useState(false);
  const [sprayerSaving, setSprayerSaving] = useState(false);
  const [sprayerError, setSprayerError] = useState<string | null>(null);

  // Tank modal state
  const [tankForm, setTankForm] = useState<TankFormState>(INITIAL_TANK_FORM);
  const [editingTankId, setEditingTankId] = useState<string | null>(null);
  const [isTankModalOpen, setIsTankModalOpen] = useState(false);
  const [tankSaving, setTankSaving] = useState(false);
  const [tankError, setTankError] = useState<string | null>(null);

  // Bogaerts robot modal state
  const [robotForm, setRobotForm] = useState<BogaertsRobotFormState>(INITIAL_BOGAERTS_ROBOT_FORM);
  const [editingRobotId, setEditingRobotId] = useState<string | null>(null);
  const [isRobotModalOpen, setIsRobotModalOpen] = useState(false);
  const [robotSaving, setRobotSaving] = useState(false);
  const [robotError, setRobotError] = useState<string | null>(null);

  // Bogaerts nozzle type modal state
  const [nozzleTypeForm, setNozzleTypeForm] = useState<BogaertsNozzleTypeFormState>(INITIAL_BOGAERTS_NOZZLE_TYPE_FORM);
  const [editingNozzleTypeId, setEditingNozzleTypeId] = useState<string | null>(null);
  const [isNozzleTypeModalOpen, setIsNozzleTypeModalOpen] = useState(false);
  const [nozzleTypeSaving, setNozzleTypeSaving] = useState(false);
  const [nozzleTypeError, setNozzleTypeError] = useState<string | null>(null);

  // Calibration modal state
  const [calibrations, setCalibrations] = useState<CalibrationRecord[]>([]);
  const [calSprayerId, setCalSprayerId] = useState<string | null>(null);
  const [isCalModalOpen, setIsCalModalOpen] = useState(false);
  const [calForm, setCalForm] = useState<CalibrationFormState>(INITIAL_CAL_FORM);
  const [calSaving, setCalSaving] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const [sprayersRes, tanksRes, calsRes, robotsRes, nozzleTypesRes] = await Promise.all([
        apiFetch(SPRAYERS_URL),
        apiFetch(TANKS_URL),
        apiFetch(CALIBRATIONS_URL),
        apiFetch(BOGAERTS_ROBOTS_URL),
        apiFetch(BOGAERTS_NOZZLE_TYPES_URL)
      ]);
      if (!sprayersRes.ok || !tanksRes.ok) {
        throw new Error("Failed to load setup data");
      }
      setSprayers((await sprayersRes.json()) as Sprayer[]);
      setTanks((await tanksRes.json()) as Tank[]);
      if (calsRes.ok) {
        setCalibrations((await calsRes.json()) as CalibrationRecord[]);
      }
      if (robotsRes.ok) {
        setBogaertsRobots((await robotsRes.json()) as BogaertsRobot[]);
      }
      if (nozzleTypesRes.ok) {
        setBogaertsNozzleTypes((await nozzleTypesRes.json()) as BogaertsNozzleType[]);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load setup data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchData();
  }, []);


  // ── Sprayer modal helpers ──────────────────────────────────────────────────

  function openAddSprayerModal() {
    setEditingSprayerId(null);
    setSprayerForm(INITIAL_SPRAYER_FORM);
    setSprayerError(null);
    setIsSprayerModalOpen(true);
  }

  function beginEditSprayer(sprayer: Sprayer) {
    setEditingSprayerId(sprayer.id);
    setSprayerForm(toSprayerFormState(sprayer));
    setSprayerError(null);
    setIsSprayerModalOpen(true);
  }

  function closeSprayerModal() {
    setIsSprayerModalOpen(false);
    setEditingSprayerId(null);
    setSprayerForm(INITIAL_SPRAYER_FORM);
    setSprayerError(null);
  }

  async function handleSprayerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSprayerError(null);

    const name = sprayerForm.name.trim();
    if (!name) { setSprayerError("Name is required."); return; }

    const nozzle_count = Number(sprayerForm.nozzle_count);
    if (!Number.isInteger(nozzle_count) || nozzle_count < 1) {
      setSprayerError("Nozzle count must be 1 or greater."); return;
    }

    const nozzle_volume_l_per_min = Number(sprayerForm.nozzle_volume_l_per_min);
    if (!Number.isFinite(nozzle_volume_l_per_min) || nozzle_volume_l_per_min < 0) {
      setSprayerError("Nozzle volume must be 0 or greater."); return;
    }

    const nozzle_psi = Number(sprayerForm.nozzle_psi);
    if (!Number.isFinite(nozzle_psi) || nozzle_psi < 0) {
      setSprayerError("PSI must be 0 or greater."); return;
    }

    const min_raw = sprayerForm.min_speed_m_per_min.trim();
    const max_raw = sprayerForm.max_speed_m_per_min.trim();
    const step_raw = sprayerForm.speed_step_m_per_min.trim();
    const min_speed_m_per_min = min_raw !== "" ? Number(min_raw) : null;
    const max_speed_m_per_min = max_raw !== "" ? Number(max_raw) : null;
    const speed_step_m_per_min = step_raw !== "" ? Number(step_raw) : null;

    if (min_speed_m_per_min !== null && (!Number.isFinite(min_speed_m_per_min) || min_speed_m_per_min < 0)) {
      setSprayerError("Min speed must be 0 or greater."); return;
    }
    if (max_speed_m_per_min !== null && (!Number.isFinite(max_speed_m_per_min) || max_speed_m_per_min < 0)) {
      setSprayerError("Max speed must be 0 or greater."); return;
    }
    if (min_speed_m_per_min !== null && max_speed_m_per_min !== null && min_speed_m_per_min >= max_speed_m_per_min) {
      setSprayerError("Min speed must be less than max speed."); return;
    }
    if (speed_step_m_per_min !== null && (!Number.isFinite(speed_step_m_per_min) || speed_step_m_per_min <= 0)) {
      setSprayerError("Speed step must be greater than 0."); return;
    }

    const has_tank = sprayerForm.has_tank;
    let tank_volume_liters: number | null = null;
    let tank_id: string | null = null;

    if (has_tank) {
      const vol_raw = sprayerForm.tank_volume_liters.trim();
      if (vol_raw) {
        tank_volume_liters = Number(vol_raw);
        if (!Number.isFinite(tank_volume_liters) || tank_volume_liters <= 0) {
          setSprayerError("Tank volume must be greater than 0."); return;
        }
      }
    } else {
      tank_id = sprayerForm.tank_id || null;
    }

    setSprayerSaving(true);
    try {
      const method = editingSprayerId ? "PUT" : "POST";
      const url = editingSprayerId ? `${SPRAYERS_URL}/${editingSprayerId}` : SPRAYERS_URL;
      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name, nozzle_count, nozzle_volume_l_per_min, nozzle_psi,
          min_speed_m_per_min, max_speed_m_per_min, speed_step_m_per_min,
          has_tank, tank_volume_liters, tank_id
        })
      });
      if (!response.ok) {
        let message = editingSprayerId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* use fallback */ }
        throw new Error(message);
      }
      closeSprayerModal();
      await fetchData();
    } catch (submitError) {
      setSprayerError(submitError instanceof Error ? submitError.message : "Failed to save sprayer");
    } finally {
      setSprayerSaving(false);
    }
  }

  async function deleteSprayer(id: string) {
    if (!window.confirm("Delete this sprayer?")) return;
    setError(null);
    try {
      const response = await apiFetch(`${SPRAYERS_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      await fetchData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete sprayer");
    }
  }

  // ── Tank modal helpers ─────────────────────────────────────────────────────

  function openAddTankModal() {
    setEditingTankId(null);
    setTankForm(INITIAL_TANK_FORM);
    setTankError(null);
    setIsTankModalOpen(true);
  }

  function beginEditTank(tank: Tank) {
    setEditingTankId(tank.id);
    setTankForm(toTankFormState(tank));
    setTankError(null);
    setIsTankModalOpen(true);
  }

  function closeTankModal() {
    setIsTankModalOpen(false);
    setEditingTankId(null);
    setTankForm(INITIAL_TANK_FORM);
    setTankError(null);
  }

  async function handleTankSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTankError(null);

    const name = tankForm.name.trim();
    if (!name) { setTankError("Name is required."); return; }

    const volume_liters = Number(tankForm.volume_liters);
    if (!Number.isFinite(volume_liters) || volume_liters <= 0) {
      setTankError("Volume must be greater than 0."); return;
    }

    setTankSaving(true);
    try {
      const method = editingTankId ? "PUT" : "POST";
      const url = editingTankId ? `${TANKS_URL}/${editingTankId}` : TANKS_URL;
      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({ name, volume_liters, active: tankForm.active })
      });
      if (!response.ok) {
        let message = editingTankId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* use fallback */ }
        throw new Error(message);
      }
      closeTankModal();
      await fetchData();
    } catch (submitError) {
      setTankError(submitError instanceof Error ? submitError.message : "Failed to save tank");
    } finally {
      setTankSaving(false);
    }
  }

  async function deleteTank(id: string) {
    if (!window.confirm("Delete this tank?")) return;
    setError(null);
    try {
      const response = await apiFetch(`${TANKS_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      await fetchData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete tank");
    }
  }

  // ── Bogaerts robot modal helpers ───────────────────────────────────────────

  function openAddRobotModal() {
    setEditingRobotId(null);
    setRobotForm(INITIAL_BOGAERTS_ROBOT_FORM);
    setRobotError(null);
    setIsRobotModalOpen(true);
  }

  function beginEditRobot(robot: BogaertsRobot) {
    setEditingRobotId(robot.id);
    setRobotForm(toBogaertsRobotFormState(robot));
    setRobotError(null);
    setIsRobotModalOpen(true);
  }

  function closeRobotModal() {
    setIsRobotModalOpen(false);
    setEditingRobotId(null);
    setRobotForm(INITIAL_BOGAERTS_ROBOT_FORM);
    setRobotError(null);
  }

  async function handleRobotSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRobotError(null);

    const name = robotForm.name.trim();
    if (!name) { setRobotError("Name is required."); return; }

    const tank_volume_liters = Number(robotForm.tank_volume_liters);
    if (!Number.isFinite(tank_volume_liters) || tank_volume_liters <= 0) {
      setRobotError("Tank volume must be greater than 0."); return;
    }

    setRobotSaving(true);
    try {
      const method = editingRobotId ? "PUT" : "POST";
      const url = editingRobotId ? `${BOGAERTS_ROBOTS_URL}/${editingRobotId}` : BOGAERTS_ROBOTS_URL;
      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({ name, tank_volume_liters, active: robotForm.active })
      });
      if (!response.ok) {
        let message = editingRobotId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* use fallback */ }
        throw new Error(message);
      }
      closeRobotModal();
      await fetchData();
    } catch (submitError) {
      setRobotError(submitError instanceof Error ? submitError.message : "Failed to save robot");
    } finally {
      setRobotSaving(false);
    }
  }

  async function deleteRobot(id: string) {
    if (!window.confirm("Delete this robot?")) return;
    setError(null);
    try {
      const response = await apiFetch(`${BOGAERTS_ROBOTS_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      await fetchData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete robot");
    }
  }

  // ── Bogaerts nozzle type modal helpers ─────────────────────────────────────

  function openAddNozzleTypeModal() {
    setEditingNozzleTypeId(null);
    setNozzleTypeForm(INITIAL_BOGAERTS_NOZZLE_TYPE_FORM);
    setNozzleTypeError(null);
    setIsNozzleTypeModalOpen(true);
  }

  function beginEditNozzleType(nozzleType: BogaertsNozzleType) {
    setEditingNozzleTypeId(nozzleType.id);
    setNozzleTypeForm(toBogaertsNozzleTypeFormState(nozzleType));
    setNozzleTypeError(null);
    setIsNozzleTypeModalOpen(true);
  }

  function closeNozzleTypeModal() {
    setIsNozzleTypeModalOpen(false);
    setEditingNozzleTypeId(null);
    setNozzleTypeForm(INITIAL_BOGAERTS_NOZZLE_TYPE_FORM);
    setNozzleTypeError(null);
  }

  async function handleNozzleTypeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNozzleTypeError(null);

    const name = nozzleTypeForm.name.trim();
    if (!name) { setNozzleTypeError("Name is required."); return; }

    setNozzleTypeSaving(true);
    try {
      const method = editingNozzleTypeId ? "PUT" : "POST";
      const url = editingNozzleTypeId ? `${BOGAERTS_NOZZLE_TYPES_URL}/${editingNozzleTypeId}` : BOGAERTS_NOZZLE_TYPES_URL;
      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          color: nozzleTypeForm.color.trim() || null,
          spray_tip_code: nozzleTypeForm.spray_tip_code.trim() || null,
          active: nozzleTypeForm.active
        })
      });
      if (!response.ok) {
        let message = editingNozzleTypeId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* use fallback */ }
        throw new Error(message);
      }
      closeNozzleTypeModal();
      await fetchData();
    } catch (submitError) {
      setNozzleTypeError(submitError instanceof Error ? submitError.message : "Failed to save nozzle type");
    } finally {
      setNozzleTypeSaving(false);
    }
  }

  async function deleteNozzleType(id: string) {
    if (!window.confirm("Delete this nozzle type?")) return;
    setError(null);
    try {
      const response = await apiFetch(`${BOGAERTS_NOZZLE_TYPES_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      await fetchData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete nozzle type");
    }
  }

  // ── Calibration modal helpers ──────────────────────────────────────────────

  function closeCalModal() {
    setIsCalModalOpen(false);
    setCalSprayerId(null);
    setCalForm(INITIAL_CAL_FORM);
    setCalError(null);
  }

  function openCalModal(sprayerId: string) {
    const existing = calibrations.filter((c) => c.sprayer_id === sprayerId);
    const readings: Record<number, CalibrationFormPsiRow> = {
      50: { ...EMPTY_PSI_ROW },
      100: { ...EMPTY_PSI_ROW },
      150: { ...EMPTY_PSI_ROW },
      200: { ...EMPTY_PSI_ROW }
    };
    let notes = "";
    for (const row of existing) {
      readings[row.psi] = {
        nozzle_1: String(row.nozzle_1_ml_per_min),
        nozzle_2: String(row.nozzle_2_ml_per_min),
        nozzle_3: String(row.nozzle_3_ml_per_min)
      };
      if (row.notes) notes = row.notes;
    }
    setCalSprayerId(sprayerId);
    setCalForm({ readings, notes });
    setCalError(null);
    setCalSaving(false);
    setIsCalModalOpen(true);
  }

  async function handleCalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCalError(null);

    const rows = CALIBRATION_PSI_POINTS.map((psi) => {
      const r = calForm.readings[psi];
      return {
        psi,
        nozzle_1_ml_per_min: Number(r.nozzle_1),
        nozzle_2_ml_per_min: Number(r.nozzle_2),
        nozzle_3_ml_per_min: Number(r.nozzle_3)
      };
    });

    for (const row of rows) {
      for (const [key, val] of [
        ["Nozzle 1", row.nozzle_1_ml_per_min],
        ["Nozzle 2", row.nozzle_2_ml_per_min],
        ["Nozzle 3", row.nozzle_3_ml_per_min]
      ] as [string, number][]) {
        if (!Number.isFinite(val) || val <= 0) {
          setCalError(`${key} at ${row.psi} PSI must be a positive number.`);
          return;
        }
      }
    }

    setCalSaving(true);
    try {
      const response = await apiFetch(`${SPRAYERS_URL}/${calSprayerId}/calibration`, {
        method: "PUT",
        body: JSON.stringify({ notes: calForm.notes.trim() || null, rows })
      });
      if (!response.ok) {
        let message = "Failed to save calibration";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* use fallback */ }
        throw new Error(message);
      }
      const saved = (await response.json()) as CalibrationRecord[];
      setCalibrations((prev) => [
        ...prev.filter((c) => c.sprayer_id !== calSprayerId),
        ...saved
      ]);
      closeCalModal();
    } catch (submitError) {
      setCalError(submitError instanceof Error ? submitError.message : "Failed to save calibration");
    } finally {
      setCalSaving(false);
    }
  }

  function sprayerTankLabel(sprayer: Sprayer): string {
    if (sprayer.has_tank) {
      return sprayer.tank_volume_liters != null ? `Built-in (${sprayer.tank_volume_liters} L)` : "Built-in (—)";
    }
    if (sprayer.tank) {
      return `${sprayer.tank.name} (${sprayer.tank.volume_liters} L)`;
    }
    return "—";
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Setup</h1>
        <p>Configure sprayers and tanks for your organization.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      {/* ── Sprayers ──────────────────────────────────────────────────────── */}
      <div className="coming-soon-card">
        <h2>Sprayers</h2>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddSprayerModal}>
            + Add Sprayer
          </button>
        </div>

        {loading ? <p>Loading...</p> : null}
        {!loading && sprayers.length === 0 ? <p>No sprayers added yet.</p> : null}

        {sprayers.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Nozzles</th>
                  <th>Volume (L/min)</th>
                  <th>PSI</th>
                  <th>Speed range (m/min)</th>
                  <th>Tank</th>
                  <th>Calibration</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sprayers.map((sprayer) => (
                  <tr key={sprayer.id}>
                    <td>{sprayer.name}</td>
                    <td>{sprayer.nozzle_count}</td>
                    <td>{sprayer.nozzle_volume_l_per_min}</td>
                    <td>{sprayer.nozzle_psi}</td>
                    <td>
                      {sprayer.min_speed_m_per_min != null && sprayer.max_speed_m_per_min != null
                        ? `${sprayer.min_speed_m_per_min}–${sprayer.max_speed_m_per_min}${sprayer.speed_step_m_per_min != null ? ` (step ${sprayer.speed_step_m_per_min})` : ""}`
                        : sprayer.speed_m_per_min != null
                          ? `${sprayer.speed_m_per_min} (legacy)`
                          : "—"}
                    </td>
                    <td>{sprayerTankLabel(sprayer)}</td>
                    <td>
                      {calibrations.filter((c) => c.sprayer_id === sprayer.id).length >= 4 ? (
                        <span style={{ color: "var(--success, #0f7660)", fontSize: "0.82em" }}>
                          Calibrated
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                          Not calibrated
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => openCalModal(sprayer.id)}>
                          Calibrate
                        </button>
                        <button type="button" onClick={() => beginEditSprayer(sprayer)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteSprayer(sprayer.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Tanks ─────────────────────────────────────────────────────────── */}
      <div className="coming-soon-card" style={{ marginTop: "1rem" }}>
        <h2>Tanks</h2>
        <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.2rem" }}>
          Standalone tanks that can be linked to sprayers without a built-in tank.
        </p>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddTankModal}>
            + Add Tank
          </button>
        </div>

        {!loading && tanks.length === 0 ? <p>No tanks added yet.</p> : null}

        {tanks.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Volume (L)</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tanks.map((tank) => (
                  <tr key={tank.id}>
                    <td>{tank.name}</td>
                    <td>{tank.volume_liters}</td>
                    <td>{tank.active ? "Yes" : "No"}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEditTank(tank)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteTank(tank.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Bogaerts Robots ───────────────────────────────────────────────── */}
      <div className="coming-soon-card" style={{ marginTop: "1rem" }}>
        <h2>Bogaerts Robots</h2>
        <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.2rem" }}>
          Registered Qii-Jet robots and their nominal onboard tank capacity (~300 L).
        </p>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddRobotModal}>
            + Add Robot
          </button>
        </div>

        {!loading && bogaertsRobots.length === 0 ? <p>No Bogaerts robots added yet.</p> : null}

        {bogaertsRobots.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Tank volume (L)</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bogaertsRobots.map((robot) => (
                  <tr key={robot.id}>
                    <td>{robot.name}</td>
                    <td>{robot.tank_volume_liters}</td>
                    <td>{robot.active ? "Yes" : "No"}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEditRobot(robot)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteRobot(robot.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Bogaerts Nozzle Types ─────────────────────────────────────────── */}
      <div className="coming-soon-card" style={{ marginTop: "1rem" }}>
        <h2>Bogaerts Nozzle Types</h2>
        <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.2rem" }}>
          Nozzle types available for the Qii-Jet planner (e.g. Yellow 020 / 110020, Green 015 /
          110015, Orange 010 / 110010). Flow calibration is not tracked yet.
        </p>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddNozzleTypeModal}>
            + Add Nozzle Type
          </button>
        </div>

        {!loading && bogaertsNozzleTypes.length === 0 ? <p>No nozzle types added yet.</p> : null}

        {bogaertsNozzleTypes.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Color</th>
                  <th>Spray tip code</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bogaertsNozzleTypes.map((nozzleType) => (
                  <tr key={nozzleType.id}>
                    <td>{nozzleType.name}</td>
                    <td>{nozzleType.color ?? "—"}</td>
                    <td>{nozzleType.spray_tip_code ?? "—"}</td>
                    <td>{nozzleType.active ? "Yes" : "No"}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEditNozzleType(nozzleType)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteNozzleType(nozzleType.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Sprayer modal ──────────────────────────────────────────────────── */}
      {isSprayerModalOpen ? (
        <ModalOverlay onClose={closeSprayerModal} contentClassName="variety-modal" titleId="pest-sprayer-modal-title">
            <h2 id="pest-sprayer-modal-title">{editingSprayerId ? "Edit Sprayer" : "Add Sprayer"}</h2>

            <form className="varieties-form" onSubmit={(e) => void handleSprayerSubmit(e)}>
              <label>
                Name
                <input
                  type="text"
                  value={sprayerForm.name}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>

              <label>
                Nozzle count
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={sprayerForm.nozzle_count}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, nozzle_count: e.target.value }))}
                  required
                />
              </label>

              <label>
                Nozzle volume (L/min)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={sprayerForm.nozzle_volume_l_per_min}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, nozzle_volume_l_per_min: e.target.value }))}
                  required
                />
              </label>

              <label>
                Nozzle PSI
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={sprayerForm.nozzle_psi}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, nozzle_psi: e.target.value }))}
                  required
                />
              </label>

              <label>
                Min speed (m/min)
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="e.g. 20"
                  value={sprayerForm.min_speed_m_per_min}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, min_speed_m_per_min: e.target.value }))}
                />
              </label>

              <label>
                Max speed (m/min)
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="e.g. 80"
                  value={sprayerForm.max_speed_m_per_min}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, max_speed_m_per_min: e.target.value }))}
                />
              </label>

              <label>
                Speed step (m/min, optional)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  placeholder="e.g. 5"
                  value={sprayerForm.speed_step_m_per_min}
                  onChange={(e) => setSprayerForm((f) => ({ ...f, speed_step_m_per_min: e.target.value }))}
                />
              </label>

              <label
                style={{
                  gridColumn: "1 / -1",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "0.5rem",
                  display: "flex",
                  fontWeight: 500
                }}
              >
                <input
                  type="checkbox"
                  checked={sprayerForm.has_tank}
                  onChange={(e) =>
                    setSprayerForm((f) => ({ ...f, has_tank: e.target.checked, tank_id: "" }))
                  }
                />
                This sprayer has a built-in tank
              </label>

              {sprayerForm.has_tank ? (
                <label>
                  Built-in tank volume (L)
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    placeholder="e.g. 200"
                    value={sprayerForm.tank_volume_liters}
                    onChange={(e) => setSprayerForm((f) => ({ ...f, tank_volume_liters: e.target.value }))}
                  />
                </label>
              ) : (
                <label>
                  Separate tank (optional)
                  <select
                    value={sprayerForm.tank_id}
                    onChange={(e) => setSprayerForm((f) => ({ ...f, tank_id: e.target.value }))}
                  >
                    <option value="">No tank</option>
                    {tanks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.volume_liters} L)
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {sprayerError ? <p className="form-error" style={{ gridColumn: "1 / -1" }}>{sprayerError}</p> : null}

              <div className="form-actions" style={{ gridColumn: "1 / -1" }}>
                <button type="submit" disabled={sprayerSaving}>
                  {sprayerSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeSprayerModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {/* ── Calibration modal ─────────────────────────────────────────────── */}
      {isCalModalOpen && calSprayerId ? (
        <ModalOverlay onClose={closeCalModal} contentClassName="variety-modal cal-modal" titleId="pest-cal-modal-title">
            <h2 id="pest-cal-modal-title">Calibrate Sprayer</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", margin: "0.3rem 0 1.1rem" }}>
              Run the sprayer and measure output from the same 3 nozzles at each pressure.
              Enter the collected volume (mL/min) for each nozzle.
            </p>

            <form onSubmit={(e) => void handleCalSubmit(e)}>
              {CALIBRATION_PSI_POINTS.map((psi) => (
                <div key={psi} className="cal-psi-section">
                  <div className="cal-psi-header">
                    <strong>{psi} PSI</strong>
                    <span className="cal-psi-unit">mL/min per nozzle</span>
                  </div>
                  <div className="cal-nozzle-grid">
                    {([1, 2, 3] as const).map((n) => {
                      const fieldKey = `nozzle_${n}` as keyof CalibrationFormPsiRow;
                      return (
                        <label key={n}>
                          Nozzle {n}
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            placeholder="0.00"
                            value={calForm.readings[psi][fieldKey]}
                            onChange={(e) =>
                              setCalForm((f) => ({
                                ...f,
                                readings: {
                                  ...f.readings,
                                  [psi]: { ...f.readings[psi], [fieldKey]: e.target.value }
                                }
                              }))
                            }
                            required
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}

              <label className="cal-notes">
                Notes (optional)
                <textarea
                  value={calForm.notes}
                  onChange={(e) => setCalForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  style={{ resize: "vertical", width: "100%", boxSizing: "border-box" }}
                />
              </label>

              {calError ? (
                <p className="form-error" style={{ marginTop: "0.5rem" }}>{calError}</p>
              ) : null}

              <div className="form-actions" style={{ marginTop: "1.1rem" }}>
                <button type="submit" disabled={calSaving}>
                  {calSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeCalModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {/* ── Tank modal ─────────────────────────────────────────────────────── */}
      {isTankModalOpen ? (
        <ModalOverlay onClose={closeTankModal} contentClassName="variety-modal" titleId="pest-tank-modal-title">
            <h2 id="pest-tank-modal-title">{editingTankId ? "Edit Tank" : "Add Tank"}</h2>

            <form className="varieties-form" onSubmit={(e) => void handleTankSubmit(e)}>
              <label>
                Name
                <input
                  type="text"
                  value={tankForm.name}
                  onChange={(e) => setTankForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>

              <label>
                Volume (L)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  placeholder="e.g. 200"
                  value={tankForm.volume_liters}
                  onChange={(e) => setTankForm((f) => ({ ...f, volume_liters: e.target.value }))}
                  required
                />
              </label>

              <label
                style={{
                  gridColumn: "1 / -1",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "0.5rem",
                  display: "flex",
                  fontWeight: 500
                }}
              >
                <input
                  type="checkbox"
                  checked={tankForm.active}
                  onChange={(e) => setTankForm((f) => ({ ...f, active: e.target.checked }))}
                />
                Active
              </label>

              {tankError ? <p className="form-error" style={{ gridColumn: "1 / -1" }}>{tankError}</p> : null}

              <div className="form-actions" style={{ gridColumn: "1 / -1" }}>
                <button type="submit" disabled={tankSaving}>
                  {tankSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeTankModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {/* ── Bogaerts robot modal ───────────────────────────────────────────── */}
      {isRobotModalOpen ? (
        <ModalOverlay onClose={closeRobotModal} contentClassName="variety-modal" titleId="pest-robot-modal-title">
            <h2 id="pest-robot-modal-title">{editingRobotId ? "Edit Robot" : "Add Robot"}</h2>

            <form className="varieties-form" onSubmit={(e) => void handleRobotSubmit(e)}>
              <label>
                Name
                <input
                  type="text"
                  placeholder="e.g. Robot A"
                  value={robotForm.name}
                  onChange={(e) => setRobotForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>

              <label>
                Tank volume (L)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  placeholder="e.g. 300"
                  value={robotForm.tank_volume_liters}
                  onChange={(e) => setRobotForm((f) => ({ ...f, tank_volume_liters: e.target.value }))}
                  required
                />
              </label>

              <label
                style={{
                  gridColumn: "1 / -1",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "0.5rem",
                  display: "flex",
                  fontWeight: 500
                }}
              >
                <input
                  type="checkbox"
                  checked={robotForm.active}
                  onChange={(e) => setRobotForm((f) => ({ ...f, active: e.target.checked }))}
                />
                Active
              </label>

              {robotError ? <p className="form-error" style={{ gridColumn: "1 / -1" }}>{robotError}</p> : null}

              <div className="form-actions" style={{ gridColumn: "1 / -1" }}>
                <button type="submit" disabled={robotSaving}>
                  {robotSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeRobotModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {/* ── Bogaerts nozzle type modal ─────────────────────────────────────── */}
      {isNozzleTypeModalOpen ? (
        <ModalOverlay onClose={closeNozzleTypeModal} contentClassName="variety-modal" titleId="pest-nozzle-type-modal-title">
            <h2 id="pest-nozzle-type-modal-title">{editingNozzleTypeId ? "Edit Nozzle Type" : "Add Nozzle Type"}</h2>

            <form className="varieties-form" onSubmit={(e) => void handleNozzleTypeSubmit(e)}>
              <label>
                Name
                <input
                  type="text"
                  placeholder="e.g. Yellow 020"
                  value={nozzleTypeForm.name}
                  onChange={(e) => setNozzleTypeForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>

              <label>
                Color (optional)
                <input
                  type="text"
                  placeholder="e.g. Yellow"
                  value={nozzleTypeForm.color}
                  onChange={(e) => setNozzleTypeForm((f) => ({ ...f, color: e.target.value }))}
                />
              </label>

              <label>
                Spray tip code (optional)
                <input
                  type="text"
                  placeholder="e.g. 110020"
                  value={nozzleTypeForm.spray_tip_code}
                  onChange={(e) => setNozzleTypeForm((f) => ({ ...f, spray_tip_code: e.target.value }))}
                />
              </label>

              <label
                style={{
                  gridColumn: "1 / -1",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "0.5rem",
                  display: "flex",
                  fontWeight: 500
                }}
              >
                <input
                  type="checkbox"
                  checked={nozzleTypeForm.active}
                  onChange={(e) => setNozzleTypeForm((f) => ({ ...f, active: e.target.checked }))}
                />
                Active
              </label>

              {nozzleTypeError ? <p className="form-error" style={{ gridColumn: "1 / -1" }}>{nozzleTypeError}</p> : null}

              <div className="form-actions" style={{ gridColumn: "1 / -1" }}>
                <button type="submit" disabled={nozzleTypeSaving}>
                  {nozzleTypeSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeNozzleTypeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
