// QR scan (jsQR — pure-JS decode from canvas ImageData, works in Safari/iOS
// where the native BarcodeDetector API is unavailable) and QR generation
// (qrcode — renders the equipment's own qr_token to a canvas for on-screen
// display + PNG download). Both are small, single-purpose libraries chosen
// specifically because neither depends on a native browser API, so the
// same code path works across iOS Safari and Android Chrome.
//
// Both are dynamically imported (not top-level) so they land in their own
// chunk instead of the main bundle — they're only needed inside the
// Maintenance QR flows, not on every page load, and keeping them out of the
// main chunk is what keeps it under the PWA precache size limit.

import type jsQRType from "jsqr";

type JsQR = typeof jsQRType;

let jsQRFn: JsQR | null = null;

export async function preloadQrDecoder(): Promise<void> {
  if (!jsQRFn) {
    jsQRFn = (await import("jsqr")).default;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeEquipmentQrToken(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

// Decodes a single video frame. Returns null if no QR code is found in
// this frame, or if the decoder hasn't finished loading yet (the caller
// awaits preloadQrDecoder() before starting its scan loop, so this is only
// ever a transient state). Called on every animation frame while the
// scanner sheet is open.
export function decodeQrFrame(canvas: HTMLCanvasElement, video: HTMLVideoElement): string | null {
  if (!jsQRFn) return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || video.videoWidth === 0 || video.videoHeight === 0) return null;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQRFn(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
  return result?.data?.trim() || null;
}

export async function renderEquipmentQrCode(canvas: HTMLCanvasElement, token: string): Promise<void> {
  const QRCode = (await import("qrcode")).default;
  await QRCode.toCanvas(canvas, token, { width: 240, margin: 2, color: { dark: "#1f2a2e", light: "#ffffff" } });
}
