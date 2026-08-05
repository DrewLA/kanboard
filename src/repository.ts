import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";

import { AppConfig } from "./config";
import { deriveAddress, signMutationEnvelope, verifyMutationEnvelope } from "./identity";
import { decryptPrivateKey, fileExists, readIdentityFile } from "./identity-store";
import { BoardNodeType, Notification, NotificationSourceType, RecycleBinEntry, WorkItemType, createEmptyTaskboardDocument, normalizeTaskboardDocument, TaskboardDocument, nowIso } from "./model";
import {
  PackageDiff,
  RecordRef,
  RecordVersionRef,
  StatePackage,
  TableName,
  UserRecord,
  applyPackageChanges,
  cloneStatePackage,
  createEmptyStatePackage,
  diffDocuments,
  encodeRowsToHashFields,
  encodeTableMeta,
  getRecordVersion,
  normalizeStatePackage,
  statePackageFromDocument,
  statePackageToDocument,
  tableFromHashFields,
  tableNames,
  uniqueRecordRefs
} from "./state-package";

const LOCAL_LOCK_RETRIES = 20;
const LOCAL_LOCK_DELAY_MS = 10;

export class RepositoryConflictError extends Error {
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly operation: string;
  readonly conflicts: RecordVersionRef[];

  constructor(currentRevision: number, expectedRevision: number, operation = "save the kanboard document", conflicts: RecordVersionRef[] = []) {
    super(
      `Document revision mismatch while trying to ${operation}. ` +
      `Expected revision ${expectedRevision}, but storage currently has revision ${currentRevision}.`
    );
    this.name = "RepositoryConflictError";
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
    this.operation = operation;
    this.conflicts = conflicts;
  }
}

export type RepositoryAccessErrorCode =
  | "KB_IDENTITY_LOCKED"
  | "KB_IDENTITY_SETUP_REQUIRED"
  | "KB_IDENTITY_NOT_REGISTERED"
  | "KB_IDENTITY_FILE_MISMATCH";

export class RepositoryAccessError extends Error {
  readonly code: RepositoryAccessErrorCode;
  readonly recovery: string;

  constructor(code: RepositoryAccessErrorCode, message: string, recovery: string) {
    super(message);
    this.name = "RepositoryAccessError";
    this.code = code;
    this.recovery = recovery;
  }
}

export class TeamBoardEmptyError extends Error {
  constructor() {
    super("Team board database is empty.");
    this.name = "TeamBoardEmptyError";
  }
}

export interface LoadTaskboardOptions {
  onCreate?: (document: TaskboardDocument) => void | Promise<void>;
}

export interface SaveTaskboardOptions {
  operation?: string;
  scopes?: string[];
  summary?: string;
}

export interface IdentityStatus {
  required: boolean;
  unlocked: boolean;
  address?: string;
  registered?: boolean;
}

