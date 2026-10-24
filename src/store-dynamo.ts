import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  decodeCursor, encodeCursor, queryLimit, StoreConflict, validateWrites,
  type Store, type StoreItem, type StoreQuery, type StoreWrite
} from "./store.js";

export class DynamoStore implements Store {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName = process.env.TABLE_NAME) {
    if (!tableName) throw new Error("TABLE_NAME is required for DynamoDB storage.");
    this.tableName = tableName;
    const endpoint = process.env.DYNAMODB_ENDPOINT;
    if (endpoint) {
      const url = new URL(endpoint);
      if (!["http:", "https:"].includes(url.protocol) ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("DYNAMODB_ENDPOINT must be a localhost HTTP(S) endpoint without credentials or a path.");
      }
    }
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(endpoint ? {
        endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" }
      } : {})
    }));
  }

  async get(PK: string, SK: string): Promise<StoreItem | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { PK, SK }, ConsistentRead: true
    }));
    return result.Item as StoreItem | undefined;
  }

  async query(PK: string, options: StoreQuery): Promise<{ items: StoreItem[]; cursor?: string }> {
    const limit = queryLimit(options);
    const cursor = decodeCursor(PK, options);
    const names: Record<string, string> = { "#PK": "PK", "#SK": "SK" };
    const values: Record<string, unknown> = { ":PK": PK };
    let condition = "#PK = :PK";
    if (options.from !== undefined && options.to !== undefined) {
      condition += " AND #SK BETWEEN :from AND :to";
      values[":from"] = options.from;
      values[":to"] = options.to;
    } else if (options.from !== undefined) {
      condition += " AND #SK >= :from";
      values[":from"] = options.from;
    } else if (options.to !== undefined) {
      condition += " AND #SK <= :to";
      values[":to"] = options.to;
    } else if (options.prefix !== undefined && options.prefix !== "") {
      condition += " AND begins_with(#SK, :prefix)";
      values[":prefix"] = options.prefix;
    } else {
      delete names["#SK"];
    }
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConsistentRead: true,
      Limit: limit,
      ...(cursor !== undefined ? { ExclusiveStartKey: { PK, SK: cursor } } : {})
    }));
    // DynamoDB allows only one sort-key condition. Keep pagination even if a
    // bounded page contains no keys matching the additional prefix.
    const items = (result.Items ?? []) as StoreItem[];
    const SK = result.LastEvaluatedKey?.SK as string | undefined;
    return {
      items: options.prefix === undefined ? items : items.filter((item) => item.SK.startsWith(options.prefix!)),
      ...(SK !== undefined ? { cursor: encodeCursor(PK, SK, options) } : {})
    };
  }

  async transact(writes: StoreWrite[]): Promise<void> {
    validateWrites(writes);
    if (writes.length === 0) return;
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: writes.map(({ item, expectedVersion }) => ({
          Put: {
            TableName: this.tableName,
            Item: item,
            ConditionExpression: expectedVersion === null
              ? "attribute_not_exists(#PK)" : "#version = :expected",
            ExpressionAttributeNames: expectedVersion === null ? { "#PK": "PK" } : { "#version": "version" },
            ...(expectedVersion === null ? {} : { ExpressionAttributeValues: { ":expected": expectedVersion } })
          }
        }))
      }));
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      const reasons = failure?.CancellationReasons ?? [];
      if (failure?.name === "ConditionalCheckFailedException" ||
          (failure?.name === "TransactionCanceledException" &&
           reasons.some((reason) => reason.Code === "ConditionalCheckFailed") &&
           reasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed"))) {
        throw new StoreConflict();
      }
      throw error;
    }
  }

  close(): void { this.client.destroy(); }
}
