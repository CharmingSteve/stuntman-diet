import { withDefaultBurn, type Day } from "./ledger.js";

// One-time repair for day records written before stored burn defaults and the importer fix.
// Every tracked day with no burn gets the assumed default. Completeness is changed only for days the operator
// lists explicitly: a stored "partial" cannot be told apart from a deliberate flag by its value alone, so nothing
// is reopened by default. Today's record is never reopened.
export function repairStoredDay(data: Day, today: string, reopenDays: ReadonlySet<string> = new Set()): Day {
  const repaired = withDefaultBurn(data);
  if (repaired.completeness === "partial" && repaired.day_key < today && reopenDays.has(repaired.day_key)) {
    return { ...repaired, completeness: "missing" };
  }
  return repaired;
}
