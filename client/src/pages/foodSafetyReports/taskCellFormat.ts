// Shared by the on-screen Food Safety report table and the printed report so
// the two can never format the same saved answer differently. The server
// (see server/src/utils/foodSafetyReportCard.ts's formatTaskCellValue) is the
// single source of truth for turning a stored response into display text --
// this file only resolves "what do we show for a column this report has no
// entry for" (a task that didn't exist yet when the report was completed),
// which both renderers must treat identically: blank, same as an explicit
// empty/unchecked answer.
export type TaskCellValue = {
  display: string;
  isCheckmark: boolean;
};

export function resolveTaskCell(taskValues: Record<string, TaskCellValue>, columnKey: string): TaskCellValue {
  return taskValues[columnKey] ?? { display: "", isCheckmark: false };
}