export interface TaskboardRepository {
  load(options?: LoadTaskboardOptions): Promise<TaskboardDocument>;
  save(document: TaskboardDocument, expectedRevision: number, options?: SaveTaskboardOptions): Promise<TaskboardDocument>;
  getRevision?(): Promise<number>;
  listUsers?(): Promise<UserRecord[]>;
  getCurrentUser?(): Promise<UserRecord | null>;
  getIdentityStatus?(): Promise<IdentityStatus>;
  unlockIdentity?(password: string): Promise<IdentityStatus>;
  listNotifications?(userId: string): Promise<Notification[]>;
  createNotifications?(notifications: Notification[]): Promise<void>;
  deleteNotificationsBySource?(sourceId: string): Promise<void>;
  deleteNodeNotifications?(nodeId: string): Promise<void>;
  readNodeNotifications?(userId: string, nodeId: string, sourceType?: NotificationSourceType): Promise<void>;
  listRecycleBin?(): Promise<RecycleBinEntry[]>;
  addToRecycleBin?(entries: RecycleBinEntry[]): Promise<void>;
  removeFromRecycleBin?(entryIds: string[]): Promise<void>;
  emptyRecycleBin?(): Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseRevision(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

function describeRedisResponse(result: unknown): string {
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function parseCompareAndSetResult(result: unknown): { ok: boolean; currentRevision: number } {
  let payload = result;

  if (typeof result === "string") {
    try {
      payload = JSON.parse(result) as unknown;
    } catch {
      throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
    }
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
  }

  const record = payload as { ok?: unknown; currentRevision?: unknown; currentVersion?: unknown };

  if (typeof record.ok !== "boolean") {
    throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
  }

  return {
    ok: record.ok,
    currentRevision: parseRevision(record.currentRevision ?? record.currentVersion)
  };
}

interface LoadedDocumentState {
  document: TaskboardDocument;
  statePackage: StatePackage;
}

// A single row touched by a commit: an upsert (value read from nextPackage) or a
// deletion. The adapter writes only these rows plus the meta of the tables they
// belong to, never the whole table.
export interface RowChange {
  table: TableName;
  id: string;
  deleted?: boolean;
}

interface StateStorageAdapter {
  loadPackage(): Promise<StatePackage>;
  getVersionToken(statePackage?: StatePackage): Promise<string>;
  commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], rowChanges: RowChange[]): Promise<void>;
  replacePackage(nextPackage: StatePackage): Promise<void>;
}

function changedTablesFromRowChanges(rowChanges: RowChange[]): Set<TableName> {
  return new Set(rowChanges.map((change) => change.table));
}

function isStatePackageEmpty(statePackage: StatePackage): boolean {
  return tableNames.every((tableName) => Object.keys(statePackage.tables[tableName].rows).length === 0);
}

function tableFileName(tableName: TableName): string {
  return `${tableName}.json`;
}

class LocalStatePackageAdapter implements StateStorageAdapter {
  constructor(private readonly directory: string) {}

  async loadPackage(): Promise<StatePackage> {
    const nextPackage = createEmptyStatePackage();

    await Promise.all(tableNames.map(async (tableName) => {
      const filePath = path.join(this.directory, tableFileName(tableName));
      try {
        const raw = await readFile(filePath, "utf8");
        nextPackage.tables[tableName] = normalizeStatePackage({ tables: { [tableName]: JSON.parse(raw) } }).tables[tableName] as never;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }));

    return nextPackage;
  }

  async getVersionToken(): Promise<string> {
    const versions = await Promise.all(tableNames.map(async (tableName) => {
      try {
        const info = await stat(path.join(this.directory, tableFileName(tableName)));
        return `${tableName}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return `${tableName}:missing`;
        }
        throw error;
      }
    }));

    return versions.join("|");
  }

  async commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], rowChanges: RowChange[]): Promise<void> {
    await this.withPackageLock(async () => {
      const currentPackage = await this.loadPackage();
      assertRecordVersions(currentPackage, conditions, "commit local state package");
      // Local disk has no per-row size or script-time limit, so keep writing whole
      // table files; just derive which tables changed from the row-level changes.
      await this.writePackageTables(nextPackage, changedTablesFromRowChanges(rowChanges));
    });
  }

  async replacePackage(nextPackage: StatePackage): Promise<void> {
    await this.withPackageLock(async () => {
      await this.writePackageTables(nextPackage, new Set(tableNames));
    });
  }

  private async writePackageTables(nextPackage: StatePackage, changedTables: Set<TableName>): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    for (const tableName of changedTables) {
      const filePath = path.join(this.directory, tableFileName(tableName));
      const tempPath = `${filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(nextPackage.tables[tableName], null, 2), "utf8");
      await rename(tempPath, filePath);
    }
  }

  private async withPackageLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.directory, ".state.lock");
    await mkdir(this.directory, { recursive: true });

    for (let attempt = 0; attempt < LOCAL_LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");

        try {
          return await callback();
        } finally {
          await handle.close();
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === LOCAL_LOCK_RETRIES - 1) {
          throw error;
        }

        await delay(LOCAL_LOCK_DELAY_MS);
      }
    }

    throw new Error("Failed to acquire modular state package lock.");
  }
}

interface ParsedUpstashDbString {
  url: string;
  token: string;
  prefix: string;
}

export function parseDbString(dbString: string): ParsedUpstashDbString {
  const [scheme, ...parts] = dbString.split(";");

  if (scheme !== "upstash") {
    throw new Error(`Unsupported TASKBOARD_DB_STRING scheme ${scheme}. Expected upstash;url=...;token=...;prefix=...`);
  }

  const values = Object.fromEntries(parts.map((part) => {
    const [key, ...rawValue] = part.split("=");
    return [key, decodeURIComponent(rawValue.join("="))];
  }));

  if (!values.url || !values.token) {
    throw new Error("Upstash TASKBOARD_DB_STRING must include url and token.");
  }

  return {
    url: values.url,
    token: values.token,
    prefix: values.prefix || "kanboard:main"
  };
}

class UpstashStatePackageAdapter implements StateStorageAdapter {
  private readonly redis: Redis;
  private readonly prefix: string;

