// Generic, reusable manual-validation helpers shared across the Maintenance
// route files (no schema-validation library anywhere in this codebase —
// see irrigationSetup.ts / pestCalibration/devices.ts for the established
// pattern this mirrors). Resource-specific payload validators live in each
// resource's own route file, matching the rest of the codebase.

export class MaintenanceValidationError extends Error {}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_STRING_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseRequiredString(value: unknown, fieldLabel: string): string {
  const str = typeof value === "string" ? value.trim() : "";
  if (!str) throw new MaintenanceValidationError(`${fieldLabel} is required.`);
  return str;
}

export function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

export function parseUuid(value: unknown, fieldLabel: string): string {
  const str = typeof value === "string" ? value : "";
  if (!UUID_PATTERN.test(str)) throw new MaintenanceValidationError(`A valid ${fieldLabel} is required.`);
  return str;
}

export function parseOptionalUuid(value: unknown, fieldLabel: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parseUuid(value, fieldLabel);
}

export function parseRequiredIdempotencyKey(value: unknown, fieldLabel = "request_id"): string {
  return parseUuid(value, fieldLabel);
}

export function parseDateStringField(value: unknown, fieldLabel: string): string {
  const str = typeof value === "string" ? value.trim() : "";
  if (!DATE_STRING_PATTERN.test(str)) throw new MaintenanceValidationError(`A valid ${fieldLabel} (YYYY-MM-DD) is required.`);
  return str;
}

export function parseNonNegativeNumber(value: unknown, fieldLabel: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) throw new MaintenanceValidationError(`${fieldLabel} must be zero or greater.`);
  return num;
}

export function parsePositiveNumber(value: unknown, fieldLabel: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new MaintenanceValidationError(`${fieldLabel} must be greater than zero.`);
  return num;
}

export function parseOptionalNonNegativeNumber(value: unknown, fieldLabel: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return parseNonNegativeNumber(value, fieldLabel);
}

export function parseOptionalBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fieldLabel: string): T {
  const str = typeof value === "string" ? value : "";
  if (!allowed.includes(str as T)) {
    throw new MaintenanceValidationError(`${fieldLabel} must be one of: ${allowed.join(", ")}.`);
  }
  return str as T;
}

export function parseIntegerQuantity(value: unknown, fieldLabel: string): number {
  const num = parseNonNegativeNumber(value, fieldLabel);
  if (!Number.isInteger(num)) throw new MaintenanceValidationError(`${fieldLabel} must be a whole number for this unit.`);
  return num;
}
