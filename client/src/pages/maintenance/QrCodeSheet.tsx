import { useEffect, useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { renderEquipmentQrCode } from "./qrCodec";
import { EquipmentRow } from "./types";

type Props = {
  equipment: EquipmentRow;
  onClose: () => void;
};

export function QrCodeSheet({ equipment, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderEquipmentQrCode(canvas, equipment.qr_token).catch(() => setError("Couldn't render the QR code."));
  }, [equipment.qr_token]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${equipment.asset_code || "equipment"}-qr.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="qr-code-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="qr-code-title">Equipment QR Code</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body maintenance-qr-code-body">
        <p className="maintenance-qr-code-name">{equipment.name}</p>
        <p className="maintenance-qr-code-asset">{equipment.asset_code}</p>

        {error ? <p className="form-error">{error}</p> : null}
        <canvas ref={canvasRef} className="maintenance-qr-code-canvas" />

        <button type="button" onClick={download}>
          Download QR Code
        </button>
      </div>
    </ModalOverlay>
  );
}