  // Each table is a Redis hash of rows (field id -> VersionedRecord JSON). The
  // commit script reads only the individual rows it needs to version-check and
  // writes only the rows that changed, so cost is O(changed rows) instead of
  // O(whole table) — which is what tripped Upstash's Lua execution-time limit.
  //
  // KEYS are laid out two-per-table: [rowsKey, metaKey, rowsKey, metaKey, ...].
  // ARGV: [1]=conditions, [2]=row writes, [3]=table meta writes.
  private readonly commitScript = `
local conditions = cjson.decode(ARGV[1])
local writes = cjson.decode(ARGV[2])
local metas = cjson.decode(ARGV[3])

for _, condition in ipairs(conditions) do
  local rowJson = redis.call("HGET", KEYS[condition.keyIndex], condition.id)
  local currentVersion = 0

  if rowJson then
    currentVersion = tonumber(cjson.decode(rowJson).version) or 0
  end

  if currentVersion ~= tonumber(condition.version) then
    return cjson.encode({
      ok = false,
      table = condition.table,
      id = condition.id,
      currentVersion = currentVersion,
      expectedVersion = condition.version
    })
  end
end

for _, write in ipairs(writes) do
  if write.deleted then
    redis.call("HDEL", KEYS[write.keyIndex], write.id)
  else
    redis.call("HSET", KEYS[write.keyIndex], write.id, write.value)
  end
end

for _, meta in ipairs(metas) do
  redis.call("SET", KEYS[meta.keyIndex], meta.value)
end

return cjson.encode({ ok = true })
`;

  constructor(dbString: string) {
    const parsed = parseDbString(dbString);
    this.prefix = parsed.prefix;
    this.redis = new Redis({
      url: parsed.url,
      token: parsed.token,
      automaticDeserialization: false
    });
  }

  async loadPackage(): Promise<StatePackage> {
    const nextPackage = createEmptyStatePackage();
    const pipeline = this.redis.pipeline();

    for (const tableName of tableNames) {
      pipeline.hgetall(this.tableKey(tableName));
      pipeline.get(this.metaKey(tableName));
    }

    const results = await pipeline.exec() as unknown[];

    tableNames.forEach((tableName, index) => {
      const fields = results[index * 2];
      const metaRaw = results[index * 2 + 1];
      const metaValue = typeof metaRaw === "string"
        ? metaRaw
        : metaRaw == null
          ? undefined
          : JSON.stringify(metaRaw);
      const table = tableFromHashFields(fields, metaValue);
      nextPackage.tables[tableName] = normalizeStatePackage({
        tables: { [tableName]: table }
      }).tables[tableName] as never;
    });

    return nextPackage;
  }

  async getVersionToken(statePackage?: StatePackage): Promise<string> {
    if (statePackage) {
      return tableNames.map((tableName) => encodeTableMeta(statePackage.tables[tableName])).join("|");
    }

    const metaValues = await this.redis.mget<(string | null)[]>(...tableNames.map((tableName) => this.metaKey(tableName)));
    return metaValues.map((value) => value ?? "missing").join("|");
  }

