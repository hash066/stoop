// DynamoDB twins of MemoryStore and the spent-token store (Kiro task 8). Single table, string key
// `pk`; each item holds the JSON document in `doc` and, when the value has one, its `version` in
// `ver` so `ifVersion` becomes a server-side condition.
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type Put,
} from "@aws-sdk/client-dynamodb";
import type { SpentTokenStore } from "@stoop/policy";
import type { Store, WriteOp } from "../infra.ts";

type Item = Record<string, AttributeValue>;

function toPut(table: string, op: WriteOp): Put {
  const version = (op.value as { version?: unknown } | null)?.version;
  const Item: Item = { pk: { S: op.key }, doc: { S: JSON.stringify(op.value) } };
  if (typeof version === "number") Item.ver = { N: String(version) };
  const conds: string[] = [];
  const values: Item = {};
  if (op.ifAbsent) conds.push("attribute_not_exists(pk)");
  if (op.ifVersion !== undefined) {
    conds.push("ver = :v");
    values[":v"] = { N: String(op.ifVersion) };
  }
  return {
    TableName: table,
    Item,
    ...(conds.length ? { ConditionExpression: conds.join(" AND ") } : {}),
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  };
}

export class DynamoStore implements Store {
  constructor(
    private readonly ddb: DynamoDBClient,
    private readonly table: string,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const r = await this.ddb.send(new GetItemCommand({ TableName: this.table, Key: { pk: { S: key } }, ConsistentRead: true }));
    const doc = r.Item?.doc?.S;
    return doc === undefined ? undefined : (JSON.parse(doc) as T);
  }

  async put(key: string, value: unknown, cond: Omit<WriteOp, "key" | "value"> = {}): Promise<boolean> {
    try {
      await this.ddb.send(new PutItemCommand(toPut(this.table, { key, value, ...cond })));
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }

  async transact(ops: WriteOp[]): Promise<boolean> {
    if (ops.length === 0) return true;
    if (ops.length === 1) return this.put(ops[0]!.key, ops[0]!.value, ops[0]!);
    try {
      await this.ddb.send(new TransactWriteItemsCommand({ TransactItems: ops.map((op) => ({ Put: toPut(this.table, op) })) }));
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException && e.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")) return false;
      throw e;
    }
  }

  /** Scan + begins_with, sorted by key. Fine at demo scale; time-ordered keys (decision#) stay ordered. */
  async list<T>(prefix: string): Promise<T[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const r = await this.ddb.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "begins_with(pk, :p)",
          ExpressionAttributeValues: { ":p": { S: prefix } },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return items
      .filter((i) => i.doc?.S !== undefined)
      .sort((a, b) => (a.pk!.S! < b.pk!.S! ? -1 : a.pk!.S! > b.pk!.S! ? 1 : 0))
      .map((i) => JSON.parse(i.doc!.S!) as T);
  }

  async delete(key: string): Promise<void> {
    await this.ddb.send(new DeleteItemCommand({ TableName: this.table, Key: { pk: { S: key } } }));
  }
}

/** Single-use capability tokens: a conditional put that succeeds only the first time; TTL cleans up. */
export class DynamoSpentTokenStore implements SpentTokenStore {
  constructor(
    private readonly ddb: DynamoDBClient,
    private readonly table: string,
  ) {}

  async markUsed(tid: string, expiresAt: number): Promise<boolean> {
    try {
      await this.ddb.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { pk: { S: `spent#${tid}` }, ttl: { N: String(Math.ceil(expiresAt / 1000) + 3600) } },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }
}
