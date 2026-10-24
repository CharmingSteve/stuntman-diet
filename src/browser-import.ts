import { z } from "zod";
import { digest, InputError } from "./ledger.js";
import { resolveRequestTime } from "./time.js";

const textMessage = z.object({
  id: z.string().optional(), role: z.string(), timestamp: z.string().optional(),
  create_time: z.number().nullable().optional(),
  content: z.union([z.string(), z.object({ parts: z.array(z.unknown()).optional() })])
});
type Table = { timestamp: string; conversation: string; message: string; rows: Array<{ display_name: string; calories: number }>; total?: number };
export function normalizeBrowserSources(input: unknown, timezone: string): unknown {
  const envelope = z.object({ sources: z.array(z.unknown()) }).parse(input);
  const canonical: unknown[] = [], tables = new Map<string, Table>();
  for (const sourceFile of envelope.sources) {
    for (const source of Array.isArray(sourceFile) ? sourceFile : [sourceFile]) {
      if (!source || typeof source !== "object") throw new InputError("Import JSON must contain conversations");
      const value = z.record(z.string(), z.unknown()).parse(source);
      if (Array.isArray(value.messages) && value.messages.every((m) => m && typeof m === "object" && "kind" in m)) { canonical.push(value); continue; }
      const conversation = z.string().parse(value.conversation_id ?? value.id);
      let messages: z.infer<typeof textMessage>[];
      if (value.mapping && typeof value.mapping === "object") {
        const mapping = z.record(z.string(), z.unknown()).parse(value.mapping);
        // Follow the current branch only; alternate/regenerated branches overlap.
        let current = typeof value.current_node === "string" ? value.current_node : undefined;
        const branch: unknown[] = [], visited = new Set<string>();
        while (current) {
          if (visited.has(current)) throw new InputError("Conversation mapping contains a cycle");
          visited.add(current);
          const node = z.object({ message: z.unknown().nullable().optional(), parent: z.string().nullable().optional() }).parse(mapping[current]);
          if (node.message) branch.unshift(node.message);
          current = node.parent ?? undefined;
        }
        if (!branch.length) throw new InputError("ChatGPT export needs current_node to identify the active conversation branch");
        messages = branch.map((m) => {
          const raw = z.object({ id: z.string(), create_time: z.number().nullable(), author: z.object({ role: z.string() }), content: z.object({ parts: z.array(z.unknown()).optional() }) }).parse(m);
          return { id: raw.id, role: raw.author.role, create_time: raw.create_time, content: raw.content };
        });
      } else messages = z.array(textMessage).parse(value.messages);
      let extracted = 0;
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content : (message.content.parts ?? []).filter((p): p is string => typeof p === "string").join("\n");
        const rows = [...text.matchAll(/^\s*\|\s*([^|\n]+?)\s*\|\s*(\d[\d,]*(?:\.\d+)?)\s*(?:kcal|calories)?\s*\|\s*$/gmi)]
          .filter((m) => !/^(total|food|calories|net|burn|no foods)/i.test(m[1]!.trim()))
          .map((m) => ({ display_name: m[1]!.trim().replace(/\*\*/g, ""), calories: Number(m[2]!.replaceAll(",", "")) }));
        if (!rows.length) continue;
        const timestamp = message.timestamp ?? (message.create_time ? new Date(message.create_time * 1000).toISOString() : undefined);
        if (!timestamp) throw new InputError("A browser table has no source timestamp; normalize it with an explicit original date before importing");
        const day = resolveRequestTime(timestamp, timezone).dayKey;
        const total = /Total Intake:\*?\*?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
        const table: Table = { timestamp, conversation, message: message.id ?? digest([timestamp, text]), rows, ...(total ? { total: Number(total[1]!.replaceAll(",", "")) } : {}) };
        const previous = tables.get(day);
        if (!previous || Date.parse(previous.timestamp) < Date.parse(timestamp)) tables.set(day, table);
        extracted++;
      }
      if (!extracted) throw new InputError("No supported two-column daily food tables found. Use normalized JSON for free-text meals, metrics, burn and corrections.");
    }
  }
  if (tables.size) {
    const messages: Record<string, unknown>[] = [];
    for (const [day, table] of tables) {
      const note = `Review cumulative daily table from ${table.conversation}/${table.message}: inferred day ${day} from message timestamp in ${timezone}; confirm that this is the final table for that day. Free-text-only meals/metrics/burn are not extracted.`;
      for (const [index, row] of table.rows.entries()) messages.push({
        id: `table-${day}-${index}`, timestamp: table.timestamp, timezone,
        kind: "meal", ...row, review_note: note,
        source_reference: `${table.conversation}/${table.message}`
      });
      if (table.total !== undefined) messages.push({ id: `summary-${day}`, timestamp: table.timestamp, timezone, kind: "summary", total: table.total, review_note: note, source_reference: `${table.conversation}/${table.message}` });
    }
    // One stable day/row identity across overlapping browser export files.
    canonical.push({ conversation_id: "browser-daily-tables", messages });
  }
  return { sources: canonical };
}
