import { randomUUID } from "node:crypto";
import { z } from "zod";

export const workStatusValues = ["pending", "ready", "in-progress", "review", "blocked", "done"] as const;
export const priorityValues = ["low", "medium", "high", "critical"] as const;
export const workItemTypeValues = ["feature", "task"] as const;
export const workLinkKindValues = ["blocks", "relates-to"] as const;
export const boardNodeTypeValues = ["epic", "feature", "story", "task"] as const;
export const commentKindValues = ["note", "requirement", "blocker"] as const;

export type WorkStatus = (typeof workStatusValues)[number];
export type Priority = (typeof priorityValues)[number];
export type WorkItemType = (typeof workItemTypeValues)[number];
export type WorkLinkKind = (typeof workLinkKindValues)[number];
export type BoardNodeType = (typeof boardNodeTypeValues)[number];
export type CommentKind = (typeof commentKindValues)[number];

const idSchema = z.string().min(1);
const statusSchema = z.enum(workStatusValues);
const prioritySchema = z.enum(priorityValues);
const workItemTypeSchema = z.enum(workItemTypeValues);
const workLinkKindSchema = z.enum(workLinkKindValues);
const boardNodeTypeSchema = z.enum(boardNodeTypeValues);
const commentKindSchema = z.enum(commentKindValues);
const aliasInputSchema = z.string().min(1).max(80);

const baseCreateSchema = z.object({
  alias: aliasInputSchema.optional(),
  title: z.string().min(1).max(120),
  summary: z.string().max(2000).default(""),
  status: statusSchema.default("pending"),
  priority: prioritySchema.default("medium")
});

const baseUpdateSchema = baseCreateSchema.partial();
const assigneeSchema = z.preprocess(
  (value) => value === null || value === "" ? undefined : value,
  z.string().max(120).optional()
);

export const boardBriefPatchSchema = z.object({
  productName: z.string().min(1).max(120).optional(),
  objective: z.string().max(4000).optional(),
  scopeDefinition: z.string().max(4000).optional(),
  nonGoals: z.string().max(4000).optional(),
  successCriteria: z.string().max(4000).optional(),
  implementationNotes: z.string().max(6000).optional(),
  currentFocus: z.string().max(1000).optional(),
  productDescription: z.string().max(4000).optional()
}).transform(({ productDescription, objective, ...value }) => ({
  ...value,
  objective: objective ?? productDescription
}));

export const metadataPatchSchema = boardBriefPatchSchema;

export const createEpicInputSchema = baseCreateSchema;
export const updateEpicInputSchema = baseUpdateSchema;

export const createFeatureInputSchema = baseCreateSchema.extend({
  epicId: idSchema.optional(),
  epicAlias: aliasInputSchema.optional()
}).refine((value) => value.epicId || value.epicAlias, {
  message: "Provide epicId or epicAlias.",
  path: ["epicId"]
});
export const updateFeatureInputSchema = baseUpdateSchema;

export const createUserStoryInputSchema = baseCreateSchema.extend({
  featureId: idSchema.optional(),
  featureAlias: aliasInputSchema.optional(),
  acceptanceCriteria: z.array(z.string().max(500)).default([])
}).refine((value) => value.featureId || value.featureAlias, {
  message: "Provide featureId or featureAlias.",
  path: ["featureId"]
});
export const updateUserStoryInputSchema = baseUpdateSchema.extend({
  acceptanceCriteria: z.array(z.string().max(500)).optional()
});

export const createTaskInputSchema = baseCreateSchema.extend({
  storyId: idSchema.optional(),
  storyAlias: aliasInputSchema.optional(),
  implementationNotes: z.string().max(4000).default(""),
  estimate: z.string().max(120).default(""),
  tags: z.array(z.string().max(40)).default([]),
  assignedTo: assigneeSchema
}).refine((value) => value.storyId || value.storyAlias, {
  message: "Provide storyId or storyAlias.",
  path: ["storyId"]
});
export const updateTaskInputSchema = baseUpdateSchema.extend({
  implementationNotes: z.string().max(4000).optional(),
  estimate: z.string().max(120).optional(),
  tags: z.array(z.string().max(40)).optional(),
  assignedTo: assigneeSchema
});

