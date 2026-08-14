// Applies saved per-organization FlowMaster size resolution rules
// (flowmaster_size_rules) to a parsed file's raw sizeKg/unknownSizes
// before the normal active-yield_sizes canonicalization check runs.
//
// This is a pure transform: given a rule for a label, it folds that
// label's kg into whichever real yield_sizes name(s) the rule points at
// (or drops it, for 'ignore') and removes the label from sizeKg entirely,
// so the caller's existing name-based classification loop naturally
// treats it exactly like any other already-known size — no special casing
// needed downstream.

export type SizeRuleAction = "create" | "map" | "ignore" | "distribute";

export type SizeRuleRecord = {
  id: string;
  rawLabel: string;
  action: SizeRuleAction;
  targetSizeId: string | null;
  distributeSizeIds: string[];
};

export type ApplySizeRulesResult = {
  sizeKg: Record<string, number>;
  // Labels that still have no rule, or whose rule points at a size that no
  // longer exists/is inactive — these remain "unknown" and must still be
  // resolved before import.
  unknownSizes: string[];
  // Informational, non-blocking notes describing what a rule did (ignored /
  // distributed kg, or a broken rule that needs reconfiguring).
  notes: string[];
};

export function normalizeSizeRuleLabel(value: string): string {
  return value.trim().toLowerCase();
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function applySizeRules(
  sizeKg: Record<string, number>,
  unknownSizes: string[],
  rulesByNormalizedLabel: Map<string, SizeRuleRecord>,
  activeSizeNameById: Map<string, string>
): ApplySizeRulesResult {
  const nextSizeKg: Record<string, number> = { ...sizeKg };
  const remainingUnknown: string[] = [];
  const notes: string[] = [];
  const distributeQueue: Array<{ label: string; rule: SizeRuleRecord }> = [];

  // Pass 1: ignore / create / map. These resolve immediately so their
  // target sizes' kg is in its final state before any 'distribute' rule
  // (processed in pass 2) computes its destination ratios.
  for (const label of unknownSizes) {
    const rule = rulesByNormalizedLabel.get(normalizeSizeRuleLabel(label));

    if (!rule) {
      remainingUnknown.push(label);
      continue;
    }

    if (rule.action === "distribute") {
      distributeQueue.push({ label, rule });
      continue;
    }

    const kg = nextSizeKg[label] ?? 0;

    if (rule.action === "ignore") {
      delete nextSizeKg[label];
      notes.push(
        `"${label}" ignored per saved size rule (${roundTo2(kg)} kg excluded from totals).`
      );
      continue;
    }

    // create | map — both just fold the label's kg into an existing
    // (possibly just-created) yield_sizes row.
    const targetName = rule.targetSizeId ? activeSizeNameById.get(rule.targetSizeId) : undefined;

    if (!targetName) {
      remainingUnknown.push(label);
      notes.push(
        `Saved size rule for "${label}" points to a size that no longer exists. Please reconfigure it.`
      );
      continue;
    }

    delete nextSizeKg[label];
    nextSizeKg[targetName] = (nextSizeKg[targetName] ?? 0) + kg;
  }

  // Pass 2: distribute. Ratios are computed from each destination size's
  // kg already present in THIS file's sizeKg (after pass 1's folding),
  // not aggregated across other files/lots.
  for (const { label, rule } of distributeQueue) {
    const kg = nextSizeKg[label] ?? 0;
    const destNames = rule.distributeSizeIds
      .map((id) => activeSizeNameById.get(id))
      .filter((name): name is string => Boolean(name));

    if (destNames.length === 0) {
      remainingUnknown.push(label);
      notes.push(
        `Saved distribution rule for "${label}" has no valid destination sizes configured. Please reconfigure it.`
      );
      continue;
    }

    delete nextSizeKg[label];

    if (kg <= 0) {
      continue;
    }

    const destKgBefore = destNames.map((name) => nextSizeKg[name] ?? 0);
    const totalDestKg = destKgBefore.reduce((sum, value) => sum + value, 0);

    const shares =
      totalDestKg > 0
        ? destKgBefore.map((value) => value / totalDestKg)
        : destNames.map(() => 1 / destNames.length);

    // Round each share to 2dp, then push whatever rounding residual is
    // left onto the last destination so the distributed total exactly
    // equals the original label's kg — never inflates or shrinks totals.
    const additions = shares.map((share) => roundTo2(kg * share));
    const roundedSum = additions.reduce((sum, value) => sum + value, 0);
    const residual = roundTo2(kg - roundedSum);
    additions[additions.length - 1] = roundTo2(additions[additions.length - 1] + residual);

    destNames.forEach((name, index) => {
      nextSizeKg[name] = roundTo2((nextSizeKg[name] ?? 0) + additions[index]);
    });

    notes.push(
      `"${label}" (${roundTo2(kg)} kg) distributed proportionally across ${destNames.join(", ")} per saved size rule.`
    );
  }

  return { sizeKg: nextSizeKg, unknownSizes: remainingUnknown, notes };
}
