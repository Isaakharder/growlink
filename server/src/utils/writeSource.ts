// yield_entries.last_write_source arrives with migration 0141. Until that
// migration is applied in an environment, writing the column would make every
// yield-entry insert/update fail, so it is only written once
// YIELD_WRITE_SOURCE_TRACKING=enabled is set (after the migration).
export type WriteSource = "manual_create" | "manual_merge" | "manual_edit" | "import_pdf" | "import_csv";

export function writeSourceColumn(source: WriteSource, env: NodeJS.ProcessEnv = process.env): { last_write_source?: WriteSource } {
  return env.YIELD_WRITE_SOURCE_TRACKING === "enabled" ? { last_write_source: source } : {};
}