export const resolveNodeInputSchema = z.object({
  type: boardNodeTypeSchema,
  id: idSchema.optional(),
  alias: aliasInputSchema.optional()
}).refine((value) => value.id || value.alias, {
  message: "Provide id or alias.",
  path: ["id"]
});

export const findNodesInputSchema = z.object({
  query: z.string().min(1).max(120),
  type: boardNodeTypeSchema.optional(),
  limit: z.coerce.number().int().positive().max(50).default(10)
});

export const createNodeCommentInputSchema = z.object({
  nodeType: boardNodeTypeSchema,
  nodeId: idSchema.optional(),
  nodeAlias: aliasInputSchema.optional(),
  author: z.string().min(1).max(80),
  kind: commentKindSchema.default("note"),
  body: z.string().min(1).max(4000)
})
  .refine((value) => value.nodeId || value.nodeAlias, {
    message: "Provide nodeId or nodeAlias.",
    path: ["nodeId"]
  })
  .refine((value) => !(value.nodeId && value.nodeAlias), {
    message: "Provide nodeId or nodeAlias, not both.",
    path: ["nodeId"]
  });

export const updateNodeCommentInputSchema = z.object({
  author: z.string().min(1).max(80).optional(),
  kind: commentKindSchema.optional(),
  body: z.string().min(1).max(4000).optional()
}).refine((value) => value.author !== undefined || value.kind !== undefined || value.body !== undefined, {
  message: "Provide at least one field to update."
});

export const createWorkLinkInputSchema = z.object({
  sourceType: workItemTypeSchema.optional(),
  sourceId: idSchema.optional(),
  sourceAlias: aliasInputSchema.optional(),
  targetType: workItemTypeSchema.optional(),
  targetId: idSchema.optional(),
  targetAlias: aliasInputSchema.optional(),
  kind: workLinkKindSchema.default("blocks"),
  note: z.string().max(500).default("")
})
  .refine((value) => value.sourceId || value.sourceAlias, {
    message: "Provide sourceId or sourceAlias.",
    path: ["sourceId"]
  })
  .refine((value) => value.targetId || value.targetAlias, {
    message: "Provide targetId or targetAlias.",
    path: ["targetId"]
  })
  .refine((value) => !(value.sourceId && value.sourceAlias), {
    message: "Provide sourceId or sourceAlias, not both.",
    path: ["sourceId"]
  })
  .refine((value) => !(value.targetId && value.targetAlias), {
    message: "Provide targetId or targetAlias, not both.",
    path: ["targetId"]
  });

export const updateWorkLinkInputSchema = z.object({
  kind: workLinkKindSchema.optional(),
  note: z.string().max(500).optional()
});

export type BoardBriefPatch = z.infer<typeof boardBriefPatchSchema>;
export type MetadataPatch = BoardBriefPatch;
export type CreateEpicInput = z.infer<typeof createEpicInputSchema>;
export type UpdateEpicInput = z.infer<typeof updateEpicInputSchema>;
export type CreateFeatureInput = z.infer<typeof createFeatureInputSchema>;
export type UpdateFeatureInput = z.infer<typeof updateFeatureInputSchema>;
export type CreateUserStoryInput = z.infer<typeof createUserStoryInputSchema>;
export type UpdateUserStoryInput = z.infer<typeof updateUserStoryInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type CreateNodeCommentInput = z.infer<typeof createNodeCommentInputSchema>;
export type UpdateNodeCommentInput = z.infer<typeof updateNodeCommentInputSchema>;
export type CreateWorkLinkInput = z.infer<typeof createWorkLinkInputSchema>;
export type UpdateWorkLinkInput = z.infer<typeof updateWorkLinkInputSchema>;
export type ResolveNodeInput = z.infer<typeof resolveNodeInputSchema>;
export type FindNodesInput = z.infer<typeof findNodesInputSchema>;

