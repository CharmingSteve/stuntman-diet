const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const ORDINAL = "(?:st|nd|rd|th)?";

// Reads the day a burn names, without a year: "Nov 1", "November 1st", "1 Nov", "1st of November".
function monthDay(text: string): string | null {
  const a = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}\\b`, "i").exec(text);
  const b = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b`, "i").exec(text);
  const month = a ? MONTHS[a[1]!.toLowerCase()] : b ? MONTHS[b[2]!.toLowerCase()] : undefined;
  const dayOfMonth = a ? a[2] : b?.[1];
  if (!month || !dayOfMonth) return null;
  return `${month}-${dayOfMonth.padStart(2, "0")}`;
}

// `day` is "yesterday", an ISO date (2026-11-01), a month-day without year (11-01, year chosen by the caller), or null (the request's own day).
export type ParsedBurn = { total: number; components: number[]; day: string | null };

export function parseBurnText(text: string): ParsedBurn | null {
  const day = /\byesterday\b/i.test(text) ? "yesterday"
    : /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? monthDay(text);
  const sum = /(?:burn(?:ed)?(?:\s+so\s+far)?\s*:?\s*)?(\d{3,5})\s*\+\s*(\d{3,5})/i.exec(text);
  if (sum && (/\bburn(?:ed)?\b/i.test(text) || text.trim() === sum[0].trim())) {
    const components = [Number(sum[1]), Number(sum[2])];
    return { components, total: components.reduce((total, value) => total + value, 0), day };
  }
  const total = /\bburn(?:ed)?\s+so\s+far\s*:?\s*(\d{3,5})\b/i.exec(text);
  if (total?.[1]) return { total: Number(total[1]), components: [], day };
  return null;
}
