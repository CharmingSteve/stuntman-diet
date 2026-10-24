export type RequestTime = {
  instant: Date;
  original: string;
  timezone: string;
  dayKey: string;
};
export class TimeInputError extends Error {}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function dayKeyFor(date: Date, timezone: string): string {
  if (!validTimezone(timezone)) throw new TimeInputError("Invalid profile timezone");
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: string) => values.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Could not derive local day");
  return `${year}-${month}-${day}`;
}

export function resolveRequestTime(clientTime: unknown, timezone: string, fallback = new Date()): RequestTime {
  const hasProvided = typeof clientTime === "string";
  if (clientTime !== undefined && clientTime !== null && !hasProvided) {
    throw new TimeInputError("client_time must be an ISO 8601 string");
  }
  const original = hasProvided ? clientTime : fallback.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(original);
  if (!match) {
    throw new TimeInputError("client_time must include an explicit timezone offset");
  }
  const calendarDate = `${match[1]}-${match[2]}-${match[3]}`;
  const dateCheck = new Date(`${calendarDate}T00:00:00Z`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  if (Number.isNaN(dateCheck.valueOf()) || dateCheck.toISOString().slice(0, 10) !== calendarDate ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 14 ||
      (offsetHour === 14 && offsetMinute !== 0) || offsetMinute > 59) {
    throw new TimeInputError("client_time is invalid");
  }
  const instant = new Date(original);
  if (Number.isNaN(instant.valueOf())) throw new TimeInputError("client_time is invalid");
  return { instant, original, timezone, dayKey: dayKeyFor(instant, timezone) };
}

export function assertTimezone(timezone: unknown): asserts timezone is string {
  if (typeof timezone !== "string" || timezone.length > 100 || !validTimezone(timezone)) {
    throw new TimeInputError("timezone must be a valid IANA timezone");
  }
}