  async commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], rowChanges: RowChange[]): Promise<void> {
    const changedTables = [...changedTablesFromRowChanges(rowChanges)];
    const keyTableList = [...new Set([...changedTables, ...conditions.map((condition) => condition.table)])];

    const keys: string[] = [];
    const rowKeyIndex = new Map<TableName, number>();
    const metaKeyIndex = new Map<TableName, number>();
    for (const tableName of keyTableList) {
      keys.push(this.tableKey(tableName));
      rowKeyIndex.set(tableName, keys.length);
      keys.push(this.metaKey(tableName));
      metaKeyIndex.set(tableName, keys.length);
    }

    const serializedConditions = conditions
      .map((condition) => ({ ...condition, keyIndex: rowKeyIndex.get(condition.table) }))
      .filter((condition): condition is RecordVersionRef & { keyIndex: number } => typeof condition.keyIndex === "number");

    const writes = rowChanges.map((change) => {
      const keyIndex = rowKeyIndex.get(change.table) as number;
      if (change.deleted) {
        return { keyIndex, id: change.id, deleted: true };
      }
      return { keyIndex, id: change.id, value: JSON.stringify(nextPackage.tables[change.table].rows[change.id]) };
    });

    const metas = changedTables.map((tableName) => ({
      keyIndex: metaKeyIndex.get(tableName) as number,
      value: encodeTableMeta(nextPackage.tables[tableName])
    }));

    const args = [
      JSON.stringify(serializedConditions),
      JSON.stringify(writes),
      JSON.stringify(metas)
    ];
    const result = await this.redis.eval<string[], unknown>(this.commitScript, keys, args);
    const payload = parseCompareAndSetResult(result);

    if (!payload.ok) {
      throw new RepositoryConflictError(payload.currentRevision, 0, "commit team state package", conditions);
    }
  }

  async replacePackage(nextPackage: StatePackage): Promise<void> {
    for (const tableName of tableNames) {
      const table = nextPackage.tables[tableName];
      const fields = encodeRowsToHashFields(table);
      const pipeline = this.redis.pipeline();
      // Drop whatever is at the key first so a legacy string blob or stale rows
      // are fully replaced by the fresh hash.
      pipeline.del(this.tableKey(tableName));
      if (Object.keys(fields).length > 0) {
        pipeline.hset(this.tableKey(tableName), fields);
      }
      pipeline.set(this.metaKey(tableName), encodeTableMeta(table));
      await pipeline.exec();
    }
  }

  private tableKey(tableName: TableName): string {
    return `${this.prefix}:table:${tableName}`;
  }

  private metaKey(tableName: TableName): string {
    return `${this.prefix}:meta:${tableName}`;
  }
}

function scopeToRecordRefs(scope: string): RecordRef[] {
  const [kind, type, id] = scope.split(":");

  if (scope === "board-brief") {
    return [{ table: "boardBrief", id: "main" }];
  }

  if (kind === "node" && type && id) {
    const tableByType: Record<BoardNodeType, TableName> = {
      epic: "epics",
      feature: "features",
      story: "userStories",
      task: "tasks"
    };
    return [{ table: tableByType[type as BoardNodeType], id }];
  }

  if (kind === "children" && type && id) {
    const tableByType: Record<"epic" | "feature" | "story", TableName> = {
      epic: "epics",
      feature: "features",
      story: "userStories"
    };
    return [{ table: tableByType[type as "epic" | "feature" | "story"], id }];
  }

  if (kind === "comment" && type) {
    return [{ table: "comments", id: type }];
  }

  if (kind === "comments" && type && id) {
    const tableByType: Record<BoardNodeType, TableName> = {
      epic: "epics",
      feature: "features",
      story: "userStories",
      task: "tasks"
    };
    return [{ table: tableByType[type as BoardNodeType], id }];
  }

  if (kind === "link" && type) {
    return [{ table: "links", id: type }];
  }

  if (kind === "links" && type && id) {
    const tableByType: Partial<Record<WorkItemType, TableName>> = {
      feature: "features",
      task: "tasks"
    };
    const table = tableByType[type as WorkItemType];
    return table ? [{ table, id }] : [];
  }

  return [];
}

function diffToRecordRefs(diff: PackageDiff): RecordRef[] {
  return diff.changes
    .filter((change) => change.table !== "metadata")
    .map((change) => ({ table: change.table, id: change.id }));
}

