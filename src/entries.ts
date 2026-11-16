import type { Store, StoreWrite } from "./store.js";
import { dayState, entrySchema, InputError, NotFoundError, profile, userPK, voidedEntry, write } from "./ledger.js";

export type RemovedEntry = { id: string; day_key: string; display_name: string; calories: number };

// Removes one active entry from a day by voiding it. Removing an entry that is already removed succeeds
// without writing again, so a repeated tap is harmless. A day the user confirmed complete reopens to
// automatic, because its total has changed.
export async function removeEntry(store: Store, user: string, day: string, entryId: string): Promise<{ writes: StoreWrite[]; result: Record<string, unknown> }> {
  const row = await store.get(userPK(user), `DAY#${day}#ENTRY#${entryId}`);
  if (!row) throw new NotFoundError("No entry with that id on this day");
  const entry = entrySchema.parse(row.data);
  const removed: RemovedEntry = { id: entry.id, day_key: day, display_name: entry.display_name, calories: Math.round(entry.calories) };
  if (entry.status === "void") return { writes: [], result: { removed, already_removed: true } };
  if (entry.status !== "active") throw new InputError("This entry was replaced by a correction and is no longer active");
  const writes: StoreWrite[] = [voidedEntry(row)];
  const p = await profile(store, user);
  const state = await dayState(store, user, day, p);
  if (state.data.completeness === "complete") {
    state.data.completeness = "missing";
    writes.push(write(userPK(user), `DAY#${day}#META`, "day", state.data, state.old));
  }
  return { writes, result: { removed, already_removed: false } };
}