export interface NodeComment {
  id: string;
  author: string;
  kind: CommentKind;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type NotificationSourceType = "comment" | "field";

export interface Notification {
  id: string;
  recipientId: string;
  nodeType: BoardNodeType;
  nodeId: string;
  mentionedBy?: string;
  sourceType: NotificationSourceType;
  sourceId: string;
  excerpt: string;
  createdAt: string;
}

export interface RecentMutation {
  revision: number;
  scopes: string[];
  summary: string;
  occurredAt: string;
}

export interface MutationResult<T> {
  revision: number;
  data: T;
}

export interface BoardBrief {
  productName: string;
  objective: string;
  scopeDefinition: string;
  nonGoals: string;
  successCriteria: string;
  implementationNotes: string;
  currentFocus: string;
  updatedAt: string;
  updatedBy?: string;
  updatedVia?: "mcp" | "api";
}

export type BoardMetadata = BoardBrief;

export interface BaseEntity {
  id: string;
  alias: string;
  title: string;
  summary: string;
  status: WorkStatus;
  priority: Priority;
  comments: NodeComment[];
  author?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  updatedVia?: "mcp" | "api";
}

export interface Epic extends BaseEntity {
  featureIds: string[];
}

export interface Feature extends BaseEntity {
  epicId: string;
  storyIds: string[];
}

export interface UserStory extends BaseEntity {
  featureId: string;
  acceptanceCriteria: string[];
  taskIds: string[];
}

export interface Task extends BaseEntity {
  storyId: string;
  implementationNotes: string;
  estimate: string;
  tags: string[];
  assignedTo?: string;
}

export interface WorkLink {
  id: string;
  sourceType: WorkItemType;
  sourceId: string;
  targetType: WorkItemType;
  targetId: string;
  kind: WorkLinkKind;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskboardDocument {
  version: 3;
  revision: number;
  boardBrief: BoardBrief;
  epicIds: string[];
  epics: Record<string, Epic>;
  features: Record<string, Feature>;
  userStories: Record<string, UserStory>;
  tasks: Record<string, Task>;
  linkIds: string[];
  links: Record<string, WorkLink>;
  recentMutations: RecentMutation[];
}

export interface ResolvedWorkLink {
  id: string;
  kind: WorkLinkKind;
  direction: "incoming" | "outgoing";
  itemType: WorkItemType;
  itemId: string;
  alias: string;
  title: string;
  status: WorkStatus;
  priority: Priority;
  note: string;
  isActive: boolean;
}

export interface BoardNodeSummary {
  id: string;
  alias: string;
  type: BoardNodeType;
  title: string;
  status: WorkStatus;
  priority: Priority;
  parentId?: string;
  parentAlias?: string;
}

export interface TaskWithLinks extends Task {
  incomingLinks: ResolvedWorkLink[];
  outgoingLinks: ResolvedWorkLink[];
  isBlockedByLinks: boolean;
  activeBlockerCount: number;
}

export interface StoryWithTasks extends UserStory {
  tasks: TaskWithLinks[];
}

export interface FeatureWithStories extends Feature {
  userStories: StoryWithTasks[];
  incomingLinks: ResolvedWorkLink[];
  outgoingLinks: ResolvedWorkLink[];
  isBlockedByLinks: boolean;
  activeBlockerCount: number;
}

export interface EpicWithFeatures extends Epic {
  features: FeatureWithStories[];
}

export interface TaskboardSnapshot {
  revision: number;
  boardBrief: BoardBrief;
  epics: EpicWithFeatures[];
  links: WorkLink[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeAliasValue(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function ensureAliasValue(value: string, fallback: string): string {
  const normalized = normalizeAliasValue(value);
  return normalized || normalizeAliasValue(fallback) || "item";
}

export function createEmptyTaskboardDocument(): TaskboardDocument {
  return {
    version: 3,
    revision: 0,
    boardBrief: {
      productName: "Private Taskboard",
      objective: "",
      scopeDefinition: "",
      nonGoals: "",
      successCriteria: "",
      implementationNotes: "",
      currentFocus: "",
      updatedAt: nowIso()
    },
    epicIds: [],
    epics: {},
    features: {},
    userStories: {},
    tasks: {},
    linkIds: [],
    links: {},
    recentMutations: []
  };
}

function buildUniqueAlias(baseValue: string, usedAliases: Set<string>, fallbackId: string): string {
  const baseAlias = ensureAliasValue(baseValue, fallbackId);
  let alias = baseAlias;
  let counter = 2;

  while (usedAliases.has(alias)) {
    alias = `${baseAlias}-${counter}`;
    counter += 1;
  }

  usedAliases.add(alias);
  return alias;
}

function normalizeEntityRecord<T extends BaseEntity>(
  record: Record<string, T> | undefined,
  usedAliases: Set<string>
): Record<string, T> {
  const result: Record<string, T> = {};

  for (const [id, entity] of Object.entries(record ?? {})) {
    const rawComments = Array.isArray((entity as { comments?: unknown }).comments)
      ? ((entity as { comments?: unknown[] }).comments ?? [])
      : [];
    const comments = rawComments.length
      ? rawComments
          .filter((comment): comment is Record<string, unknown> => typeof comment === "object" && comment !== null)
          .map((comment) => {
            const timestamp = typeof comment.createdAt === "string" && comment.createdAt ? comment.createdAt : nowIso();
            const updatedAt = typeof comment.updatedAt === "string" && comment.updatedAt ? comment.updatedAt : timestamp;
            const kind = typeof comment.kind === "string" && commentKindValues.includes(comment.kind as CommentKind)
              ? (comment.kind as CommentKind)
              : "note";
            return {
              id: typeof comment.id === "string" && comment.id ? comment.id : createId("comment"),
              author: typeof comment.author === "string" && comment.author.trim() ? comment.author.trim() : "unknown",
              kind,
              body: typeof comment.body === "string" ? comment.body : "",
              createdAt: timestamp,
              updatedAt
            } satisfies NodeComment;
          })
          .filter((comment) => comment.body)
      : [];

    result[id] = {
      ...(JSON.parse(JSON.stringify(entity)) as T),
      alias: buildUniqueAlias(entity.alias || entity.title || id, usedAliases, id),
      comments
    };
  }

  return result;
}

export function normalizeTaskboardDocument(value: unknown): TaskboardDocument {
  const document = (value ?? {}) as Partial<TaskboardDocument> & {
    boardBrief?: Partial<BoardBrief>;
    metadata?: Partial<BoardBrief> & { productDescription?: string };
    linkIds?: unknown;
    links?: unknown;
    revision?: unknown;
    recentMutations?: unknown;
  };
  const empty = createEmptyTaskboardDocument();
  const rawLinks = typeof document.links === "object" && document.links !== null ? (document.links as Record<string, WorkLink>) : {};
  const rawLinkIds = Array.isArray(document.linkIds) ? document.linkIds.filter((item): item is string => typeof item === "string") : [];
  const linkIds = rawLinkIds.length ? rawLinkIds.filter((linkId) => Boolean(rawLinks[linkId])) : Object.keys(rawLinks);
  const recentMutations = Array.isArray(document.recentMutations)
    ? document.recentMutations
        .flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }

          const record = entry as unknown as Record<string, unknown>;
          return [record];
        })
        .map((entry) => ({
          revision: typeof entry.revision === "number" && Number.isInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0,
          scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((scope): scope is string => typeof scope === "string" && Boolean(scope)) : [],
          summary: typeof entry.summary === "string" ? entry.summary : "Mutation applied.",
          occurredAt: typeof entry.occurredAt === "string" && entry.occurredAt ? entry.occurredAt : nowIso()
        }))
        .filter((entry) => entry.revision > 0)
        .slice(-100)
    : [];
  const usedAliases = new Set<string>();
  const epics = normalizeEntityRecord(document.epics, usedAliases);
  const features = normalizeEntityRecord(document.features, usedAliases);
  const userStories = normalizeEntityRecord(document.userStories, usedAliases);
  const tasks = normalizeEntityRecord(document.tasks, usedAliases);

