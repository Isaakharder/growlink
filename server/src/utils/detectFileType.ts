// Content-based file-type detection — never trust a filename extension or
// browser-supplied MIME type alone (both are trivially wrong/spoofable).
// Shared by agentRoutes.ts (unattended Agent uploads) and pdfImport.ts
// (manual Kg Entries uploads) so both routing decisions are made the same
// way.

/** True content check via a %PDF- magic-byte probe near the start of the file. */
export function isPdfBuffer(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, 1024);
  return buffer.subarray(0, probeLength).toString("latin1").includes("%PDF-");
}
