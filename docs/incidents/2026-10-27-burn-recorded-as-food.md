# Incident: burn recorded as food (2026-10-27)

- **Issue:** [#11 "at the end of oct 27 2026 it recorded burn as food eaten!"](https://github.com/CharmingSteve/stuntman-diet/issues/11)
- **Environment:** production (`stuntman-diet-production`), table `stuntman-diet-production-DietTable-P6OFUEX1VTJ6`
- **User:** `USER#b4f8e488-…` (the owner)
- **Day affected:** `2026-10-27` (Asia/Jerusalem)
- **Times below are Asia/Jerusalem (UTC+2).** Stored `occurred_at` values are UTC.

## Impact

- One food entry, `burned 1430 + 1550 2,980`, counted **2,980 kcal of intake**.
- The day's intake showed **4,773 kcal** instead of **1,793 kcal**. Net was also wrong.
- The day's burn was already correct (2,980 kcal recorded, components 1430 + 1550), so the error was double counting.
- The owner's attempts to delete the 10:44 PM entry did not work. Their exact messages are not stored, and the logs have no error lines for them (see "Unknown").

## Timeline

Source: production DynamoDB records (`DAY#2026-10-27#…`), chat receipts (`REQUEST#…`), and CloudWatch `/aws/lambda/web/stuntman-diet-production` for 18:00–24:00 UTC.

| Time | What happened | Stored result |
| --- | --- | --- |
| 22:42:18 | Message `burned 1430 + 1550`. The model returned one **estimate food item** with 2980 kcal. The app also parsed the burn text (1430 + 1550). | Entry `9b5ea910` "burned 1430 + 1550", 2980 kcal, active. Day burn set to 2980 recorded. |
| 22:44:50 | A correction replaced `9b5ea910` with `burned 1430 + 1550 2,980`. The reply said "Updated burned 1430 + 1550." | Entry `9b5ea910` set to `superseded`. New entry `0b40c534` "burned 1430 + 1550 2,980", 2980 kcal, **active**. |
| 22:45 | Next chat reply showed the bad row in the day table. | Receipt `REQUEST#fbb66847` lists `burned 1430 + 1550 2,980 | 2980`. |
| 22:44 onward | Owner tried to remove the 10:44 PM entry by time. | **No row changed.** No receipt was written for these attempts. |

Other entries for the day were correct. The day record is version 7, `completeness=partial`.

## Root causes

1. **Burn text was recorded as food.** `src/chat.ts` recorded every item the model returned. The deterministic burn parser also ran and set the burn, so the same message was counted twice, once as intake and once as burn.
2. **A correction could make a burn into food.** The `replace` path accepted the replacement as a normal food with no burn check.
3. **The correction tool could not address an entry by time.** Corrections depended on the LLM choosing a target phrase and matched only on the entry name. A time such as "10:44 PM" matched nothing, so the request was refused and nothing changed.
4. **The tests did not exercise the failure.** The LLM was always stubbed with clean output, no test sent burn text the model had echoed as food, and no test checked day totals after a correction. The corrections tests only covered reduce, void, and replace on food names.
5. **The day table could show "Calories Burned: Not set" while the burn was recorded.** `renderDailySummary` used `usableBurn`, which is null on partial days, so a recorded burn looked missing.

## Manual data fix (done 2026-10-28)

1. On-demand backup created before any write:
   ```sh
   aws dynamodb create-backup --profile click --region us-east-1 \
     --table-name stuntman-diet-production-DietTable-P6OFUEX1VTJ6 \
     --backup-name pre-fix-issue-11-20261028
   ```
   Status: `AVAILABLE`. Restore from this backup if the change must be reverted.
2. Conditional update: the row must still be `active` at version 1.
   ```sh
   aws dynamodb update-item --profile click --region us-east-1 \
     --table-name stuntman-diet-production-DietTable-P6OFUEX1VTJ6 \
     --key '{"PK":{"S":"USER#b4f8e488-2041-70a5-6440-1a0dee735765"},"SK":{"S":"DAY#2026-10-27#ENTRY#0b40c534-a003-4288-ac4e-db7e5f427316"}}' \
     --condition-expression "#d.#s = :active AND #v = :one" \
     --update-expression "SET #d.#s = :void, #v = #v + :one" \
     --expression-attribute-names '{"#d":"data","#s":"status","#v":"version"}' \
     --expression-attribute-values '{":active":{"S":"active"},":void":{"S":"void"},":one":{"N":"1"}}' \
     --return-values ALL_NEW
   ```
   Result: version 2, status `void`. The row is kept, not deleted.
3. Left unchanged on purpose:
   - `9b5ea910` stays `superseded` (its `superseded_by` now points to a void row). This keeps the audit trail.
   - The day record already had the correct burn (2980, recorded). It was not changed.
   - `completeness` stays `partial`. The owner decides when the day is complete.

### Verified after the fix

| | Before | After |
| --- | --- | --- |
| Active entries | 13 | 12 |
| Intake (active entries) | 4,773 kcal | **1,793 kcal** |
| Burn | 2,980 kcal, recorded | 2,980 kcal, recorded |
| Burn-like active rows | 1 (`0b40c534`) | 0 |

Scan of the whole production table found no other burn-as-food rows. The only other burn-like row is the superseded `9b5ea910`. Net is not shown because the day is partial. Once it is marked complete in History it will be 1,793 − 2,980 = **−1,187 kcal**.

## Code fix

The new behaviour is covered in tests and in the owner's guide (`README.md`, section 4).

1. **`src/chat.ts`: burn is never food.** `looksLikeBurn()` drops any model item that contains a burn word (`burn`, `burned`) or a two-number sum (`1550 + 1200`). The reply says what was dropped and points to the fix command. The correction `replace` path cannot pick a burn as its replacement.
2. **`src/fixes.ts`: deterministic fix commands.** Any message starting with `fix` skips the LLM. The matching is exact:
   - Entries are matched by **clock time in the profile timezone**, plus an optional date and an optional name word.
   - No match lists the day's active entries. Several matches are refused with a request for a name. Nothing is written in either case.
   - Actions: `delete` (void), `burn [A + B]` (void the entry and set day burn, from its calories if no numbers are given), and `calories N` (supersede with a corrected entry).
   - A malformed `fix` returns the syntax as an error. It never becomes a food entry.
3. **Burn uses the effective-burn rule.** A tracked day with no written burn assumes **2000 kcal, labelled "assumed"**, as the owner asked. A recorded burn overrides it. Net is still only computed for complete days. The Athena SQL, local trends, History view, and the chat table use the same rule.
4. **`public/index.html`:** the log box shows the fix syntax under "Fix a wrong entry".
5. **`src/renderer.ts`:** the table labels an assumed burn as `(assumed)`.

## Tests

- `tests/incident-fixes.test.ts` (new):
  - Grammar: 10 valid forms with exact parsed values, 13 malformed forms that must return the syntax, and non-fix text that must not be parsed.
  - Incident replay with the model's real output: the 22:42 burn is not recorded as food, and a replacement that is a burn is refused with nothing written.
  - Fixes on rows shaped like production: delete, burn, burn with components, burn on another day by date, calories (history kept), ambiguous minute refused with no writes, empty minute refused with the entry list, untracked day refused, idempotent replay, and the HTTP route (200 for a good fix, 400 with syntax for a bad one).
  - The default burn: 2000 assumed on a new day, net against 2000 on complete days, recorded burn overrides, and no burn on non-tracking days.
  - The UI shows every documented syntax line.
- Mutation check: removing the burn guard from `src/chat.ts` makes the two incident tests fail, so they catch this bug.
- `tests/ledger.test.ts`: two assertions that required burn to stay unknown until accepted were updated to the new rule. The Athena SQL assertion was updated to match.

## Unknown

- The text of the owner's delete attempts is not stored. Only results are, and no error line was logged for them. The likely cause is root cause 3: a time-only reference matched nothing.
- Other problems from the README's "known problems" are still open, including issue #8 (silent drops), #9 (cross-day splits), and #10 (default portions).

## How to fix an entry in the future

Type one of these in the log box. Times are in your profile timezone. Add a date to fix another day.

```
fix 10:44 PM delete
fix 22:44 burn 1430 + 1550
fix 10:44 PM burn
fix 10:41 PM calories 150
fix 2026-10-27 22:44 delete
fix 11:41 AM crackers delete
```

- If the reply says **"N active entries at …"**, add a word from the name, for example `fix 11:41 AM crackers delete`.
- If the reply says **"No active entry at …"**, the reply lists what is logged that day. Use one of those times.
- A deleted or moved entry stays in the database with status `void`. Nothing is erased.

If something goes wrong in the data, restore the backup or use a new `fix`. Do not edit DynamoDB by hand unless the app cannot do it, and take a backup first.

## Directions for future work

- Always test the **real** failure. Stub the model with the output it actually produced, and assert totals after each step, not just that a function ran.
- New behaviour that changes what gets written needs a test that replays the exact user messages from the bug report.
- Keep deterministic parsing ahead of the model for anything that must be exact (burn, times, corrections).
- Before any manual production write, take an on-demand backup and use a conditional update.
