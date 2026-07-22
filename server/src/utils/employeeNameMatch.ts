// Matches a freeform name extracted from a PDF (e.g. "Ramos, Ricardo, Melo")
// against GrowLink's quality_employees list. Report names aren't consistently
// formatted ("Last, First, Middle" vs "Last1 Last2, First"), so matching is
// done on a normalized, order-independent set of name tokens rather than
// trying to parse first/last name positions.

export type EmployeeMatchCandidate = { id: string; name: string };

export type EmployeeMatchResult = {
  status: "matched" | "ambiguous" | "unmatched";
  employeeId: string | null;
  // Closest candidates by token overlap, for the reviewer to pick from when
  // status isn't a confident single match. Empty for a clean "matched".
  suggestions: EmployeeMatchCandidate[];
};

function normalizeTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function tokenSetKey(tokens: string[]): string {
  return tokens.join(" ");
}

function jaccardScore(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function matchEmployeeName(
  rawName: string,
  employees: EmployeeMatchCandidate[]
): EmployeeMatchResult {
  const targetTokens = normalizeTokens(rawName);
  const targetKey = tokenSetKey(targetTokens);

  const exact = employees.filter((e) => tokenSetKey(normalizeTokens(e.name)) === targetKey);
  if (exact.length === 1) {
    return { status: "matched", employeeId: exact[0].id, suggestions: [] };
  }
  if (exact.length > 1) {
    // Same normalized name shared by more than one employee record — can't
    // safely auto-pick, surface all of them for the reviewer to choose from.
    return { status: "ambiguous", employeeId: null, suggestions: exact };
  }

  const suggestions = employees
    .map((e) => ({ candidate: e, score: jaccardScore(targetTokens, normalizeTokens(e.name)) }))
    .filter((s) => s.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.candidate);

  return { status: "unmatched", employeeId: null, suggestions };
}
