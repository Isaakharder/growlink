import crypto from "crypto";

const FILENAME_TIMESTAMP_RE = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;

// Ridder exports carry no per-row timestamp; the filename is the only
// source of export time. Tolerates trailing suffixes like "(in)".
// Assumes the embedded time is UTC -- confirm actual site timezone
// handling before relying on this for real imports.
export function parseExportTimestampFromFilename(filename: string): Date | null {
  const match = filename.match(FILENAME_TIMESTAMP_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  );
}

export function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
