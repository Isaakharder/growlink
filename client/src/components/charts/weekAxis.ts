/**
 * X-axis tick text for a weekly series: "W18 2026" -> "W18". Only the tick
 * text changes; the point's label (and so the tooltip, sorting and grouping)
 * keeps the year, which is what tells two years' W18 apart. Anything that
 * isn't a "W<week> <year>" label is returned unchanged.
 */
export function formatWeekAxisTick(label: unknown): string {
  const text = String(label ?? "");
  const match = /^W(\d{1,2})\s+\d{4}$/.exec(text.trim());
  return match ? `W${Number(match[1])}` : text;
}
