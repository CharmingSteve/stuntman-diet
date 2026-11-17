import { withDefaultBurn, type Day } from "./ledger.js";

// One-time repair for day records written before stored burn defaults and the importer fix.
// Tracked days with no burn get the assumed default. A stored "partial" on a past day came from the importer,
// not the owner, so it returns to automatic (which completes past days that have entries).
// Today's record is left alone: it may be a deliberate mid-day stop.
export function repairStoredDay(data: Day, today: string): Day {
  const repaired = withDefaultBurn(data);
  if (repaired.completeness === "partial" && repaired.day_key < today) return { ...repaired, completeness: "missing" };
  return repaired;
}
