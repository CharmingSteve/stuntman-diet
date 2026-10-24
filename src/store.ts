export type StoreItem = {
  PK: string;
  SK: string;
  entity: string;
  version: number;
  data: Record<string, unknown>;
};

export type StoreWrite = { item: StoreItem; expectedVersion: number | null };

export type StoreQuery = {
  prefix?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export interface Store {
  get(PK: string, SK: string): Promise<StoreItem | undefined>;
  query(PK: string, options: StoreQuery): Promise<{ items: StoreItem[]; cursor?: string }>;
  transact(writes: StoreWrite[]): Promise<void>;
  close(): void;
}

export class StoreConflict extends Error {
  constructor(message = "The stored version changed; reload before retrying.") {
    super(message);
    this.name = "StoreConflict";
  }
}

export async function allItems(
  store: Store,
  PK: string,
  options: { prefix?: string; from?: string; to?: string } = {}
): Promise<StoreItem[]> {
  const items: StoreItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(PK, { ...options, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export function validateWrites(writes: StoreWrite[]): void {
  if (writes.length > 100) throw new Error("A store transaction supports at most 100 writes.");
  const keys = new Set<string>();
  for (const { item, expectedVersion } of writes) {
    if (!item.PK || !item.SK || !item.entity || !Number.isSafeInteger(item.version) || item.version < 1) {
      throw new Error("Store items require keys, an entity, and a positive integer version.");
    }
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new Error("expectedVersion must be null or a positive integer.");
    }
    if (item.version !== (expectedVersion ?? 0) + 1) {
      throw new Error("The item version must increment the expected version by one.");
    }
    if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) {
      throw new Error("Store item data must be an object.");
    }
    const key = JSON.stringify([item.PK, item.SK]);
    if (keys.has(key)) throw new Error("A transaction cannot write the same item twice.");
    keys.add(key);
  }
}

export function queryLimit(options: StoreQuery): number {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Query limit must be an integer between 1 and 1000.");
  }
  if (options.from !== undefined && options.to !== undefined &&
      Buffer.compare(Buffer.from(options.from), Buffer.from(options.to)) > 0) {
    throw new Error("Query from must not exceed to.");
  }
  return limit;
}

export function encodeCursor(PK: string, SK: string, options: StoreQuery): string {
  return Buffer.from(JSON.stringify({
    v: 1, PK, SK, prefix: options.prefix ?? null, from: options.from ?? null, to: options.to ?? null
  })).toString("base64url");
}

export function decodeCursor(PK: string, options: StoreQuery): string | undefined {
  if (options.cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.PK !== PK || typeof value.SK !== "string" ||
        value.prefix !== (options.prefix ?? null) || value.from !== (options.from ?? null) ||
        value.to !== (options.to ?? null)) {
      throw new Error("Cursor does not match query.");
    }
    return value.SK;
  } catch {
    throw new Error("Invalid store query cursor.");
  }
}
