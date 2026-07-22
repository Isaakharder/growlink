import { Response } from "express";

type DbErrorLike = {
  code?: string;
  message?: string;
};

// Turns a raw Postgres/PostgREST error into a short, still-safe diagnostic
// string (schema-cache / validation / permission / other-database-failure),
// without leaking stack traces, connection details, or unrelated internals.
function classifyDbError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  const err = error as DbErrorLike;
  const message = typeof err.message === "string" ? err.message : "";
  const code = typeof err.code === "string" ? err.code : undefined;

  // PostgREST's classic "schema cache is stale" symptom after a migration —
  // e.g. a column/table/function that exists in Postgres but PostgREST
  // hasn't picked up yet.
  if (/schema cache/i.test(message)) {
    return `Schema cache is stale${code ? ` (${code})` : ""} — this usually resolves on its own within a few seconds of a migration; try again.`;
  }

  switch (code) {
    case "23505":
      return "Duplicate value — a record with this value already exists (unique constraint).";
    case "23502":
      return "A required field was missing (not-null constraint).";
    case "23503":
      return "References a record that no longer exists (foreign key constraint).";
    case "42501":
      return "Permission denied by the database (RLS policy, privilege, or immutability check).";
    case "PGRST301":
    case "PGRST302":
      return "Authentication/session error at the database API layer.";
  }

  if (code) return `Database error (code ${code}).`;
  if (message) return `Database error: ${message}`;
  return null;
}

export function sendSafeError(
  res: Response,
  status: number,
  clientMessage: string,
  logContext: string,
  error: unknown
): Response {
  console.error(logContext, error);

  // Outside production, append a classified (still-safe) detail to the
  // client message so a failure is diagnosable from the UI alone — no need
  // to go find the server console. Production keeps the plain clientMessage,
  // consistent with never exposing internals to real end users.
  const isProduction = process.env.NODE_ENV === "production";
  const detail = isProduction ? null : classifyDbError(error);
  const message = detail ? `${clientMessage} ${detail}` : clientMessage;

  return res.status(status).json({ message });
}
