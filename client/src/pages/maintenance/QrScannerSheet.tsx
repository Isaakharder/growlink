import { useEffect, useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { listEquipment, lookupEquipmentByQrToken, MaintenanceApiError } from "./api";
import { decodeQrFrame, looksLikeEquipmentQrToken, preloadQrDecoder } from "./qrCodec";
import { EquipmentRow } from "./types";

type CameraState = "requesting" | "streaming" | "denied" | "unsupported" | "error";

type Props = {
  onClose: () => void;
  onMatch: (equipment: EquipmentRow) => void;
};

// Camera permission is only requested once this sheet mounts (i.e. only
// when the user taps "Scan"), never eagerly on the Equipment tab. The
// camera stream is torn down on every exit path: successful match, sheet
// close, or unmount from navigation — see the effect cleanup below.
export function QrScannerSheet({ onClose, onMatch }: Props) {
  const [mode, setMode] = useState<"camera" | "manual">("camera");
  const [cameraState, setCameraState] = useState<CameraState>("requesting");
  const [scanAttempt, setScanAttempt] = useState(0);
  const [manualCode, setManualCode] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [manualResults, setManualResults] = useState<EquipmentRow[] | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(true);

  function stopCamera() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    if (mode !== "camera") return;
    activeRef.current = true;
    setCameraState("requesting");
    setLookupError(null);

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("unsupported");
        return;
      }
      try {
        const [stream] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }),
          preloadQrDecoder()
        ]);
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        setCameraState("streaming");
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setCameraState(err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "error");
      }
    }

    function tick() {
      if (!activeRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const code = decodeQrFrame(canvas, video);
        if (code) {
          activeRef.current = false;
          stopCamera();
          void handleScanned(code);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    void start();

    return () => {
      activeRef.current = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scanAttempt]);

  async function handleScanned(code: string) {
    setLookupError(null);
    if (!looksLikeEquipmentQrToken(code)) {
      setLookupError("That QR code isn't a GrowLink equipment code.");
      return;
    }
    setLooking(true);
    try {
      const equipment = await lookupEquipmentByQrToken(code);
      onMatch(equipment);
    } catch (err) {
      setLookupError(
        err instanceof MaintenanceApiError && err.status === 404
          ? "No equipment found for this code."
          : err instanceof Error
            ? err.message
            : "Lookup failed. Try again."
      );
    } finally {
      setLooking(false);
    }
  }

  function scanAgain() {
    setLookupError(null);
    setScanAttempt((n) => n + 1);
  }

  // Manual entry searches by asset code / name (what's actually printed on
  // the equipment) rather than the opaque qr_token — a user typing a code
  // by hand knows the asset code, not the QR token's UUID. If the entered
  // text does happen to look like a QR token (e.g. pasted from elsewhere),
  // try the exact token lookup first.
  async function submitManual(event: React.FormEvent) {
    event.preventDefault();
    const code = manualCode.trim();
    if (!code) {
      setLookupError("Enter an asset code to search.");
      return;
    }
    setLookupError(null);
    setManualResults(null);
    setLooking(true);
    try {
      if (looksLikeEquipmentQrToken(code)) {
        try {
          const equipment = await lookupEquipmentByQrToken(code);
          onMatch(equipment);
          return;
        } catch (err) {
          if (!(err instanceof MaintenanceApiError && err.status === 404)) throw err;
        }
      }

      const results = await listEquipment({ search: code });
      if (results.length === 0) {
        setLookupError("No equipment found for this code.");
      } else if (results.length === 1) {
        onMatch(results[0]);
      } else {
        setManualResults(results);
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Search failed. Try again.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="qr-scanner-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="qr-scanner-title">Scan Equipment QR</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        {mode === "camera" ? (
          <div className="maintenance-qr-scan-area">
            <video ref={videoRef} className="maintenance-qr-video" playsInline muted style={{ display: cameraState === "streaming" ? "block" : "none" }} />
            <canvas ref={canvasRef} style={{ display: "none" }} />

            {cameraState === "requesting" ? <p>Requesting camera access…</p> : null}
            {cameraState === "streaming" ? <p className="maintenance-qr-hint">Point the camera at the equipment's QR label.</p> : null}

            {cameraState === "denied" ? (
              <div className="maintenance-empty-state">
                <p>Camera access was denied.</p>
                <p>Allow camera access in your browser settings, or enter the code manually below.</p>
              </div>
            ) : null}

            {cameraState === "unsupported" ? (
              <div className="maintenance-empty-state">
                <p>Camera scanning isn't available on this device or browser.</p>
                <p>Enter the code manually below.</p>
              </div>
            ) : null}

            {cameraState === "error" ? (
              <div className="maintenance-empty-state">
                <p>Couldn't start the camera.</p>
                <button type="button" className="btn-secondary" onClick={scanAgain}>
                  Try Again
                </button>
              </div>
            ) : null}

            {looking ? <p>Looking up equipment…</p> : null}
            {lookupError ? (
              <div className="maintenance-form-error-block">
                <p className="form-error">{lookupError}</p>
                <button type="button" className="btn-secondary" onClick={scanAgain}>
                  Scan Again
                </button>
              </div>
            ) : null}

            <button type="button" className="maintenance-link-button" onClick={() => setMode("manual")}>
              Enter code manually instead
            </button>
          </div>
        ) : (
          <form className="maintenance-form" onSubmit={(event) => void submitManual(event)}>
            <label>
              Asset code or equipment name
              <input
                type="text"
                value={manualCode}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => {
                  setManualCode(event.target.value);
                  setManualResults(null);
                }}
                placeholder="e.g. MOWER-001"
              />
            </label>

            {lookupError ? <p className="form-error">{lookupError}</p> : null}

            <button type="submit" disabled={looking}>
              {looking ? "Searching…" : "Find Equipment"}
            </button>

            {manualResults ? (
              <div className="maintenance-qr-results">
                <p>Multiple matches — choose one:</p>
                {manualResults.map((equipment) => (
                  <button type="button" key={equipment.id} className="maintenance-qr-result-row" onClick={() => onMatch(equipment)}>
                    <strong>{equipment.name}</strong>
                    <span>{equipment.asset_code}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <button type="button" className="maintenance-link-button" onClick={() => setMode("camera")}>
              Use camera instead
            </button>
          </form>
        )}
      </div>
    </ModalOverlay>
  );
}
