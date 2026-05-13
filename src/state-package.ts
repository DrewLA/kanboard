import { randomUUID } from "node:crypto";

import {
  BoardBrief,
  BoardNodeType,
  Epic,
  Feature,
  NodeComment,
  Notification,
  Task,
  TaskboardDocument,
  UserStory,
  WorkLink,
  createEmptyTaskboardDocument,
  nowIso
} from "./model";

export const tableNames = [
  "metadata",
  "users",
  "boardBrief",
  "epics",
  "features",
  "userStories",
  "tasks",
  "comments",
  "links",
  "indexes",
  "notifications"
] as const;

export type TableName = (typeof tableNames)[number];

export interface UserRecord {
  id: string;
  name: string;
  role: string;
  email?: string;
  avatarIcon?: string;
  avatarColor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRecord extends NodeComment {
  nodeType: BoardNodeType;
  nodeId: string;
  userId?: string;
}

export interface IndexesRecord {
  id: "main";
  epicIds: string[];
  aliases: Record<string, { type: BoardNodeType; id: string }>;
}

export interface MetadataRecord {
  id: "project";
  schemaVersion: 1;
  projectId: string;
  revision: number;
  updatedAt: string;
  lastMutation?: {
    actor: string;
    summary: string;
    signature: string;
    occurredAt: string;
  };
}

export type TableValueMap = {
  metadata: MetadataRecord;
  users: UserRecord;
  boardBrief: BoardBrief & { id?: "main" };
  epics: Epic;
  features: Feature;
  userStories: UserStory;
  tasks: Task;
  comments: CommentRecord;
  links: WorkLink;
  indexes: IndexesRecord;
  notifications: Notification;
};

export type VersionedRecord<T> = {
  version: number;
  value: T;
};

export type StateTable<T> = {
  schemaVersion: 1;
  version: number;
  updatedAt: string;
  rows: Record<string, VersionedRecord<T>>;
};

export type StateTables = {
  [K in TableName]: StateTable<TableValueMap[K]>;
};

export interface StatePackage {
  tables: StateTables;
}

export interface RecordRef {
  table: TableName;
  id: string;
}

export interface RecordVersionRef extends RecordRef {
  version: number;
}

export interface PackageChange {
  table: TableName;
  id: string;
  nextValue?: TableValueMap[TableName];
  deleted?: boolean;
}

export interface PackageDiff {
  changes: PackageChange[];
  changedTables: Set<TableName>;
}

const mainId = "main";
const projectId = "project";

export function createEmptyTable<T>(): StateTable<T> {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: nowIso(),
    rows: {}
  };
}

