// Shared request-body parsing helpers for the Food Safety route files.
// Mirrors the validation style already used in server/src/routes/irrigationSetup.ts
// (throw a plain Error with a client-safe message; callers catch it and
// respond 400 with error.message).

export function parseRequiredName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }
  return name;
}

export function parseOptionalText(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseActive(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new Error("active must be a boolean");
  }
  return value;
}

export function parseSortOrder(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("sort_order must be an integer");
  }
  return parsed;
}

export function parseOrderedIds(input: unknown): string[] {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const orderedIds = body.orderedIds;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new Error("orderedIds must be a non-empty array");
  }

  return orderedIds.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("orderedIds must contain non-empty strings");
    }
    return id;
  });
}