function assertRecordVersions(statePackage: StatePackage, conditions: RecordVersionRef[], operation: string): void {
  const conflicts = conditions.filter((condition) => getRecordVersion(statePackage, condition) !== condition.version);

  if (conflicts.length > 0) {
    const first = conflicts[0];
    throw new RepositoryConflictError(getRecordVersion(statePackage, first), first.version, operation, conflicts);
  }
}

function buildConditions(baselinePackage: StatePackage, refs: RecordRef[]): RecordVersionRef[] {
  return uniqueRecordRefs(refs).map((ref) => ({
    ...ref,
    version: getRecordVersion(baselinePackage, ref)
  }));
}

function metadataProjectId(statePackage: StatePackage): string {
  return statePackage.tables.metadata.rows.project?.value.projectId ?? "local-private-board";
}

class ModularTaskboardRepository implements TaskboardRepository {
  private readonly documentState = new WeakMap<TaskboardDocument, LoadedDocumentState>();
  private cachedPackage?: StatePackage;
  private cachedVersionToken?: string;
  private cacheCheckedAt = 0;
  private refreshPromise?: Promise<StatePackage>;

  constructor(
    private readonly primary: StateStorageAdapter,
    private readonly options: {
      mode: AppConfig["mode"];
      localMirror?: StateStorageAdapter;
      actorPrivateKey?: string;
      identityFile?: string;
      privateUsername: string;
      onChanged?: () => void;
    }
  ) {}

  private async cachePackage(
    statePackage: StatePackage,
    mirrorChanges?: RowChange[]
  ): Promise<StatePackage> {
    this.cachedPackage = statePackage;
    this.cachedVersionToken = await this.primary.getVersionToken(statePackage);
    this.cacheCheckedAt = Date.now();

    if (this.options.localMirror) {
      if (mirrorChanges) {
        await this.options.localMirror.commitPackage(statePackage, [], mirrorChanges);
      } else {
        await this.options.localMirror.replacePackage(statePackage);
      }
    }

    return statePackage;
  }

