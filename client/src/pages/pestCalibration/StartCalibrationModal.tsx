import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";
import { CalibrationDevice, DeviceDetail } from "./types";
import { CalibrationForm, CalibrationFormPayload } from "./CalibrationForm";

type CompletionResult = {
  record_id: string;
  next_due_at: string | null;
};

type StartCalibrationModalProps = {
  device: CalibrationDevice;
  onClose: () => void;
  onCompleted: () => void;
};

export function StartCalibrationModal({ device, onClose, onCompleted }: StartCalibrationModalProps) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompletionResult | null>(null);
  // Generated once for this modal's lifetime and resent unchanged on any
  // retry of the same completion attempt — lets the server recognize a
  // network-timeout retry or a double-tap that slips past the disabled
  // submit button as the same attempt, not a duplicate record.
  const [completionRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/start`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "Failed to load calibration form.");
        }
        const data = (await res.json()) as DeviceDetail;
        if (!cancelled) setDetail(data);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Failed to load calibration form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [device.id]);

  async function handleValidSubmit(payload: CalibrationFormPayload) {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ ...payload, completion_request_id: completionRequestId })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save calibration record.");
      }
      const data = (await res.json()) as CompletionResult;
      setResult(data);
      onCompleted();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to save calibration record.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal" titleId="start-calibration-title">
      <h2 id="start-calibration-title">Calibrate — {device.name}</h2>
      <p>{[device.area, device.identification_number].filter(Boolean).join(" · ")}</p>

      {result ? (
        <div>
          <p><strong>Calibration completed.</strong></p>
          {result.next_due_at ? (
            <p>Next due: {new Date(result.next_due_at).toLocaleDateString()}</p>
          ) : (
            <p>This device is calibrated on demand — no next due date.</p>
          )}
          <div className="form-actions">
            <button type="button" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : loading ? (
        <p>Loading...</p>
      ) : loadError ? (
        <p className="form-error">{loadError}</p>
      ) : detail ? (
        <>
          <CalibrationForm detail={detail} onValidSubmit={(payload) => void handleValidSubmit(payload)} submitting={submitting} />
          {submitError ? <p className="form-error">{submitError}</p> : null}
        </>
      ) : null}
    </ModalOverlay>
  );
}
