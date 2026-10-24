export type RenderEntry = { display_name: string; calories: number; occurred_at?: string };

export function isEndOfDay(timestamp: string, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour > 23 || (hour === 23 && minute >= 30);
}

export function renderDailySummary(
  entries: RenderEntry[],
  burn: number | null,
  timestamp: string,
  timezone: string,
  endOfDay = false,
  showFullDate = true
): string {
  const formatter = new Intl.DateTimeFormat("en-IL", {
    timeZone: timezone,
    ...(endOfDay || showFullDate ? { dateStyle: "medium" as const } : {}),
    timeStyle: "short"
  });
  const headerTime = formatter.format(new Date(timestamp));
  const total = entries.reduce((sum, entry) => sum + entry.calories, 0);
  const rows = entries.map((entry) => `| ${entry.display_name.replaceAll("|", "\\|")} | ${Math.round(entry.calories)} |`);
  return [
    `**${headerTime}**`,
    "",
    "| Food | Calories |",
    "| --- | ---: |",
    ...(rows.length ? rows : ["| No foods logged | 0 |"]),
    "",
    `**Total Intake:** ${Math.round(total)} kcal`,
    `**Calories Burned:** ${burn === null ? "Not set" : `${Math.round(burn)} kcal`}`,
    `**Net Calories:** ${burn === null ? "Not available" : `${Math.round(total - burn)} kcal`}`
  ].join("\n");
}