  private async currentPackage(forceVersionCheck = false): Promise<StatePackage> {
    const cacheIsFresh = Date.now() - this.cacheCheckedAt < 1_000;
    if (this.cachedPackage && cacheIsFresh && !forceVersionCheck) {
      return this.cachedPackage;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      if (this.cachedPackage) {
        const versionToken = await this.primary.getVersionToken();
        this.cacheCheckedAt = Date.now();

        if (versionToken === this.cachedVersionToken) {
          return this.cachedPackage;
        }
      }

      return this.cachePackage(await this.primary.loadPackage());
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async commitPackage(
    nextPackage: StatePackage,
    conditions: RecordVersionRef[],
    rowChanges: RowChange[]
  ): Promise<void> {
    await this.primary.commitPackage(nextPackage, conditions, rowChanges);
    await this.cachePackage(nextPackage, rowChanges);
  }

  async load(loadOptions: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    let statePackage = await this.currentPackage();

    if (isStatePackageEmpty(statePackage)) {
      if (this.options.mode === "team") {
        throw new TeamBoardEmptyError();
      }

      await loadOptions.onCreate?.(createEmptyTaskboardDocument());
      statePackage = statePackageFromDocument(createEmptyTaskboardDocument());
      await this.ensurePrivateUser(statePackage);
      await this.primary.replacePackage(statePackage);
      await this.cachePackage(statePackage);
    }

    const document = statePackageToDocument(statePackage);
    this.documentState.set(document, {
      document: normalizeTaskboardDocument(document),
      statePackage
    });
    return document;
  }

  async save(document: TaskboardDocument, _expectedRevision: number, saveOptions: SaveTaskboardOptions = {}): Promise<TaskboardDocument> {
    const baseline = this.documentState.get(document);

    if (!baseline) {
      throw new Error("Cannot save a kanboard document that was not loaded by this repository instance.");
    }

    const latestPackage = await this.currentPackage(true);
    const diff = diffDocuments(baseline.document, document);

    if (diff.changes.length === 0) {
      return document;
    }

    const scopedRefs = (saveOptions.scopes ?? []).flatMap(scopeToRecordRefs);
    const changedRefs = diffToRecordRefs(diff);
    const indexRefs = diff.changedTables.has("indexes") ? [{ table: "indexes" as const, id: "main" }] : [];
    const conditions = buildConditions(baseline.statePackage, [...scopedRefs, ...changedRefs, ...indexRefs]);
    assertRecordVersions(latestPackage, conditions, saveOptions.operation ?? saveOptions.summary ?? "commit kanboard mutation");

    const mutation = await this.buildMutation(latestPackage, conditions, saveOptions.summary ?? saveOptions.operation ?? "Kanboard mutation.");
    const nextPackage = applyPackageChanges(latestPackage, diff, mutation);
    // applyPackageChanges always bumps the metadata "project" row, so include it
    // alongside the document's row-level changes.
    const rowChanges: RowChange[] = [
      ...diff.changes.map((change) => ({ table: change.table, id: change.id, deleted: change.deleted })),
      { table: "metadata", id: "project" }
    ];

    await this.commitPackage(nextPackage, conditions, rowChanges);
    this.options.onChanged?.();

    this.documentState.set(document, {
      document: normalizeTaskboardDocument(document),
      statePackage: nextPackage
    });

    return document;
  }

  async listUsers(): Promise<UserRecord[]> {
    const statePackage = await this.currentPackage();
    return Object.values(statePackage.tables.users.rows)
      .map((row) => row.value)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getRevision(): Promise<number> {
    const statePackage = await this.currentPackage();
    return statePackage.tables.metadata.rows.project?.value.revision ?? 0;
  }

  async getCurrentUser(): Promise<UserRecord | null> {
    const statePackage = await this.currentPackage();

    if (this.options.mode === "team") {
      const actorPrivateKey = await this.getActorPrivateKey();

      if (!actorPrivateKey) {
        return null;
      }

      return statePackage.tables.users.rows[deriveAddress(actorPrivateKey)]?.value ?? null;
    }

    return statePackage.tables.users.rows.private?.value ?? null;
  }

  async listNotifications(userId: string): Promise<Notification[]> {
    const pkg = await this.currentPackage();
    return Object.values(pkg.tables.notifications.rows)
      .map((row) => row.value)
      .filter((n) => n.recipientId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createNotifications(notifications: Notification[]): Promise<void> {
    if (!notifications.length) return;
    const pkg = await this.currentPackage(true);
    const next = cloneStatePackage(pkg);
    const timestamp = nowIso();
    for (const n of notifications) {
      next.tables.notifications.rows[n.id] = { version: 1, value: n };
      next.tables.notifications.version += 1;
    }
    next.tables.notifications.updatedAt = timestamp;
    await this.commitPackage(next, [], notifications.map((n) => ({ table: "notifications", id: n.id })));
  }

  async deleteNotificationsBySource(sourceId: string): Promise<void> {
    const pkg = await this.currentPackage(true);
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => row.value.sourceId === sourceId)
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.commitPackage(next, [], ids.map((id) => ({ table: "notifications", id, deleted: true })));
  }

  async deleteNodeNotifications(nodeId: string): Promise<void> {
    const pkg = await this.currentPackage(true);
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => row.value.nodeId === nodeId)
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.commitPackage(next, [], ids.map((id) => ({ table: "notifications", id, deleted: true })));
  }

  async readNodeNotifications(userId: string, nodeId: string, sourceType?: NotificationSourceType): Promise<void> {
    const pkg = await this.currentPackage(true);
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => {
        if (row.value.recipientId !== userId || row.value.nodeId !== nodeId) return false;
        if (sourceType && row.value.sourceType !== sourceType) return false;
        return true;
      })
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.commitPackage(next, [], ids.map((id) => ({ table: "notifications", id, deleted: true })));
  }

  async listRecycleBin(): Promise<RecycleBinEntry[]> {
    const pkg = await this.currentPackage();
    return Object.values(pkg.tables.recycleBin.rows)
      .map((row) => row.value)
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async addToRecycleBin(entries: RecycleBinEntry[]): Promise<void> {
    if (!entries.length) return;
    const pkg = await this.currentPackage(true);
    const next = cloneStatePackage(pkg);
    const timestamp = nowIso();
    for (const entry of entries) {
      next.tables.recycleBin.rows[entry.id] = { version: 1, value: entry };
      next.tables.recycleBin.version += 1;
    }
    next.tables.recycleBin.updatedAt = timestamp;
    await this.commitPackage(next, [], entries.map((entry) => ({ table: "recycleBin", id: entry.id })));
  }

  async removeFromRecycleBin(entryIds: string[]): Promise<void> {
    if (!entryIds.length) return;
    const pkg = await this.currentPackage(true);
    const next = cloneStatePackage(pkg);
    const removed: string[] = [];
    for (const id of entryIds) {
      if (next.tables.recycleBin.rows[id]) {
        delete next.tables.recycleBin.rows[id];
        removed.push(id);
      }
    }
    if (!removed.length) return;
    next.tables.recycleBin.version += 1;
    next.tables.recycleBin.updatedAt = nowIso();
    await this.commitPackage(next, [], removed.map((id) => ({ table: "recycleBin", id, deleted: true })));
  }

  async emptyRecycleBin(): Promise<void> {
    const pkg = await this.currentPackage(true);
    const ids = Object.keys(pkg.tables.recycleBin.rows);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    next.tables.recycleBin.rows = {};
    next.tables.recycleBin.version += 1;
    next.tables.recycleBin.updatedAt = nowIso();
    await this.commitPackage(next, [], ids.map((id) => ({ table: "recycleBin", id, deleted: true })));
  }

  async getIdentityStatus(): Promise<IdentityStatus> {
    if (this.options.mode !== "team") {
      return {
        required: false,
        unlocked: true
      };
    }

    const actorPrivateKey = await this.getActorPrivateKey();

    if (actorPrivateKey) {
      const statePackage = await this.currentPackage();
      const actor = deriveAddress(actorPrivateKey);

      return {
        required: true,
        unlocked: true,
        address: actor,
        registered: Boolean(statePackage.tables.users.rows[actor])
      };
    }

    if (!this.options.identityFile || !(await fileExists(this.options.identityFile))) {
      return {
        required: true,
        unlocked: false
      };
    }

    const identityFile = await readIdentityFile(this.options.identityFile);
    const statePackage = await this.currentPackage();

    return {
      required: true,
      unlocked: false,
      address: identityFile.address,
      registered: Boolean(statePackage.tables.users.rows[identityFile.address])
    };
  }

  async unlockIdentity(password: string): Promise<IdentityStatus> {
    const actorPrivateKey = await this.resolveActorPrivateKey(password);

    if (!actorPrivateKey) {
      throw new RepositoryAccessError(
        "KB_IDENTITY_SETUP_REQUIRED",
        "Kanboard identity is not configured.",
        "The board owner must complete identity onboarding and unlock the board in the Kanboard UI. Notify the user and stop attempting writes — agents cannot perform setup."
      );
    }

    const statePackage = await this.currentPackage(true);
    const actor = deriveAddress(actorPrivateKey);

    if (!statePackage.tables.users.rows[actor]) {
      throw new RepositoryAccessError(
        "KB_IDENTITY_NOT_REGISTERED",
        `Team board user ${actor} is not registered.`,
        "Send this address to the team admin and ask them to add it to the users table, then retry."
      );
    }

    return {
      required: true,
      unlocked: true,
      address: actor,
      registered: true
    };
  }

  private async ensurePrivateUser(statePackage: StatePackage): Promise<void> {
    if (this.options.mode === "team") {
      return;
    }

    const users = statePackage.tables.users;

    if (Object.keys(users.rows).length > 0) {
      return;
    }

    const timestamp = nowIso();
    users.rows.private = {
      version: 1,
      value: {
        id: "private",
        name: this.options.privateUsername,
        role: "owner",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };
    users.version += 1;
    users.updatedAt = timestamp;
  }

  private async getActorPrivateKey(): Promise<string | undefined> {
    if (this.options.actorPrivateKey) {
      return this.options.actorPrivateKey;
    }

    return undefined;
  }

  private async resolveActorPrivateKey(password?: string): Promise<string | undefined> {
    if (this.options.actorPrivateKey) {
      return this.options.actorPrivateKey;
    }

    if (!this.options.identityFile || !(await fileExists(this.options.identityFile))) {
      return undefined;
    }

    if (!password) {
      return undefined;
    }

    const identityFile = await readIdentityFile(this.options.identityFile);
    const privateKey = await decryptPrivateKey(identityFile, password);
    const address = deriveAddress(privateKey);

    if (address !== identityFile.address) {
      throw new RepositoryAccessError(
        "KB_IDENTITY_FILE_MISMATCH",
        `Encrypted identity file address ${identityFile.address} does not match decrypted private key address ${address}.`,
        "Recreate local identity with npm run identity:onboard or restore a valid identity file backup."
      );
    }

    this.options.actorPrivateKey = privateKey;
    return privateKey;
  }

  private async buildMutation(
    statePackage: StatePackage,
    readSet: RecordVersionRef[],
    summary: string
  ): Promise<{ actor: string; summary: string; signature: string; occurredAt: string } | undefined> {
    if (this.options.mode !== "team") {
      return undefined;
    }

    const actorPrivateKey = await this.getActorPrivateKey();

    if (!actorPrivateKey) {
      throw new RepositoryAccessError(
        "KB_IDENTITY_LOCKED",
        "Kanboard write access is locked.",
        "The board owner must unlock identity from the Kanboard browser UI before this write can proceed. Notify the user — agents cannot unlock the board and must not call the HTTP API."
      );
    }

    const envelope = await signMutationEnvelope(actorPrivateKey, metadataProjectId(statePackage), {
      nonce: randomUUID(),
      issuedAt: nowIso(),
      summary,
      readSet
    });
    const actor = verifyMutationEnvelope(metadataProjectId(statePackage), envelope);

    return {
      actor,
      summary,
      signature: envelope.signature,
      occurredAt: envelope.issuedAt
    };
  }
}

function hourlyBackupSuffix(date = new Date()): string {
  return date.toISOString().slice(0, 13).replaceAll("-", "").replace("T", "h");
}

function dbStringWithBackupPrefix(dbString: string, suffix: string): string {
  const parsed = parseDbString(dbString);
  return [
    "upstash",
    `url=${encodeURIComponent(parsed.url)}`,
    `token=${encodeURIComponent(parsed.token)}`,
    `prefix=${encodeURIComponent(`${parsed.prefix}:backup:${suffix}`)}`
  ].join(";");
}

function startPrivateBackupScheduler(localAdapter: StateStorageAdapter, dbString: string, intervalMinutes: number): () => void {
  let dirty = false;
  let running = false;

  const runBackup = async (): Promise<void> => {
    if (!dirty || running) {
      return;
    }

    running = true;

    try {
      const statePackage = await localAdapter.loadPackage();
      const backupAdapter = new UpstashStatePackageAdapter(dbStringWithBackupPrefix(dbString, hourlyBackupSuffix()));
      await backupAdapter.replacePackage(statePackage);
      dirty = false;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runBackup().catch((error) => {
      console.error(`Failed to back up private kanboard state: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMinutes * 60 * 1000);
  timer.unref();

  return () => {
    dirty = true;
  };
}

export function createTaskboardRepository(config: AppConfig): TaskboardRepository {
  if (config.mode === "team") {
    if (!config.dbString) {
      throw new Error("TASKBOARD_MODE=team requires TASKBOARD_DB_STRING.");
    }

    return new ModularTaskboardRepository(new UpstashStatePackageAdapter(config.dbString), {
      mode: config.mode,
      localMirror: new LocalStatePackageAdapter(config.stateDir),
      actorPrivateKey: config.evmPrivateKey,
      identityFile: config.identityFile,
      privateUsername: config.privateUsername
    });
  }

  const localAdapter = new LocalStatePackageAdapter(config.stateDir);
  const markChanged = config.mode === "private-backup" && config.dbString
    ? startPrivateBackupScheduler(localAdapter, config.dbString, config.backupIntervalMinutes)
    : undefined;

  return new ModularTaskboardRepository(localAdapter, {
    mode: config.mode,
    privateUsername: config.privateUsername,
    actorPrivateKey: config.evmPrivateKey,
    identityFile: config.identityFile,
    onChanged: markChanged
  });
}