  const legacyMetadata = typeof document.metadata === "object" && document.metadata !== null ? document.metadata : {};
  const rawBoardBrief = typeof document.boardBrief === "object" && document.boardBrief !== null ? document.boardBrief : legacyMetadata;

  return {
    version: 3,
    revision: typeof document.revision === "number" && Number.isInteger(document.revision) && document.revision >= 0 ? document.revision : 0,
    boardBrief: {
      ...empty.boardBrief,
      ...rawBoardBrief,
      objective:
        typeof rawBoardBrief.objective === "string"
          ? rawBoardBrief.objective
          : typeof legacyMetadata.productDescription === "string"
            ? legacyMetadata.productDescription
            : empty.boardBrief.objective
    },
    epicIds: Array.isArray(document.epicIds) ? document.epicIds.filter((item): item is string => typeof item === "string") : [],
    epics,
    features,
    userStories,
    tasks,
    linkIds,
    links: rawLinks,
    recentMutations
  };
}

function getLinkedEntity(document: TaskboardDocument, itemType: WorkItemType, itemId: string): Feature | Task | undefined {
  if (itemType === "feature") {
    return document.features[itemId];
  }

  return document.tasks[itemId];
}

function isLinkActive(document: TaskboardDocument, link: WorkLink): boolean {
  if (link.kind !== "blocks") {
    return false;
  }

  const source = getLinkedEntity(document, link.sourceType, link.sourceId);
  if (!source) {
    return false;
  }

  return source.status !== "ready" && source.status !== "done";
}

function resolveLinksFor(document: TaskboardDocument, itemType: WorkItemType, itemId: string) {
  const incomingLinks: ResolvedWorkLink[] = [];
  const outgoingLinks: ResolvedWorkLink[] = [];

  for (const linkId of document.linkIds) {
    const link = document.links[linkId];
    if (!link) {
      continue;
    }

    if (link.targetType === itemType && link.targetId === itemId) {
      const source = getLinkedEntity(document, link.sourceType, link.sourceId);
      if (!source) {
        continue;
      }

      incomingLinks.push({
        id: link.id,
        kind: link.kind,
        direction: "incoming",
        itemType: link.sourceType,
        itemId: link.sourceId,
        alias: source.alias,
        title: source.title,
        status: source.status,
        priority: source.priority,
        note: link.note,
        isActive: isLinkActive(document, link)
      });
    }

    if (link.sourceType === itemType && link.sourceId === itemId) {
      const target = getLinkedEntity(document, link.targetType, link.targetId);
      if (!target) {
        continue;
      }

      outgoingLinks.push({
        id: link.id,
        kind: link.kind,
        direction: "outgoing",
        itemType: link.targetType,
        itemId: link.targetId,
        alias: target.alias,
        title: target.title,
        status: target.status,
        priority: target.priority,
        note: link.note,
        isActive: isLinkActive(document, link)
      });
    }
  }

  const activeBlockerCount = incomingLinks.filter((link) => link.kind === "blocks" && link.isActive).length;

  return {
    incomingLinks,
    outgoingLinks,
    isBlockedByLinks: activeBlockerCount > 0,
    activeBlockerCount
  };
}

export function toSnapshot(document: TaskboardDocument): TaskboardSnapshot {
  return {
    revision: document.revision,
    boardBrief: document.boardBrief,
    epics: document.epicIds
      .map((epicId) => document.epics[epicId])
      .filter(Boolean)
      .map((epic) => ({
        ...epic,
        features: epic.featureIds
          .map((featureId) => document.features[featureId])
          .filter(Boolean)
          .map((feature) => ({
            ...feature,
            ...resolveLinksFor(document, "feature", feature.id),
            userStories: feature.storyIds
              .map((storyId) => document.userStories[storyId])
              .filter(Boolean)
              .map((story) => ({
                ...story,
                tasks: story.taskIds
                  .map((taskId) => document.tasks[taskId])
                  .filter(Boolean)
                  .map((task) => ({
                    ...task,
                    ...resolveLinksFor(document, "task", task.id)
                  }))
              }))
          }))
      })),
    links: document.linkIds.map((linkId) => document.links[linkId]).filter(Boolean)
  };
}
