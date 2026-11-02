export type ParsedBurn = { total: number; components: number[] };

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const ORDINAL = "(?:st|nd|rd|th)?";
const SUM = /(\d{3,5})\s*\+\s*(\d{3,5})/;

// Reads the day a clause names, without a year: "Nov 1", "November 1st", "1 Nov", "1st of November".
function monthDay(text: string): string | null {
  const a = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}\\b`, "i").exec(text);
  const b = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b`, "i").exec(text);
  const month = a ? MONTHS[a[1]!.toLowerCase()] : b ? MONTHS[b[2]!.toLowerCase()] : undefined;
  const dayOfMonth = a ? a[2] : b?.[1];
  if (!month || !dayOfMonth) return null;
  return `${month}-${dayOfMonth.padStart(2, "0")}`;
}

// Amount of a burn, as read from the text. The day is handled separately by burnDayPhrases.
export function parseBurnText(text: string): ParsedBurn | null {
  const sum = SUM.exec(text);
  if (sum && (/\bburn(?:ed)?\b/i.test(text) || text.trim() === sum[0].trim())) {
    const components = [Number(sum[1]), Number(sum[2])];
    return { components, total: components.reduce((total, value) => total + value, 0) };
  }
  const total = /\bburn(?:ed)?\s+so\s+far\s*:?\s*(\d{3,5})\b/i.exec(text);
  if (total?.[1]) return { total: Number(total[1]), components: [] };
  return null;
}

// The day named in each clause that describes a burn, one entry per distinct day:
//   "yesterday" | "today" (no day named) | YYYY-MM-DD | MM-DD (year chosen by the caller).
// Only burn clauses count, so "today burned 1642 + 1615; same lunch as yesterday" is today.
export function burnDayPhrases(text: string): string[] {
  const found = new Set<string>();
  for (const clause of text.split(/[.;\n,]|\s(?:and|but)\s/i)) {
    const isBurn = /\bburn(?:ed|t)?\b/i.test(clause) || SUM.test(clause);
    if (!isBurn) continue;
    const day = /\byesterday\b/i.test(clause) ? "yesterday"
      : /\b(\d{4}-\d{2}-\d{2})\b/.exec(clause)?.[1] ?? monthDay(clause);
    found.add(day ?? "today");
  }
  return [...found];
}
