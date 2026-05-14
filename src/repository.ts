import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";

import { AppConfig, assertRedisConfig } from "./config";
import { deriveAddress, signMutationEnvelope, verifyMutationEnvelope } from "./identity";
import { decryptPrivateKey, fileExists, readIdentityFile } from "./identity-store";
import { BoardNodeType, Notification, RecycleBinEntry, WorkItemType, createEmptyTaskboardDocument, normalizeTaskboardDocument, TaskboardDocument, nowIso } from "./model";
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
  getRecordVersion,
  normalizeStatePackage,
  statePackageFromDocument,
  statePackageToDocument,
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

export class RepositoryDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryDataError";
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
  listUsers?(): Promise<UserRecord[]>;
  getCurrentUser?(): Promise<UserRecord | null>;
  getIdentityStatus?(): Promise<IdentityStatus>;
  unlockIdentity?(password: string): Promise<IdentityStatus>;
  listNotifications?(userId: string): Promise<Notification[]>;
  createNotifications?(notifications: Notification[]): Promise<void>;
  deleteNotificationsBySource?(sourceId: string): Promise<void>;
  deleteNodeNotifications?(nodeId: string): Promise<void>;
  readNodeNotifications?(userId: string, nodeId: string): Promise<void>;
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

function parseStoredDocumentJson(value: string, source: string, recovery: string): TaskboardDocument {
  try {
    return normalizeTaskboardDocument(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new RepositoryDataError(
      `${source} exists but does not contain valid kanboard JSON. ` +
      "The server will not overwrite it automatically. " +
      `${recovery} JSON parse error: ${detail}.`
    );
  }
}

interface LoadedDocumentState {
  document: TaskboardDocument;
  statePackage: StatePackage;
}

interface StateStorageAdapter {
  loadPackage(): Promise<StatePackage>;
  commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], changedTables: Set<TableName>): Promise<void>;
  replacePackage(nextPackage: StatePackage): Promise<void>;
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

  async commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], changedTables: Set<TableName>): Promise<void> {
    await this.withPackageLock(async () => {
      const currentPackage = await this.loadPackage();
      assertRecordVersions(currentPackage, conditions, "commit local state package");
      await this.writePackageTables(nextPackage, changedTables);
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

function parseDbString(dbString: string): ParsedUpstashDbString {
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

  private readonly commitScript = `
local conditions = cjson.decode(ARGV[1])
local changedTables = cjson.decode(ARGV[2])

for _, condition in ipairs(conditions) do
  local tableValue = redis.call("GET", KEYS[condition.keyIndex])
  local currentVersion = 0

  if tableValue then
    local tableDocument = cjson.decode(tableValue)
    local row = tableDocument.rows[condition.id]
    if row then
      currentVersion = tonumber(row.version) or 0
    end
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

for index, tableChange in ipairs(changedTables) do
  redis.call("SET", KEYS[tableChange.keyIndex], ARGV[index + 2])
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

    await Promise.all(tableNames.map(async (tableName) => {
      const raw = await this.redis.get<string | null>(this.tableKey(tableName));

      if (raw === null || raw === undefined) return;

      nextPackage.tables[tableName] = normalizeStatePackage({
        tables: { [tableName]: typeof raw === "string" ? JSON.parse(raw) : raw }
      }).tables[tableName] as never;
    }));

    return nextPackage;
  }

  async commitPackage(nextPackage: StatePackage, conditions: RecordVersionRef[], changedTables: Set<TableName>): Promise<void> {
    const changedTableList = [...changedTables];
    const keyTableList = [...new Set([...changedTableList, ...conditions.map((condition) => condition.table)])];
    const keys = keyTableList.map((tableName) => this.tableKey(tableName));
    const keyIndexes = new Map(keyTableList.map((tableName, index) => [tableName, index + 1]));
    const serializedConditions = conditions.map((condition) => ({
      ...condition,
      keyIndex: keyIndexes.get(condition.table)
    })).filter((condition): condition is RecordVersionRef & { keyIndex: number } => typeof condition.keyIndex === "number");
    const args = [
      JSON.stringify(serializedConditions),
      JSON.stringify(changedTableList.map((tableName) => ({ table: tableName, keyIndex: keyIndexes.get(tableName) }))),
      ...changedTableList.map((tableName) => JSON.stringify(nextPackage.tables[tableName]))
    ];
    const result = await this.redis.eval<string[], unknown>(this.commitScript, keys, args);
    const payload = parseCompareAndSetResult(result);

    if (!payload.ok) {
      throw new RepositoryConflictError(payload.currentRevision, 0, "commit team state package", conditions);
    }
  }

  async replacePackage(nextPackage: StatePackage): Promise<void> {
    for (const tableName of tableNames) {
      await this.redis.set(this.tableKey(tableName), JSON.stringify(nextPackage.tables[tableName]));
    }
  }

  private tableKey(tableName: TableName): string {
    return `${this.prefix}:table:${tableName}`;
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

  async load(loadOptions: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    let statePackage = await this.primary.loadPackage();

    if (isStatePackageEmpty(statePackage)) {
      if (this.options.mode === "team") {
        throw new TeamBoardEmptyError();
      }

      await loadOptions.onCreate?.(createEmptyTaskboardDocument());
      statePackage = statePackageFromDocument(createEmptyTaskboardDocument());
      await this.ensurePrivateUser(statePackage);
      await this.primary.replacePackage(statePackage);
    }

    if (this.options.mode === "team") {
      await this.options.localMirror?.replacePackage(statePackage);
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

    const latestPackage = await this.primary.loadPackage();
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
    const changedTables = new Set<TableName>([...diff.changedTables, "metadata"]);

    await this.primary.commitPackage(nextPackage, conditions, changedTables);
    await this.options.localMirror?.replacePackage(nextPackage);
    this.options.onChanged?.();

    this.documentState.set(document, {
      document: normalizeTaskboardDocument(document),
      statePackage: nextPackage
    });

    return document;
  }

  async listUsers(): Promise<UserRecord[]> {
    const statePackage = await this.primary.loadPackage();
    return Object.values(statePackage.tables.users.rows)
      .map((row) => row.value)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getCurrentUser(): Promise<UserRecord | null> {
    const statePackage = await this.primary.loadPackage();

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
    const pkg = await this.primary.loadPackage();
    return Object.values(pkg.tables.notifications.rows)
      .map((row) => row.value)
      .filter((n) => n.recipientId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createNotifications(notifications: Notification[]): Promise<void> {
    if (!notifications.length) return;
    const pkg = await this.primary.loadPackage();
    const next = cloneStatePackage(pkg);
    const timestamp = nowIso();
    for (const n of notifications) {
      next.tables.notifications.rows[n.id] = { version: 1, value: n };
      next.tables.notifications.version += 1;
    }
    next.tables.notifications.updatedAt = timestamp;
    await this.primary.commitPackage(next, [], new Set(["notifications"]));
  }

  async deleteNotificationsBySource(sourceId: string): Promise<void> {
    const pkg = await this.primary.loadPackage();
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => row.value.sourceId === sourceId)
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.primary.commitPackage(next, [], new Set(["notifications"]));
  }

  async deleteNodeNotifications(nodeId: string): Promise<void> {
    const pkg = await this.primary.loadPackage();
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => row.value.nodeId === nodeId)
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.primary.commitPackage(next, [], new Set(["notifications"]));
  }

  async readNodeNotifications(userId: string, nodeId: string): Promise<void> {
    const pkg = await this.primary.loadPackage();
    const ids = Object.entries(pkg.tables.notifications.rows)
      .filter(([, row]) => row.value.recipientId === userId && row.value.nodeId === nodeId)
      .map(([id]) => id);
    if (!ids.length) return;
    const next = cloneStatePackage(pkg);
    for (const id of ids) delete next.tables.notifications.rows[id];
    next.tables.notifications.version += 1;
    next.tables.notifications.updatedAt = nowIso();
    await this.primary.commitPackage(next, [], new Set(["notifications"]));
  }

  async listRecycleBin(): Promise<RecycleBinEntry[]> {
    const pkg = await this.primary.loadPackage();
    return Object.values(pkg.tables.recycleBin.rows)
      .map((row) => row.value)
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async addToRecycleBin(entries: RecycleBinEntry[]): Promise<void> {
    if (!entries.length) return;
    const pkg = await this.primary.loadPackage();
    const next = cloneStatePackage(pkg);
    const timestamp = nowIso();
    for (const entry of entries) {
      next.tables.recycleBin.rows[entry.id] = { version: 1, value: entry };
      next.tables.recycleBin.version += 1;
    }
    next.tables.recycleBin.updatedAt = timestamp;
    await this.primary.commitPackage(next, [], new Set(["recycleBin"]));
  }

  async removeFromRecycleBin(entryIds: string[]): Promise<void> {
    if (!entryIds.length) return;
    const pkg = await this.primary.loadPackage();
    const next = cloneStatePackage(pkg);
    let touched = false;
    for (const id of entryIds) {
      if (next.tables.recycleBin.rows[id]) {
        delete next.tables.recycleBin.rows[id];
        touched = true;
      }
    }
    if (!touched) return;
    next.tables.recycleBin.version += 1;
    next.tables.recycleBin.updatedAt = nowIso();
    await this.primary.commitPackage(next, [], new Set(["recycleBin"]));
  }

  async emptyRecycleBin(): Promise<void> {
    const pkg = await this.primary.loadPackage();
    if (!Object.keys(pkg.tables.recycleBin.rows).length) return;
    const next = cloneStatePackage(pkg);
    next.tables.recycleBin.rows = {};
    next.tables.recycleBin.version += 1;
    next.tables.recycleBin.updatedAt = nowIso();
    await this.primary.commitPackage(next, [], new Set(["recycleBin"]));
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
      const statePackage = await this.primary.loadPackage();
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
    const statePackage = await this.primary.loadPackage();

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
        `TASKBOARD_MODE=team requires TASKBOARD_EVM_PRIVATE_KEY or encrypted identity file ${this.options.identityFile ?? ".kanboard/identity.json"}.`,
        "Run npm run identity:onboard. Then unlock identity with /api/identity/unlock (or set TASKBOARD_EVM_PRIVATE_KEY) before retrying team writes."
      );
    }

    const statePackage = await this.primary.loadPackage();
    const actor = deriveAddress(actorPrivateKey);

    if (!statePackage.tables.users.rows[actor]) {
      throw new RepositoryAccessError(
        "KB_IDENTITY_NOT_REGISTERED",
        `Team board user ${actor} is not registered.`,
        "Send this address to the team admin and ask them to add it to the users table, then retry."
      );
    }

    await this.options.localMirror?.replacePackage(statePackage);

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
        "Team mutations are locked until identity is unlocked.",
        "Unlock identity with /api/identity/unlock (or configure TASKBOARD_EVM_PRIVATE_KEY), then retry the MCP write call."
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

export class UpstashRedisTaskboardRepository implements TaskboardRepository {
  private readonly redis: Redis;
  private readonly compareAndSetScript = `
local current = redis.call("GET", KEYS[1])
local expectedRevision = tonumber(ARGV[1])
local nextValue = ARGV[2]

if not current then
  if expectedRevision ~= 0 then
    return cjson.encode({ ok = false, currentRevision = 0 })
  end

  redis.call("SET", KEYS[1], nextValue)
  return cjson.encode({ ok = true, currentRevision = 0 })
end

local currentDocument = cjson.decode(current)
local currentRevision = tonumber(currentDocument.revision) or 0

if currentRevision ~= expectedRevision then
  return cjson.encode({ ok = false, currentRevision = currentRevision })
end

redis.call("SET", KEYS[1], nextValue)
return cjson.encode({ ok = true, currentRevision = currentRevision })
`;

  constructor(
    private readonly redisUrl: string,
    private readonly redisToken: string,
    private readonly redisKey: string
  ) {
    this.redis = new Redis({
      url: redisUrl,
      token: redisToken,
      automaticDeserialization: false
    });
  }

  async load(options: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    const value = await this.redis.get<string | null>(this.redisKey);

    if (value === null || value === undefined) {
      const initial = createEmptyTaskboardDocument();
      await options.onCreate?.(initial);
      await this.save(initial, 0, { operation: "create the initial Upstash kanboard" });
      return initial;
    }

    if (typeof value !== "string") {
      return normalizeTaskboardDocument(value);
    }

    return parseStoredDocumentJson(
      value,
      `Upstash Redis key "${this.redisKey}"`,
      "Back it up, fix the stored value, delete the key, or set TASKBOARD_REDIS_KEY to a fresh key."
    );
  }

  async save(document: TaskboardDocument, expectedRevision: number, options: SaveTaskboardOptions = {}): Promise<TaskboardDocument> {
    const result = await this.redis.eval<string[], unknown>(this.compareAndSetScript, [this.redisKey], [String(expectedRevision), JSON.stringify(document)]);
    const payload = parseCompareAndSetResult(result);

    if (!payload.ok) {
      throw new RepositoryConflictError(payload.currentRevision, expectedRevision, options.operation);
    }

    return document;
  }
}

export class LocalFileTaskboardRepository implements TaskboardRepository {
  constructor(private readonly filePath: string) {}

  private async withFileLock<T>(callback: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;

    await mkdir(directory, { recursive: true });

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

    throw new Error("Failed to acquire local taskboard lock.");
  }

  private async readCurrentDocument(): Promise<TaskboardDocument> {
    try {
      const value = await readFile(this.filePath, "utf8");
      return normalizeTaskboardDocument(JSON.parse(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return createEmptyTaskboardDocument();
    }
  }

  async load(options: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    try {
      const value = await readFile(this.filePath, "utf8");
      return parseStoredDocumentJson(
        value,
        `Local kanboard file ${this.filePath}`,
        "Back it up, fix the file, remove it, or set TASKBOARD_LOCAL_FILE to a fresh path."
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const initial = createEmptyTaskboardDocument();
      await options.onCreate?.(initial);
      await this.save(initial, 0, { operation: "create the initial local kanboard" });
      return initial;
    }
  }

  async save(document: TaskboardDocument, expectedRevision: number, options: SaveTaskboardOptions = {}): Promise<TaskboardDocument> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    await this.withFileLock(async () => {
      const current = await this.readCurrentDocument();

      if (current.revision !== expectedRevision) {
        throw new RepositoryConflictError(current.revision, expectedRevision, options.operation);
      }

      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, JSON.stringify(document, null, 2), "utf8");
      await rename(tempPath, this.filePath);
    });

    return document;
  }
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
