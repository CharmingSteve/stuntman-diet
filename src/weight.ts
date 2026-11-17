// Manual body weight. Parsed in code, not by the model: a weight message returns before any model call, so it cannot
// become a food entry, and nothing is recorded unless the user posts a weight explicitly. Weight is a health reading.
// It is stored as a metric, never as a food entry, so it stays out of calorie totals.

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(kgs?|kilos?|kilograms?|lbs?|pounds?)`;
const WEIGHT_WORD = /\b(weight|weigh|weighed|weighing)\b/i;
const TIME_PHRASE = /\b(?:this\s+)?(?:morning|evening|afternoon|tonight|today)\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const CLOCK = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const FILLER = new Set(["i", "my", "is", "was", "am", "pm", "at", "this", "today", "morning", "evening", "afternoon", "tonight", "and", "the", "it", "now", "just"]);
export const WEIGHT_MIN_KG = 20;
export const WEIGHT_MAX_KG = 500;

export type WeightMessage =
  | { kind: "record"; value: number; time: { hour: number; minute: number } | null }
  | { kind: "refuse"; message: string };

// Returns null when the message is not about a weight, so the normal parser handles it.
export function parseWeightText(text: string): WeightMessage | null {
  const number = new RegExp(`\\b${NUMBER}\\s*${UNIT}?\\b`, "i").exec(text);
  if (!number) return null;
  const numberText = number[1]!;
  const unitText = number[2]?.toLowerCase();
  // The weight word must come right before the number: "weight 84.2", "my weight is 84.2". "weigh the cheese 200g" is food.
  const hasWeightWord = /\b(weight|weigh|weighed|weighing)\s*(?:is|was|:|=)?\s*$/i.test(text.slice(0, number.index));
  const rest = text.replace(number[0], " ").replace(WEIGHT_WORD, " ").replace(TIME_PHRASE, " ");
  const words = rest.toLowerCase().match(/\p{L}+/gu) ?? [];
  const onlyFiller = words.every((word) => FILLER.has(word));
  // A number with a unit and nothing else, or a weight word, is a weight. "200 g rice" is not.
  if (!hasWeightWord && !(unitText && onlyFiller)) return null;
  if (!onlyFiller) return { kind: "refuse", message: "Send your weight in its own message, for example: weight 84.2 kg. Nothing was recorded." };
  if (!unitText || !/^(kgs?|kilos?|kilograms?)$/.test(unitText)) {
    return { kind: "refuse", message: `Which unit is ${numberText}: kilograms (kg) or pounds (lb)? Only kilograms are recorded. Send it again, for example: weight ${numberText} kg. Nothing was recorded.` };
  }
  const value = Number(numberText.replace(",", "."));
  if (!(value >= WEIGHT_MIN_KG && value <= WEIGHT_MAX_KG)) {
    return { kind: "refuse", message: `Please check that weight: it must be between ${WEIGHT_MIN_KG} and ${WEIGHT_MAX_KG} kg. Nothing was recorded.` };
  }
  const clock = CLOCK.exec(text);
  if (!clock) return { kind: "record", value, time: null };
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { kind: "refuse", message: "Please check the time of the weight. Nothing was recorded." };
  return { kind: "record", value, time: { hour, minute } };
}
