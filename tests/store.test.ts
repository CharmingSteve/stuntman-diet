import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { seedFoods } from "../src/seed.js";
import { DynamoStore } from "../src/store-dynamo.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, StoreConflict, type Store, type StoreItem, type StoreWrite } from "../src/store.js";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const backends = ["sqlite", ...(endpoint ? ["dynamo"] : [])];

describe.each(backends)("store contract: %s", (backend) => {
  let store: Store;
  let PK: string;
  let path: string;
  let client: DynamoDBClient | undefined;
  const tableName = `store-contract-${randomUUID()}`;
  const open = (): Store => backend === "sqlite"
    ? new SQLiteStore(createDatabase(path)) : new DynamoStore(tableName);
  const item = (SK: string, data: Record<string, unknown> = {}, version = 1): StoreItem =>
    ({ PK, SK, entity: "entry", version, data });
  const put = (value: StoreItem): StoreWrite => ({ item: value, expectedVersion: null });

  beforeAll(async () => {
    if (backend !== "dynamo") return;
    // Validate the endpoint before giving the test provisioning client credentials.
    const validation = new DynamoStore(tableName);
    validation.close();
    client = new DynamoDBClient({
      endpoint, region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" }
    });
    await client.send(new CreateTableCommand({
      TableName: tableName, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }
      ]
    }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  }, 60_000);

  beforeEach(() => {
    PK = `USER#${randomUUID()}`;
    path = `.store-contract-${randomUUID()}.db`;
    store = open();
  });

  afterEach(() => {
    store.close();
    if (backend === "sqlite") {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  afterAll(async () => {
    if (!client) return;
    try { await client.send(new DeleteTableCommand({ TableName: tableName })); }
    finally { client.destroy(); }
  });

  it("reads writes immediately without crossing user partitions", async () => {
    expect(await store.get(PK, "PROFILE")).toBeUndefined();
    const profile = { ...item("PROFILE", { timezone: "Asia/Jerusalem" }), entity: "profile" };
    const preference = { ...item("FOOD_PREF#banana", { preferred_value: { calories: 120 } }), entity: "food_pref" };
    await store.transact([put(profile), put(preference)]);
    expect(await store.get(PK, "PROFILE")).toEqual(profile);
    expect(await store.get(PK, preference.SK)).toEqual(preference);
    expect(await store.get(`${PK}-other`, preference.SK)).toBeUndefined();
    expect((await store.query(`${PK}-other`, {})).items).toEqual([]);
  });

  it("paginates ordered, bounded prefixes and fully follows more than one default page", async () => {
    const values = Array.from({ length: 105 }, (_, i) => item(`DAY#2026-10-25#ENTRY#${String(i).padStart(3, "0")}`));
    await store.transact(values.slice(0, 100).map(put));
    await store.transact(values.slice(100).map(put));
    await store.transact([put(item("DAY#2026-10-26#META")), put(item("PROFILE"))]);
    const options = { prefix: "DAY#2026-10-25#ENTRY#", limit: 3 };
    const first = await store.query(PK, options);
    expect(first.items).toEqual(values.slice(0, 3));
    expect(first.cursor).toBeTruthy();
    const second = await store.query(PK, { ...options, cursor: first.cursor! });
    expect(second.items).toEqual(values.slice(3, 6));
    expect(await allItems(store, PK, { prefix: options.prefix })).toEqual(values);
    expect(await allItems(store, PK, {
      prefix: options.prefix, from: values[3]!.SK, to: values[7]!.SK
    })).toEqual(values.slice(3, 8));
    expect(await allItems(store, PK, { from: "DAY#2026-10-26", to: "DAY#2026-10-26#\uffff" }))
      .toEqual([item("DAY#2026-10-26#META")]);
    expect(await allItems(store, PK, { prefix: "ENTRY#" })).toEqual([]);
    await expect(store.query(`${PK}-other`, { ...options, cursor: first.cursor! })).rejects.toThrow(/cursor/i);
    await expect(store.query(PK, { prefix: "PROFILE", cursor: first.cursor! })).rejects.toThrow(/cursor/i);
  });

  it("handles empty filtered pages without abandoning a valid cursor", async () => {
    const fake: Store = {
      ...store,
      get: store.get.bind(store),
      close: () => {},
      transact: store.transact.bind(store),
      query: vi.fn()
        .mockResolvedValueOnce({ items: [], cursor: "next" })
        .mockResolvedValueOnce({ items: [item("ENTRY#last")] })
    };
    expect(await allItems(fake, PK)).toEqual([item("ENTRY#last")]);
    expect(fake.query).toHaveBeenNthCalledWith(2, PK, { cursor: "next" });
  });

  it("rolls every write back on insert or version conflicts", async () => {
    const original = item("DAY#2026-10-25#ENTRY#original", { status: "active" });
    await store.transact([put(original)]);
    await expect(store.transact([
      put(item("REQUEST#must-not-exist")),
      put(original)
    ])).rejects.toBeInstanceOf(StoreConflict);
    expect(await store.get(PK, "REQUEST#must-not-exist")).toBeUndefined();
    await expect(store.transact([
      put(item("REQUEST#also-missing")),
      { item: { ...original, version: 3 }, expectedVersion: 2 }
    ])).rejects.toBeInstanceOf(StoreConflict);
    expect(await store.get(PK, "REQUEST#also-missing")).toBeUndefined();
    expect(await store.get(PK, original.SK)).toEqual(original);
    await expect(store.transact([
      { item: item("missing", {}, 2), expectedVersion: 1 }
    ])).rejects.toBeInstanceOf(StoreConflict);
  });

  it("allows exactly one competing correction and persists its receipt across reopening", async () => {
    const original = item("DAY#2026-10-25#ENTRY#original", { status: "active", calories: 100 });
    await store.transact([put(original)]);
    const left = await store.get(PK, original.SK);
    const right = await store.get(PK, original.SK);
    const correction = (snapshot: StoreItem, id: string): StoreWrite[] => [
      {
        item: {
          ...snapshot, version: snapshot.version + 1,
          data: { ...snapshot.data, status: "superseded", superseded_by: id }
        },
        expectedVersion: snapshot.version
      },
      put(item(`DAY#2026-10-25#ENTRY#${id}`, { status: "active", calories: 80 })),
      put({ ...item(`REQUEST#${id}`, { payload_hash: id, result: { entry_id: id } }), entity: "receipt" })
    ];
    const results = await Promise.allSettled([
      store.transact(correction(left!, "left")), store.transact(correction(right!, "right"))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StoreConflict);
    const updated = (await store.get(PK, original.SK))!;
    const winner = updated.data.superseded_by as string;
    const loser = winner === "left" ? "right" : "left";
    expect(await store.get(PK, `DAY#2026-10-25#ENTRY#${loser}`)).toBeUndefined();
    expect(await store.get(PK, `REQUEST#${loser}`)).toBeUndefined();
    store.close();
    store = open();
    const receipt = await store.get(PK, `REQUEST#${winner}`);
    expect(receipt?.data).toEqual({ payload_hash: winner, result: { entry_id: winner } });
    expect((await allItems(store, PK, { prefix: "DAY#" })).filter((value) => value.data.status === "active"))
      .toHaveLength(1);
    await expect(store.transact(correction(original, winner))).rejects.toBeInstanceOf(StoreConflict);
    expect(await store.get(PK, `REQUEST#${winner}`)).toEqual(receipt);
  });

  it("preserves original offsets, timezone, day assignments, and metric exclusions independently", async () => {
    const records = [
      { ...item("DAY#2026-10-24#META", { day_key: "2026-10-24", eligibility: "untracked", completeness: "missing" }), entity: "day" },
      { ...item("DAY#2026-10-24#METRIC#g", {
        occurred_at: "2026-10-24T23:30:00-04:00", day_key: "2026-10-24",
        timezone: "America/New_York", metric: "glucose", value: 90
      }), entity: "metric" },
      item("DAY#2026-10-25#ENTRY#e", {
        occurred_at: "2026-10-24T23:30:00-04:00", day_key: "2026-10-25",
        timezone: "Asia/Jerusalem", status: "active", calories_source: "user_number", image_key: "private/photo"
      })
    ];
    await store.transact(records.map(put));
    expect(await allItems(store, PK, { prefix: "DAY#" })).toEqual(records);
  });

  it("bounds 30 calendar days without deleting older retained history", async () => {
    const records = Array.from({ length: 35 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 8, 21 + index)).toISOString().slice(0, 10);
      return {
        ...item(`DAY#${date}#META`, {
          day_key: date, eligibility: index % 7 < 2 ? "untracked" : "tracked",
          completeness: "missing", burn_total: null
        }), entity: "day"
      };
    });
    await store.transact(records.map(put));
    expect(await allItems(store, PK, {
      from: "DAY#2026-09-26", to: "DAY#2026-10-25#\uffff"
    })).toEqual(records.slice(5));
    expect(await allItems(store, PK, { prefix: "DAY#" })).toHaveLength(35);
  });

  it("retains multiple alias candidates and isolates user food preferences", async () => {
    const aliasPK = `ALIAS#${randomUUID()}`;
    const candidates = ["one", "two"].map((id) => ({
      ...item(`FOOD#${id}`, { food_id: id }), PK: aliasPK, entity: "alias"
    }));
    await store.transact(candidates.map(put));
    expect(await allItems(store, aliasPK)).toEqual(candidates);
    await store.transact([put(item("FOOD_PREF#one", { preferred_value: { calories: 50 } }))]);
    expect(await store.get(`${PK}-other`, "FOOD_PREF#one")).toBeUndefined();
    expect((await store.get(PK, "FOOD_PREF#one"))?.data.preferred_value).toEqual({ calories: 50 });
  });

  it("rejects oversized or invalid transactions before writing anything", async () => {
    await expect(store.transact(Array.from({ length: 101 }, (_, i) => put(item(`oversize#${i}`)))))
      .rejects.toThrow(/100/);
    await expect(store.transact([put(item("duplicate")), put(item("duplicate"))])).rejects.toThrow(/same item/);
    await expect(store.transact([{ item: item("bad-version", {}, 2), expectedVersion: null }]))
      .rejects.toThrow(/version/);
    expect(await allItems(store, PK)).toEqual([]);
    await expect(store.transact([])).resolves.toBeUndefined();
    await expect(store.query(PK, { limit: 0 })).rejects.toThrow(/limit/i);
    await expect(store.query(PK, { cursor: "not-json" })).rejects.toThrow(/cursor/i);
  });
});

describe("SQLite legacy migration", () => {
  it("atomically migrates snake_case data and food records without overwriting or repeating", async () => {
    const db = createDatabase(":memory:");
    seedFoods(db, [{
      id: "food", name: "Test food", aliases: ["shared"], category: "test",
      basis: { calories_per_100g: 90 }, preferred_value: { calories_per_100g: 100 }, notes: "keep"
    }]);
    db.prepare("INSERT INTO user_profiles VALUES (?, ?, ?)").run("u", "Asia/Jerusalem", "2026-10-25T00:00:00Z");
    for (const date of ["2026-10-23", "2026-10-24", "2026-10-25"]) {
      db.prepare("INSERT INTO days (user_id, day_key, timezone, burn_total, burn_components_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("u", date, "Asia/Jerusalem", 2000, "[1000,1000]", `${date}T00:00:00Z`);
    }
    db.prepare(`INSERT INTO log_entries (
      id, user_id, day_key, occurred_at, timezone, food_id, raw_text, display_name,
      quantity, unit, calories, calories_source, match_stage, image_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "e", "u", "2026-10-23", "2026-10-23T23:30:00+03:00", "Asia/Jerusalem",
      "food", "original", "Test food", 1, "portion", 100, "user_number", "user_number",
      "private/image", "2026-10-23T20:30:00Z"
    );
    db.prepare("INSERT INTO health_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("m", "u", "2026-10-24T12:00:00Z", "2026-10-24", "Asia/Jerusalem", "glucose", 90, "mg/dL", "user");
    const store = new SQLiteStore(db);
    try {
      expect((await store.get("USER#u", "PROFILE"))?.data.timezone).toBe("Asia/Jerusalem");
      expect((await store.get("USER#u", "DAY#2026-10-23#META"))?.data).toEqual({
        day_key: "2026-10-23", timezone: "Asia/Jerusalem", burn_total: 2000,
        burn_source: "assumed", eligibility: "untracked", completeness: "partial",
        accept_default_burn: false, burn_components: [1000, 1000]
      });
      expect((await store.get("USER#u", "DAY#2026-10-24#META"))?.data).toMatchObject({
        burn_source: "assumed", eligibility: "untracked", completeness: "missing"
      });
      expect((await store.get("USER#u", "DAY#2026-10-25#META"))?.data).toMatchObject({
        eligibility: "tracked", completeness: "missing"
      });
      expect((await store.get("USER#u", "DAY#2026-10-23#ENTRY#e"))?.data).toMatchObject({
        occurred_at: "2026-10-23T23:30:00+03:00", day_key: "2026-10-23",
        timezone: "Asia/Jerusalem", status: "active", superseded_by: null,
        calories_source: "user_number", image_key: "private/image"
      });
      expect((await store.get("USER#u", "DAY#2026-10-24#METRIC#m"))?.entity).toBe("metric");
      expect((await store.get("CATALOG", "FOOD#food"))?.data).toEqual({
        id: "food", name: "Test food", aliases: ["shared", "Test food"],
        category: "test", basis: { calories_per_100g: 90 }, notes: "keep"
      });
      expect((await store.get("USER#u", "FOOD_PREF#food"))?.data).toEqual({ calories_per_100g: 100 });
      expect((await allItems(store, "ALIAS#shared"))[0]?.data.food_id).toBe("food");
      const profile = (await store.get("USER#u", "PROFILE"))!;
      await store.transact([{ item: { ...profile, version: 2, data: { timezone: "Europe/London" } }, expectedVersion: 1 }]);
      db.prepare("INSERT INTO user_profiles VALUES (?, ?, ?)").run("late", "UTC", "2026-10-25T00:00:00Z");
      const reopened = new SQLiteStore(db);
      expect((await reopened.get("USER#u", "PROFILE"))?.data.timezone).toBe("Europe/London");
      expect(await reopened.get("USER#late", "PROFILE")).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS n FROM store_migrations").get()).toEqual({ n: 1 });
    } finally { store.close(); }
  });

  it("copies legacy global preferences only to existing users and preserves their isolated overrides", async () => {
    const db = createDatabase(":memory:");
    seedFoods(db, [{
      id: "food", name: "Food", aliases: [], category: "test", basis: { calories_per_100g: 90 },
      preferred_value: { calories_per_100g: 100 }
    }]);
    db.prepare("INSERT INTO user_profiles VALUES (?, ?, ?)").run("alice", "UTC", "2026-10-25T00:00:00Z");
    db.prepare("INSERT INTO health_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("metric", "bob", "2026-10-25T12:00:00Z", "2026-10-25", "UTC", "weight", 65, "kg", "user");
    const store = new SQLiteStore(db);
    try {
      const alice = (await store.get("USER#alice", "FOOD_PREF#food"))!;
      const bob = (await store.get("USER#bob", "FOOD_PREF#food"))!;
      expect(alice).toMatchObject({ entity: "food_preference", data: { calories_per_100g: 100 } });
      expect(bob.data).toEqual(alice.data);
      expect((await store.get("CATALOG", "FOOD#food"))?.data).not.toHaveProperty("preferred_value");
      expect(await store.get("USER#new-user", "FOOD_PREF#food")).toBeUndefined();
      await store.transact([{
        item: { ...alice, version: 2, data: { calories_per_100g: 200 } }, expectedVersion: 1
      }]);
      expect((await store.get("USER#bob", "FOOD_PREF#food"))?.data).toEqual({ calories_per_100g: 100 });
      db.prepare("UPDATE foods SET preferred_value_json = ? WHERE id = ?").run('{"calories_per_100g":300}', "food");
      const reopened = new SQLiteStore(db);
      expect((await reopened.get("USER#alice", "FOOD_PREF#food"))?.data).toEqual({ calories_per_100g: 200 });
      expect((await reopened.get("USER#bob", "DAY#2026-10-25#META"))?.data).toEqual({
        day_key: "2026-10-25", timezone: "UTC", burn_total: null, burn_source: null,
        accept_default_burn: false, burn_components: [], eligibility: "tracked", completeness: "missing"
      });
      expect(await reopened.get("USER#new-user", "FOOD_PREF#food")).toBeUndefined();
    } finally { store.close(); }
  });

  it("rolls back a failed migration and retries without overwriting preexisting store items", async () => {
    const db = createDatabase(":memory:");
    db.prepare("INSERT INTO user_profiles VALUES (?, ?, ?)").run("u", "UTC", "2026-10-25T00:00:00Z");
    db.prepare("INSERT INTO foods (id, name, category, basis_json) VALUES (?, ?, ?, ?)")
      .run("bad", "bad", "test", "invalid json");
    expect(() => new SQLiteStore(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'store_items'").get()).toBeUndefined();
    db.prepare("UPDATE foods SET basis_json = '{}'").run();
    db.exec(`CREATE TABLE store_items (
      PK TEXT NOT NULL, SK TEXT NOT NULL, entity TEXT NOT NULL, version INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY (PK, SK)
    )`);
    db.prepare("INSERT INTO store_items VALUES (?, ?, ?, ?, ?)")
      .run("USER#u", "PROFILE", "profile", 7, '{"timezone":"Europe/London"}');
    db.prepare("UPDATE foods SET preferred_value_json = ? WHERE id = ?")
      .run('{"calories_per_100g":100}', "bad");
    db.prepare("INSERT INTO store_items VALUES (?, ?, ?, ?, ?)")
      .run("USER#u", "FOOD_PREF#bad", "food_preference", 3, '{"calories_per_100g":200}');
    const store = new SQLiteStore(db);
    try {
      expect(await store.get("USER#u", "PROFILE")).toMatchObject({ version: 7, data: { timezone: "Europe/London" } });
      expect(await store.get("USER#u", "FOOD_PREF#bad")).toMatchObject({
        version: 3, data: { calories_per_100g: 200 }
      });
      expect(await store.get("CATALOG", "FOOD#bad")).toBeDefined();
    } finally { store.close(); }
  });
});

describe("DynamoDB request safety", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("uses strongly consistent base reads and conditional transactional puts", async () => {
    vi.stubEnv("DYNAMODB_ENDPOINT", "http://localhost:8000");
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    const store = new DynamoStore("test-table");
    try {
      await store.get("USER#u", "PROFILE");
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({ ConsistentRead: true });
      await store.query("USER#u", { prefix: "DAY#" });
      expect(send.mock.calls[1]?.[0]).toBeInstanceOf(QueryCommand);
      expect(send.mock.calls[1]?.[0].input).toMatchObject({ ConsistentRead: true });
      await store.transact([
        { item: { PK: "USER#u", SK: "PROFILE", entity: "profile", version: 1, data: {} }, expectedVersion: null },
        { item: { PK: "USER#u", SK: "REQUEST#r", entity: "receipt", version: 2, data: {} }, expectedVersion: 1 }
      ]);
      expect(send.mock.calls[2]?.[0]).toBeInstanceOf(TransactWriteCommand);
      expect(send.mock.calls[2]?.[0].input).toMatchObject({
        TransactItems: [
          { Put: { ConditionExpression: "attribute_not_exists(#PK)" } },
          { Put: { ConditionExpression: "#version = :expected", ExpressionAttributeValues: { ":expected": 1 } } }
        ]
      });
    } finally { store.close(); }
  });

  it("classifies only conditional transaction failures as conflicts", async () => {
    vi.stubEnv("DYNAMODB_ENDPOINT", "http://localhost:8000");
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
    const store = new DynamoStore("test-table");
    const writes: StoreWrite[] = [{
      item: { PK: "USER#u", SK: "PROFILE", entity: "profile", version: 1, data: {} }, expectedVersion: null
    }];
    try {
      send.mockRejectedValueOnce({
        name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }]
      });
      await expect(store.transact(writes)).rejects.toBeInstanceOf(StoreConflict);
      for (const error of [
        { name: "TransactionCanceledException" },
        { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] },
        { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "ThrottlingError" }] },
        { name: "AccessDeniedException" }, { name: "ProvisionedThroughputExceededException" },
        new Error("connection lost"), null
      ]) {
        send.mockRejectedValueOnce(error);
        await expect(store.transact(writes)).rejects.toBe(error);
      }
    } finally { store.close(); }
  });

  it.each([
    "https://example.com", "http://localhost.example.com:8000", "http://localhost:8000/private",
    "http://user:password@localhost:8000", "ftp://localhost:8000", "http://localhost:8000?forward=1"
  ])("rejects unsafe local endpoints: %s", (value) => {
    vi.stubEnv("DYNAMODB_ENDPOINT", value);
    expect(() => new DynamoStore("test-table")).toThrow(/localhost/);
  });
});