export function createEmptyStatePackage(): StatePackage {
  return {
    tables: {
      metadata: createEmptyTable<MetadataRecord>(),
      users: createEmptyTable<UserRecord>(),
      boardBrief: createEmptyTable<BoardBrief & { id?: "main" }>(),
      epics: createEmptyTable<Epic>(),
      features: createEmptyTable<Feature>(),
      userStories: createEmptyTable<UserStory>(),
      tasks: createEmptyTable<Task>(),
      comments: createEmptyTable<CommentRecord>(),
      links: createEmptyTable<WorkLink>(),
      indexes: createEmptyTable<IndexesRecord>(),
      notifications: createEmptyTable<Notification>()
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTable<T>(value: unknown): StateTable<T> {
  const fallback = createEmptyTable<T>();

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback;
  }

  const record = value as Partial<StateTable<T>>;

  if (typeof record.rows !== "object" || record.rows === null || Array.isArray(record.rows)) {
    return fallback;
  }

  return {
    schemaVersion: 1,
    version: typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 0 ? record.version : 0,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    rows: record.rows as Record<string, VersionedRecord<T>>
  };
}

export function normalizeStatePackage(value: unknown): StatePackage {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as { tables?: Partial<StateTables> }
    : {};
  const empty = createEmptyStatePackage();

  return {
    tables: {
      metadata: normalizeTable<MetadataRecord>(source.tables?.metadata ?? empty.tables.metadata),
      users: normalizeTable<UserRecord>(source.tables?.users ?? empty.tables.users),
      boardBrief: normalizeTable<BoardBrief & { id?: "main" }>(source.tables?.boardBrief ?? empty.tables.boardBrief),
      epics: normalizeTable<Epic>(source.tables?.epics ?? empty.tables.epics),
      features: normalizeTable<Feature>(source.tables?.features ?? empty.tables.features),
      userStories: normalizeTable<UserStory>(source.tables?.userStories ?? empty.tables.userStories),
      tasks: normalizeTable<Task>(source.tables?.tasks ?? empty.tables.tasks),
      comments: normalizeTable<CommentRecord>(source.tables?.comments ?? empty.tables.comments),
      links: normalizeTable<WorkLink>(source.tables?.links ?? empty.tables.links),
      indexes: normalizeTable<IndexesRecord>(source.tables?.indexes ?? empty.tables.indexes),
      notifications: normalizeTable<Notification>(source.tables?.notifications ?? empty.tables.notifications)
    }
  };
}

function stripComments<T extends { comments: NodeComment[] }>(entity: T): T {
  return {
    ...entity,
    comments: []
  };
}

function buildIndexes(document: TaskboardDocument): IndexesRecord {
  const aliases: IndexesRecord["aliases"] = {};

  for (const epicId of document.epicIds) {
    const epic = document.epics[epicId];
    if (epic) {
      aliases[epic.alias] = { type: "epic", id: epic.id };
    }
  }

  for (const feature of Object.values(document.features)) {
    aliases[feature.alias] = { type: "feature", id: feature.id };
  }

  for (const story of Object.values(document.userStories)) {
    aliases[story.alias] = { type: "story", id: story.id };
  }

  for (const task of Object.values(document.tasks)) {
    aliases[task.alias] = { type: "task", id: task.id };
  }

  return {
    id: mainId,
    epicIds: [...document.epicIds],
    aliases
  };
}

export function documentToTableValues(document: TaskboardDocument): {
  [K in TableName]: Record<string, TableValueMap[K]>;
} {
  const boardBrief: BoardBrief & { id: "main" } = { ...document.boardBrief, id: mainId };
  const comments: Record<string, CommentRecord> = {};

  const collectComments = (nodeType: BoardNodeType, nodeId: string, nodeComments: NodeComment[]): void => {
    for (const comment of nodeComments) {
      comments[comment.id] = {
        ...comment,
        nodeType,
        nodeId
      };
    }
  };

  for (const epic of Object.values(document.epics)) {
    collectComments("epic", epic.id, epic.comments);
  }

  for (const feature of Object.values(document.features)) {
    collectComments("feature", feature.id, feature.comments);
  }

  for (const story of Object.values(document.userStories)) {
    collectComments("story", story.id, story.comments);
  }

  for (const task of Object.values(document.tasks)) {
    collectComments("task", task.id, task.comments);
  }

  return {
    metadata: {},
    users: {},
    boardBrief: { [mainId]: boardBrief },
    epics: Object.fromEntries(Object.values(document.epics).map((epic) => [epic.id, stripComments(epic)])),
    features: Object.fromEntries(Object.values(document.features).map((feature) => [feature.id, stripComments(feature)])),
    userStories: Object.fromEntries(Object.values(document.userStories).map((story) => [story.id, stripComments(story)])),
    tasks: Object.fromEntries(Object.values(document.tasks).map((task) => [task.id, stripComments(task)])),
    comments,
    links: Object.fromEntries(Object.values(document.links).map((link) => [link.id, link])),
    indexes: { [mainId]: buildIndexes(document) },
    notifications: {}
  };
}

function attachComments<T extends { id: string; comments: NodeComment[] }>(
  entities: Record<string, T>,
  comments: CommentRecord[],
  nodeType: BoardNodeType
): void {
  for (const entity of Object.values(entities)) {
    entity.comments = comments
      .filter((comment) => comment.nodeType === nodeType && comment.nodeId === entity.id)
      .map(({ nodeType: _nodeType, nodeId: _nodeId, userId: _userId, ...comment }) => comment)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

export function statePackageToDocument(statePackage: StatePackage): TaskboardDocument {
  const empty = createEmptyTaskboardDocument();
  const boardBriefRow = statePackage.tables.boardBrief.rows[mainId]?.value;
  const indexRow = statePackage.tables.indexes.rows[mainId]?.value;
  const metadata = statePackage.tables.metadata.rows[projectId]?.value;

  const document: TaskboardDocument = {
    ...empty,
    revision: metadata?.revision ?? 0,
    boardBrief: {
      ...empty.boardBrief,
      ...boardBriefRow
    },
    epicIds: indexRow?.epicIds ?? [],
    epics: Object.fromEntries(Object.entries(statePackage.tables.epics.rows).map(([id, row]) => [id, clone(row.value)])),
    features: Object.fromEntries(Object.entries(statePackage.tables.features.rows).map(([id, row]) => [id, clone(row.value)])),
    userStories: Object.fromEntries(Object.entries(statePackage.tables.userStories.rows).map(([id, row]) => [id, clone(row.value)])),
    tasks: Object.fromEntries(Object.entries(statePackage.tables.tasks.rows).map(([id, row]) => [id, clone(row.value)])),
    linkIds: Object.keys(statePackage.tables.links.rows),
    links: Object.fromEntries(Object.entries(statePackage.tables.links.rows).map(([id, row]) => [id, clone(row.value)])),
    recentMutations: []
  };

  const comments = Object.values(statePackage.tables.comments.rows).map((row) => clone(row.value));
  attachComments(document.epics, comments, "epic");
  attachComments(document.features, comments, "feature");
  attachComments(document.userStories, comments, "story");
  attachComments(document.tasks, comments, "task");

  return document;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizedForDiff(table: TableName, value: unknown): unknown {
  if ((table === "epics" || table === "features" || table === "userStories") && value && typeof value === "object" && !Array.isArray(value)) {
    const copy = { ...(value as Record<string, unknown>) };
    delete copy.updatedAt;
    return copy;
  }

  return value;
}

export function diffDocuments(baseline: TaskboardDocument, next: TaskboardDocument): PackageDiff {
  const baselineValues = documentToTableValues(baseline);
  const nextValues = documentToTableValues(next);
  const changes: PackageChange[] = [];
  const changedTables = new Set<TableName>();

  for (const table of tableNames) {
    if (table === "metadata" || table === "users" || table === "notifications") {
      continue;
    }

    const ids = new Set([...Object.keys(baselineValues[table]), ...Object.keys(nextValues[table])]);

    for (const id of ids) {
      const before = baselineValues[table][id];
      const after = nextValues[table][id];

      if (after === undefined) {
        changes.push({ table, id, deleted: true });
        changedTables.add(table);
        continue;
      }

      if (before === undefined || stableStringify(normalizedForDiff(table, before)) !== stableStringify(normalizedForDiff(table, after))) {
        changes.push({ table, id, nextValue: after });
        changedTables.add(table);
      }
    }
  }

  return { changes, changedTables };
}

export function cloneStatePackage(statePackage: StatePackage): StatePackage {
  return clone(statePackage);
}

export function getRecordVersion(statePackage: StatePackage, ref: RecordRef): number {
  return statePackage.tables[ref.table].rows[ref.id]?.version ?? 0;
}

export function uniqueRecordRefs(refs: RecordRef[]): RecordRef[] {
  const seen = new Set<string>();
  const result: RecordRef[] = [];

  for (const ref of refs) {
    const key = `${ref.table}:${ref.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(ref);
  }

  return result;
}

export function applyPackageChanges(current: StatePackage, diff: PackageDiff, mutation?: MetadataRecord["lastMutation"]): StatePackage {
  const next = cloneStatePackage(current);
  const timestamp = nowIso();

  for (const change of diff.changes) {
    const table = next.tables[change.table] as StateTable<unknown>;

    if (change.deleted) {
      if (table.rows[change.id]) {
        delete table.rows[change.id];
        table.version += 1;
        table.updatedAt = timestamp;
      }
      continue;
    }

    table.rows[change.id] = {
      version: (table.rows[change.id]?.version ?? 0) + 1,
      value: change.nextValue
    };
    table.version += 1;
    table.updatedAt = timestamp;
  }

  const metadataTable = next.tables.metadata;
  const existingMetadata = metadataTable.rows[projectId]?.value;
  metadataTable.rows[projectId] = {
    version: (metadataTable.rows[projectId]?.version ?? 0) + 1,
    value: {
      id: projectId,
      schemaVersion: 1,
      projectId: existingMetadata?.projectId ?? randomUUID(),
      revision: (existingMetadata?.revision ?? 0) + 1,
      updatedAt: timestamp,
      lastMutation: mutation
    }
  };
  metadataTable.version += 1;
  metadataTable.updatedAt = timestamp;

  return next;
}

export function statePackageFromDocument(document: TaskboardDocument): StatePackage {
  const statePackage = createEmptyStatePackage();
  const values = documentToTableValues(document);
  const timestamp = nowIso();

  for (const tableName of tableNames) {
    if (tableName === "metadata" || tableName === "users") {
      continue;
    }

    const table = statePackage.tables[tableName] as StateTable<unknown>;

    for (const [id, value] of Object.entries(values[tableName])) {
      table.rows[id] = {
        version: 1,
        value
      };
    }

    if (Object.keys(table.rows).length > 0) {
      table.version = 1;
      table.updatedAt = timestamp;
    }
  }

  statePackage.tables.metadata.rows.project = {
    version: 1,
    value: {
      id: "project",
      schemaVersion: 1,
      projectId: randomUUID(),
      revision: document.revision,
      updatedAt: timestamp
    }
  };
  statePackage.tables.metadata.version = 1;
  statePackage.tables.metadata.updatedAt = timestamp;

  return statePackage;
}
