export type ParsedBurn = { total: number; components: number[] };

export function parseBurnText(text: string): ParsedBurn | null {
  const sum = /(?:burn(?:ed)?(?:\s+so\s+far)?\s*:?\s*)?(\d{3,5})\s*\+\s*(\d{3,5})/i.exec(text);
  if (sum && (/\bburn(?:ed)?\b/i.test(text) || text.trim() === sum[0].trim())) {
    const components = [Number(sum[1]), Number(sum[2])];
    return { components, total: components.reduce((total, value) => total + value, 0) };
  }
  const total = /\bburn(?:ed)?\s+so\s+far\s*:?\s*(\d{3,5})\b/i.exec(text);
  if (total?.[1]) return { total: Number(total[1]), components: [] };
  return null;
}
