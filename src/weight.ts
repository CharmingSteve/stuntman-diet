// Manual body weight. Parsed in code before any model call, so a weight can't become a food entry or be copied to
// other days. Only an explicit posted weight is recorded. Weight is a health reading: it is stored as a metric and
// stays out of calorie totals.
//
// A message is a weight only when it has exactly one number that reads as a weight and nothing else of substance.
// Questions and ordinary food return null (they go to the normal path). Mixed content and bad values are refused
// with nothing recorded.

export const WEIGHT_MIN_KG = 20;
export const WEIGHT_MAX_KG = 500;

const NUMBER_RE = /[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)/g;
const UNIT_RE = /^\s*(kgs?|kilos?|kilograms?|lbs?|pounds?)\b/i;
const WEIGHT_PREFIX_RE = /\b(weight|weigh|weighed|weighing)\s*(?:is|was|:|=)?\s*$/i;
const WEIGHT_WORD_RE = /\b(weight|weigh|weighed|weighing)\b/gi;
const TIME_RE = /\b(?:this\s+)?(?:morning|evening|afternoon|tonight|today)\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const CLOCK_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const QUESTION_RE = /^\s*(is|am|are|was|were|what|how|when|did|do|does|should|can|could|why|where|who)\b/i;
const FILLER = new Set(["i", "my", "is", "was", "am", "pm", "at", "this", "today", "morning", "evening", "afternoon", "tonight", "and", "the", "it", "now", "just"]);

export type WeightMessage =
  | { kind: "record"; value: number; time: { hour: number; minute: number } | null }
  | { kind: "refuse"; message: string };

const refuse = (message: string): WeightMessage => ({ kind: "refuse", message });
const SEND_ALONE = "Send your weight in its own message, for example: weight 84.2 kg. Nothing was recorded.";
const BAD_TIME = "Please check the time of the weight. Nothing was recorded.";

// Blanks out clock and day phrases so their numbers are not read as a weight. Character positions are kept.
function mask(text: string): string {
  return text.replace(TIME_RE, (match) => " ".repeat(match.length));
}

export function parseWeightText(text: string): WeightMessage | null {
  // Questions are never recorded. They go to the read-only question path.
  if (text.includes("?") || QUESTION_RE.test(text)) return null;
  const masked = mask(text);
  const numbers = [...masked.matchAll(NUMBER_RE)].map((match) => {
    const start = match.index!, end = start + match[0].length;
    const unit = UNIT_RE.exec(masked.slice(end));
    return {
      text: match[0], start,
      value: Number(match[0].replace(",", ".")),
      unit: unit?.[1]?.toLowerCase(),
      unitEnd: unit ? end + unit[0].length : end,
      prefixed: WEIGHT_PREFIX_RE.test(masked.slice(0, start))
    };
  });
  // A weight is a number after a weight word, or a kg/lb number of at least 20 (a negative one too, so it is refused).
  // "1 kg of rice" stays food.
  const weights = numbers.filter((n) => n.prefixed || (n.unit !== undefined && (n.value >= WEIGHT_MIN_KG || n.text.startsWith("-"))));
  if (weights.length === 0) return null;
  // Any other number, such as a second weight or a date, is mixed content.
  if (numbers.length > 1) return refuse(SEND_ALONE);

  const weight = weights[0]!;
  // Besides the weight, its unit, the weight word, and clock or day phrases, only filler words may remain.
  const rest = [masked.slice(0, weight.start), " ".repeat(weight.unitEnd - weight.start), masked.slice(weight.unitEnd)]
    .join("")
    .replace(WEIGHT_WORD_RE, " ");
  const words = rest.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.every((word) => FILLER.has(word))) return refuse(SEND_ALONE);

  if (weight.unit === undefined) {
    return refuse(`Which unit is ${weight.text}: kilograms (kg) or pounds (lb)? Only kilograms are recorded. Send it again, for example: weight ${weight.text} kg. Nothing was recorded.`);
  }
  if (!/^(kgs?|kilos?|kilograms?)$/.test(weight.unit)) {
    return refuse(`Only kilograms are recorded. Send ${weight.text} kg if that is your weight. Nothing was recorded.`);
  }
  if (!(weight.value >= WEIGHT_MIN_KG && weight.value <= WEIGHT_MAX_KG)) {
    return refuse(`Please check that weight: it must be between ${WEIGHT_MIN_KG} and ${WEIGHT_MAX_KG} kg. Nothing was recorded.`);
  }

  const clock = CLOCK_RE.exec(text);
  if (!clock) return { kind: "record", value: weight.value, time: null };
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();
  if (minute > 59) return refuse(BAD_TIME);
  if (meridiem) {
    // A 12-hour clock takes 1 to 12 only. Convert after checking.
    if (hour < 1 || hour > 12) return refuse(BAD_TIME);
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return refuse(BAD_TIME);
  }
  return { kind: "record", value: weight.value, time: { hour, minute } };
}
