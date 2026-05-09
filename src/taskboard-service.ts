import {
  BoardBrief,
  BoardBriefPatch,
  BoardNodeSummary,
  BoardNodeType,
  CreateNodeCommentInput,
  CreateEpicInput,
  CreateFeatureInput,
  CreateTaskInput,
  CreateUserStoryInput,
  CreateWorkLinkInput,
  Epic,
  FindNodesInput,
  Feature,
  NodeComment,
  ResolveNodeInput,
  Task,
  TaskboardDocument,
  TaskboardSnapshot,
  UpdateNodeCommentInput,
  UpdateEpicInput,
  UpdateFeatureInput,
  UpdateTaskInput,
  UpdateUserStoryInput,
  UpdateWorkLinkInput,
  UserStory,
  WorkItemType,
  WorkLink,
  createId,
  ensureAliasValue,
  nowIso,
  normalizeAliasValue,
  toSnapshot
} from "./model";
import { TaskboardRepository } from "./repository";

let writeQueue: Promise<void> = Promise.resolve();

export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

function requireEpic(document: TaskboardDocument, epicId: string): Epic {
  const epic = document.epics[epicId];
  if (!epic) {
    throw new NotFoundError(`Epic ${epicId} was not found.`);
  }
  return epic;
}

function requireFeature(document: TaskboardDocument, featureId: string): Feature {
  const feature = document.features[featureId];
  if (!feature) {
    throw new NotFoundError(`Feature ${featureId} was not found.`);
  }
  return feature;
}

function requireStory(document: TaskboardDocument, storyId: string): UserStory {
  const story = document.userStories[storyId];
  if (!story) {
    throw new NotFoundError(`User story ${storyId} was not found.`);
  }
  return story;
}

function requireTask(document: TaskboardDocument, taskId: string): Task {
  const task = document.tasks[taskId];
  if (!task) {
    throw new NotFoundError(`Task ${taskId} was not found.`);
  }
  return task;
}

function findNodeByAlias(document: TaskboardDocument, alias: string): BoardNodeSummary | null {
  const normalizedAlias = normalizeAliasValue(alias);
  if (!normalizedAlias) {
    return null;
  }

  for (const epicId of document.epicIds) {
    const epic = document.epics[epicId];
    if (epic?.alias === normalizedAlias) {
      return toNodeSummary(document, "epic", epic);
    }
  }

  for (const feature of Object.values(document.features)) {
    if (feature.alias === normalizedAlias) {
      return toNodeSummary(document, "feature", feature);
    }
  }

  for (const story of Object.values(document.userStories)) {
    if (story.alias === normalizedAlias) {
      return toNodeSummary(document, "story", story);
    }
  }

  for (const task of Object.values(document.tasks)) {
    if (task.alias === normalizedAlias) {
      return toNodeSummary(document, "task", task);
    }
  }

  return null;
}

function assertAliasAvailable(document: TaskboardDocument, alias: string, excludedId?: string): void {
  const existing = findNodeByAlias(document, alias);
  if (existing && existing.id !== excludedId) {
    throw new Error(`Alias ${alias} is already in use by ${existing.type} ${existing.title}.`);
  }
}

function buildEntityAlias(document: TaskboardDocument, explicitAlias: string | undefined, title: string, fallbackId: string, excludedId?: string): string {
  if (explicitAlias) {
    const normalized = ensureAliasValue(explicitAlias, fallbackId);
    assertAliasAvailable(document, normalized, excludedId);
    return normalized;
  }

  const baseAlias = ensureAliasValue(title, fallbackId);
  let alias = baseAlias;
  let counter = 2;

  while (findNodeByAlias(document, alias) && findNodeByAlias(document, alias)?.id !== excludedId) {
    alias = `${baseAlias}-${counter}`;
    counter += 1;
  }

  return alias;
}

function toNodeSummary(document: TaskboardDocument, type: BoardNodeType, entity: Epic | Feature | UserStory | Task): BoardNodeSummary {
  if (type === "epic") {
    return {
      id: entity.id,
      alias: entity.alias,
      type,
      title: entity.title,
      status: entity.status,
      priority: entity.priority
    };
  }

  if (type === "feature") {
    const feature = entity as Feature;
    const epic = document.epics[feature.epicId];
    return {
      id: feature.id,
      alias: feature.alias,
      type,
      title: feature.title,
      status: feature.status,
      priority: feature.priority,
      parentId: feature.epicId,
      parentAlias: epic?.alias
    };
  }

  if (type === "story") {
    const story = entity as UserStory;
    const feature = document.features[story.featureId];
    return {
      id: story.id,
      alias: story.alias,
      type,
      title: story.title,
      status: story.status,
      priority: story.priority,
      parentId: story.featureId,
      parentAlias: feature?.alias
    };
  }

  const task = entity as Task;
  const story = document.userStories[task.storyId];
  return {
    id: task.id,
    alias: task.alias,
    type,
    title: task.title,
    status: task.status,
    priority: task.priority,
    parentId: task.storyId,
    parentAlias: story?.alias
  };
}

function getAllNodeSummaries(document: TaskboardDocument): BoardNodeSummary[] {
  const summaries: BoardNodeSummary[] = [];

  for (const epicId of document.epicIds) {
    const epic = document.epics[epicId];
    if (epic) {
      summaries.push(toNodeSummary(document, "epic", epic));
    }
  }

  for (const feature of Object.values(document.features)) {
    summaries.push(toNodeSummary(document, "feature", feature));
  }

  for (const story of Object.values(document.userStories)) {
    summaries.push(toNodeSummary(document, "story", story));
  }

  for (const task of Object.values(document.tasks)) {
    summaries.push(toNodeSummary(document, "task", task));
  }

  return summaries;
}

function requireEpicReference(document: TaskboardDocument, epicId?: string, epicAlias?: string): Epic {
  if (epicId) {
    return requireEpic(document, epicId);
  }

  const node = epicAlias ? findNodeByAlias(document, epicAlias) : null;
  if (!node || node.type !== "epic") {
    throw new NotFoundError(`Epic ${epicAlias ?? ""} was not found.`);
  }

  return requireEpic(document, node.id);
}

function requireFeatureReference(document: TaskboardDocument, featureId?: string, featureAlias?: string): Feature {
  if (featureId) {
    return requireFeature(document, featureId);
  }

  const node = featureAlias ? findNodeByAlias(document, featureAlias) : null;
  if (!node || node.type !== "feature") {
    throw new NotFoundError(`Feature ${featureAlias ?? ""} was not found.`);
  }

  return requireFeature(document, node.id);
}

function requireStoryReference(document: TaskboardDocument, storyId?: string, storyAlias?: string): UserStory {
  if (storyId) {
    return requireStory(document, storyId);
  }

  const node = storyAlias ? findNodeByAlias(document, storyAlias) : null;
  if (!node || node.type !== "story") {
    throw new NotFoundError(`User story ${storyAlias ?? ""} was not found.`);
  }

  return requireStory(document, node.id);
}

function requireBoardNode(document: TaskboardDocument, nodeType: BoardNodeType, nodeId: string): Epic | Feature | UserStory | Task {
  switch (nodeType) {
    case "epic":
      return requireEpic(document, nodeId);
    case "feature":
      return requireFeature(document, nodeId);
    case "story":
      return requireStory(document, nodeId);
    case "task":
      return requireTask(document, nodeId);
  }
}

function requireBoardNodeReference(
  document: TaskboardDocument,
  nodeType: BoardNodeType,
  nodeId?: string,
  nodeAlias?: string
): Epic | Feature | UserStory | Task {
  if (nodeId) {
    return requireBoardNode(document, nodeType, nodeId);
  }

  const node = nodeAlias ? findNodeByAlias(document, nodeAlias) : null;
  if (!node || node.type !== nodeType) {
    throw new NotFoundError(`${nodeType} ${nodeAlias ?? ""} was not found.`);
  }

  return requireBoardNode(document, nodeType, node.id);
}

function requireWorkLink(document: TaskboardDocument, linkId: string): WorkLink {
  const link = document.links[linkId];
  if (!link) {
    throw new NotFoundError(`Link ${linkId} was not found.`);
  }
  return link;
}

function requireWorkItem(document: TaskboardDocument, itemType: WorkItemType, itemId: string): Feature | Task {
  if (itemType === "feature") {
    return requireFeature(document, itemId);
  }

  return requireTask(document, itemId);
}

function resolveWorkItemReference(
  document: TaskboardDocument,
  itemType: WorkItemType | undefined,
  itemId: string | undefined,
  itemAlias: string | undefined,
  label: "source" | "target"
): { itemType: WorkItemType; itemId: string } {
  if (itemAlias) {
    const node = findNodeByAlias(document, itemAlias);
    if (!node) {
      throw new NotFoundError(`${label} alias ${itemAlias} was not found.`);
    }

    if (node.type !== "feature" && node.type !== "task") {
      throw new Error(`${label} alias ${itemAlias} must resolve to a feature or task.`);
    }

    if (itemType && node.type !== itemType) {
      throw new Error(`${label} alias ${itemAlias} resolved to ${node.type}, not ${itemType}.`);
    }

    return {
      itemType: node.type,
      itemId: node.id
    };
  }

  if (!itemId) {
    throw new Error(`Missing ${label} reference.`);
  }

  if (itemType) {
    requireWorkItem(document, itemType, itemId);
    return { itemType, itemId };
  }

  const feature = document.features[itemId];
  if (feature) {
    return { itemType: "feature", itemId: feature.id };
  }

  const task = document.tasks[itemId];
  if (task) {
    return { itemType: "task", itemId: task.id };
  }

  throw new NotFoundError(`${label} item ${itemId} was not found.`);
}

function touchBoardNodeLineage(
  document: TaskboardDocument,
  nodeType: BoardNodeType,
  node: Epic | Feature | UserStory | Task,
  timestamp: string
): void {
  switch (nodeType) {
    case "epic":
      touchEntity(node, timestamp);
      return;
    case "feature":
      touchFeatureLineage(document, node as Feature, timestamp);
      return;
    case "story":
      touchStoryLineage(document, node as UserStory, timestamp);
      return;
    case "task":
      touchTaskLineage(document, node as Task, timestamp);
      return;
  }
}

function findNodeComment(document: TaskboardDocument, commentId: string): {
  nodeType: BoardNodeType;
  node: Epic | Feature | UserStory | Task;
  comment: NodeComment;
  commentIndex: number;
} | null {
  for (const epicId of document.epicIds) {
    const epic = document.epics[epicId];
    const commentIndex = epic?.comments.findIndex((comment) => comment.id === commentId) ?? -1;
    if (epic && commentIndex >= 0) {
      return { nodeType: "epic", node: epic, comment: epic.comments[commentIndex], commentIndex };
    }
  }

  for (const feature of Object.values(document.features)) {
    const commentIndex = feature.comments.findIndex((comment) => comment.id === commentId);
    if (commentIndex >= 0) {
      return { nodeType: "feature", node: feature, comment: feature.comments[commentIndex], commentIndex };
    }
  }

  for (const story of Object.values(document.userStories)) {
    const commentIndex = story.comments.findIndex((comment) => comment.id === commentId);
    if (commentIndex >= 0) {
      return { nodeType: "story", node: story, comment: story.comments[commentIndex], commentIndex };
    }
  }

  for (const task of Object.values(document.tasks)) {
    const commentIndex = task.comments.findIndex((comment) => comment.id === commentId);
    if (commentIndex >= 0) {
      return { nodeType: "task", node: task, comment: task.comments[commentIndex], commentIndex };
    }
  }

  return null;
}

function requireNodeComment(document: TaskboardDocument, commentId: string) {
  const result = findNodeComment(document, commentId);
  if (!result) {
    throw new NotFoundError(`Comment ${commentId} was not found.`);
  }

  return result;
}

function touchEntity(entity: { updatedAt: string }, timestamp: string): void {
  entity.updatedAt = timestamp;
}

function touchFeatureLineage(document: TaskboardDocument, feature: Feature, timestamp: string): void {
  touchEntity(feature, timestamp);

  const epic = document.epics[feature.epicId];
  if (epic) {
    touchEntity(epic, timestamp);
  }
}

function touchStoryLineage(document: TaskboardDocument, story: UserStory, timestamp: string): void {
  touchEntity(story, timestamp);

  const feature = document.features[story.featureId];
  if (feature) {
    touchFeatureLineage(document, feature, timestamp);
  }
}

function touchTaskLineage(document: TaskboardDocument, task: Task, timestamp: string): void {
  touchEntity(task, timestamp);

  const story = document.userStories[task.storyId];
  if (story) {
    touchStoryLineage(document, story, timestamp);
  }
}

function touchWorkItemLineageIfPresent(
  document: TaskboardDocument,
  itemType: WorkItemType,
  itemId: string,
  timestamp: string
): void {
  if (itemType === "feature") {
    const feature = document.features[itemId];
    if (feature) {
      touchFeatureLineage(document, feature, timestamp);
    }
    return;
  }

  const task = document.tasks[itemId];
  if (task) {
    touchTaskLineage(document, task, timestamp);
  }
}

function removeValue(values: string[], target: string): string[] {
  return values.filter((value) => value !== target);
}

function isSameEndpoint(
  leftType: WorkItemType,
  leftId: string,
  rightType: WorkItemType,
  rightId: string
): boolean {
  return leftType === rightType && leftId === rightId;
}

function isEquivalentLink(candidate: WorkLink, link: WorkLink, excludedLinkId?: string): boolean {
  if (link.id === excludedLinkId || link.kind !== candidate.kind) {
    return false;
  }

  const sameDirection =
    link.sourceType === candidate.sourceType &&
    link.sourceId === candidate.sourceId &&
    link.targetType === candidate.targetType &&
    link.targetId === candidate.targetId;

  if (sameDirection) {
    return true;
  }

  if (candidate.kind === "relates-to") {
    return (
      link.sourceType === candidate.targetType &&
      link.sourceId === candidate.targetId &&
      link.targetType === candidate.sourceType &&
      link.targetId === candidate.sourceId
    );
  }

  return false;
}

function wouldCreateBlockingCycle(
  document: TaskboardDocument,
  sourceType: WorkItemType,
  sourceId: string,
  targetType: WorkItemType,
  targetId: string,
  excludedLinkId?: string
): boolean {
  const startKey = `${sourceType}:${sourceId}`;
  const pending = [{ itemType: targetType, itemId: targetId }];
  const visited = new Set<string>();

  while (pending.length) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const currentKey = `${current.itemType}:${current.itemId}`;
    if (visited.has(currentKey)) {
      continue;
    }
    visited.add(currentKey);

    if (currentKey === startKey) {
      return true;
    }

    for (const linkId of document.linkIds) {
      const link = document.links[linkId];
      if (!link || link.id === excludedLinkId || link.kind !== "blocks") {
        continue;
      }

      if (link.sourceType === current.itemType && link.sourceId === current.itemId) {
        pending.push({ itemType: link.targetType, itemId: link.targetId });
      }
    }
  }

  return false;
}

function assertWorkLink(document: TaskboardDocument, link: WorkLink, excludedLinkId?: string): void {
  requireWorkItem(document, link.sourceType, link.sourceId);
  requireWorkItem(document, link.targetType, link.targetId);

  if (isSameEndpoint(link.sourceType, link.sourceId, link.targetType, link.targetId)) {
    throw new Error("Links must reference two distinct items.");
  }

  for (const linkId of document.linkIds) {
    const existing = document.links[linkId];
    if (existing && isEquivalentLink(link, existing, excludedLinkId)) {
      throw new Error("That link already exists.");
    }
  }

  if (
    link.kind === "blocks" &&
    wouldCreateBlockingCycle(document, link.sourceType, link.sourceId, link.targetType, link.targetId, excludedLinkId)
  ) {
    throw new Error("That blocking link would create a dependency cycle.");
  }
}

function deleteWorkLinkFromDocument(document: TaskboardDocument, linkId: string, timestamp: string): WorkLink {
  const link = requireWorkLink(document, linkId);
  document.linkIds = removeValue(document.linkIds, linkId);
  delete document.links[linkId];

  touchWorkItemLineageIfPresent(document, link.sourceType, link.sourceId, timestamp);
  touchWorkItemLineageIfPresent(document, link.targetType, link.targetId, timestamp);

  return link;
}

function deleteLinksForItem(document: TaskboardDocument, itemType: WorkItemType, itemId: string, timestamp: string): void {
  for (const linkId of [...document.linkIds]) {
    const link = document.links[linkId];
    if (!link) {
      continue;
    }

    const touchesItem =
      isSameEndpoint(link.sourceType, link.sourceId, itemType, itemId) ||
      isSameEndpoint(link.targetType, link.targetId, itemType, itemId);

    if (!touchesItem) {
      continue;
    }

    document.linkIds = removeValue(document.linkIds, linkId);
    delete document.links[linkId];

    if (!isSameEndpoint(link.sourceType, link.sourceId, itemType, itemId)) {
      touchWorkItemLineageIfPresent(document, link.sourceType, link.sourceId, timestamp);
    }

    if (!isSameEndpoint(link.targetType, link.targetId, itemType, itemId)) {
      touchWorkItemLineageIfPresent(document, link.targetType, link.targetId, timestamp);
    }
  }
}

function deleteTaskFromDocument(document: TaskboardDocument, taskId: string, timestamp: string): void {
  const task = requireTask(document, taskId);
  const story = requireStory(document, task.storyId);

  deleteLinksForItem(document, "task", taskId, timestamp);

  story.taskIds = removeValue(story.taskIds, taskId);
  delete document.tasks[taskId];

  touchStoryLineage(document, story, timestamp);
}

function deleteStoryFromDocument(document: TaskboardDocument, storyId: string, timestamp: string): void {
  const story = requireStory(document, storyId);
  const feature = requireFeature(document, story.featureId);

  for (const taskId of [...story.taskIds]) {
    deleteTaskFromDocument(document, taskId, timestamp);
  }

  feature.storyIds = removeValue(feature.storyIds, storyId);
  delete document.userStories[storyId];
  touchFeatureLineage(document, feature, timestamp);
}

function deleteFeatureFromDocument(document: TaskboardDocument, featureId: string, timestamp: string): void {
  const feature = requireFeature(document, featureId);
  const epic = requireEpic(document, feature.epicId);

  deleteLinksForItem(document, "feature", featureId, timestamp);

  for (const storyId of [...feature.storyIds]) {
    deleteStoryFromDocument(document, storyId, timestamp);
  }

  epic.featureIds = removeValue(epic.featureIds, featureId);
  delete document.features[featureId];
  touchEntity(epic, timestamp);
}

function deleteEpicFromDocument(document: TaskboardDocument, epicId: string, timestamp: string): void {
  const epic = requireEpic(document, epicId);

  for (const featureId of [...epic.featureIds]) {
    deleteFeatureFromDocument(document, featureId, timestamp);
  }

  document.epicIds = removeValue(document.epicIds, epicId);
  delete document.epics[epicId];
}

interface MutationPlan<T> {
  scopes: string[];
  summary: string;
  apply: (document: TaskboardDocument) => T;
}

function nodeScope(nodeType: BoardNodeType, nodeId: string): string {
  return `node:${nodeType}:${nodeId}`;
}

function childrenScope(nodeType: "epic" | "feature" | "story", nodeId: string): string {
  return `children:${nodeType}:${nodeId}`;
}

function commentsScope(nodeType: BoardNodeType, nodeId: string): string {
  return `comments:${nodeType}:${nodeId}`;
}

function commentScope(commentId: string): string {
  return `comment:${commentId}`;
}

function linkCollectionScope(itemType: WorkItemType, itemId: string): string {
  return `links:${itemType}:${itemId}`;
}

function linkScope(linkId: string): string {
  return `link:${linkId}`;
}

function boardBriefScope(): string {
  return "board-brief";
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter(Boolean))];
}

function collectTaskDeletionScopes(taskId: string): string[] {
  return [nodeScope("task", taskId), commentsScope("task", taskId), linkCollectionScope("task", taskId)];
}

function collectStoryDeletionScopes(document: TaskboardDocument, storyId: string): string[] {
  const story = requireStory(document, storyId);
  return dedupeScopes([
    nodeScope("story", story.id),
    commentsScope("story", story.id),
    childrenScope("story", story.id),
    ...story.taskIds.flatMap((taskId) => collectTaskDeletionScopes(taskId))
  ]);
}

function collectFeatureDeletionScopes(document: TaskboardDocument, featureId: string): string[] {
  const feature = requireFeature(document, featureId);
  return dedupeScopes([
    nodeScope("feature", feature.id),
    commentsScope("feature", feature.id),
    childrenScope("feature", feature.id),
    linkCollectionScope("feature", feature.id),
    ...feature.storyIds.flatMap((storyId) => collectStoryDeletionScopes(document, storyId))
  ]);
}

function collectEpicDeletionScopes(document: TaskboardDocument, epicId: string): string[] {
  const epic = requireEpic(document, epicId);
  return dedupeScopes([
    nodeScope("epic", epic.id),
    commentsScope("epic", epic.id),
    childrenScope("epic", epic.id),
    ...epic.featureIds.flatMap((featureId) => collectFeatureDeletionScopes(document, featureId))
  ]);
}

async function runSerializedWrite<T>(action: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(action, action);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function mutateDocument<T>(
  repository: TaskboardRepository,
  buildPlan: (document: TaskboardDocument) => MutationPlan<T>
): Promise<T> {
  return runSerializedWrite(async () => {
    const document = await repository.load();
    const plan = buildPlan(document);
    const currentRevision = document.revision;
    const result = plan.apply(document);
    document.revision = currentRevision + 1;
    document.recentMutations = [];
    await repository.save(document, currentRevision, {
      scopes: plan.scopes,
      summary: plan.summary
    });
    return result;
  });
}

export async function getTaskboard(repository: TaskboardRepository): Promise<TaskboardSnapshot> {
  const document = await repository.load();
  return toSnapshot(document);
}

export async function getBoardBrief(repository: TaskboardRepository): Promise<BoardBrief> {
  const document = await repository.load();
  return document.boardBrief;
}

export async function getMetadata(repository: TaskboardRepository): Promise<BoardBrief> {
  return getBoardBrief(repository);
}

export async function getNodeComment(repository: TaskboardRepository, commentId: string): Promise<NodeComment> {
  const document = await repository.load();
  return requireNodeComment(document, commentId).comment;
}

export async function createNodeComment(repository: TaskboardRepository, input: CreateNodeCommentInput): Promise<NodeComment> {
  return mutateDocument(repository, (document) => {
    const node = requireBoardNodeReference(document, input.nodeType, input.nodeId, input.nodeAlias);
    const timestamp = nowIso();
    const comment: NodeComment = {
      id: createId("comment"),
      author: input.author.trim(),
      kind: input.kind,
      body: input.body.trim(),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [commentsScope(input.nodeType, node.id)],
      summary: `Created ${input.kind} comment on ${input.nodeType} ${node.title}.`,
      apply: (nextDocument) => {
        const nextNode = requireBoardNodeReference(nextDocument, input.nodeType, input.nodeId, input.nodeAlias);
        nextNode.comments.push(comment);
        touchBoardNodeLineage(nextDocument, input.nodeType, nextNode, timestamp);
        return comment;
      }
    };
  });
}

export async function updateNodeComment(
  repository: TaskboardRepository,
  commentId: string,
  patch: UpdateNodeCommentInput
): Promise<NodeComment> {
  return mutateDocument(repository, (document) => {
    const existing = requireNodeComment(document, commentId);
    const updatedAt = nowIso();
    const nextComment: NodeComment = {
      ...existing.comment,
      ...patch,
      author: patch.author?.trim() ?? existing.comment.author,
      body: patch.body?.trim() ?? existing.comment.body,
      updatedAt
    };

    return {
      scopes: [commentScope(commentId)],
      summary: `Updated comment ${commentId}.`,
      apply: (nextDocument) => {
        const nextExisting = requireNodeComment(nextDocument, commentId);
        nextExisting.node.comments[nextExisting.commentIndex] = nextComment;
        touchBoardNodeLineage(nextDocument, nextExisting.nodeType, nextExisting.node, updatedAt);
        return nextComment;
      }
    };
  });
}

export async function deleteNodeComment(
  repository: TaskboardRepository,
  commentId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const existing = requireNodeComment(document, commentId);
    const timestamp = nowIso();
    return {
      scopes: [commentScope(commentId)],
      summary: `Deleted comment ${commentId}.`,
      apply: (nextDocument) => {
        const nextExisting = requireNodeComment(nextDocument, commentId);
        nextExisting.node.comments.splice(nextExisting.commentIndex, 1);
        touchBoardNodeLineage(nextDocument, nextExisting.nodeType, nextExisting.node, timestamp);
        return { deletedId: commentId };
      }
    };
  });
}

export async function updateBoardBrief(
  repository: TaskboardRepository,
  patch: BoardBriefPatch
): Promise<BoardBrief> {
  return mutateDocument(repository, (document) => {
    const nextPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Partial<BoardBrief>;

    return {
      scopes: [boardBriefScope()],
      summary: "Updated board brief.",
      apply: (nextDocument) => {
        nextDocument.boardBrief = {
          ...nextDocument.boardBrief,
          ...nextPatch,
          updatedAt: nowIso()
        };

        return nextDocument.boardBrief;
      }
    };
  });
}

export async function updateMetadata(
  repository: TaskboardRepository,
  patch: BoardBriefPatch
): Promise<BoardBrief> {
  return updateBoardBrief(repository, patch);
}

export async function listEpics(repository: TaskboardRepository): Promise<Epic[]> {
  const document = await repository.load();
  return document.epicIds.map((epicId) => document.epics[epicId]).filter(Boolean);
}

export async function getEpic(repository: TaskboardRepository, epicId: string): Promise<Epic> {
  const document = await repository.load();
  return requireEpic(document, epicId);
}

export async function createEpic(
  repository: TaskboardRepository,
  input: CreateEpicInput
): Promise<Epic> {
  return mutateDocument(repository, (document) => {
    const timestamp = nowIso();
    const epicId = createId("epic");
    const epic: Epic = {
      id: epicId,
      alias: buildEntityAlias(document, input.alias, input.title, epicId),
      title: input.title,
      summary: input.summary,
      status: input.status,
      priority: input.priority,
      comments: [],
      featureIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [],
      summary: `Created epic ${epic.title}.`,
      apply: (nextDocument) => {
        nextDocument.epics[epic.id] = epic;
        nextDocument.epicIds.push(epic.id);
        return epic;
      }
    };
  });
}

export async function updateEpic(
  repository: TaskboardRepository,
  epicId: string,
  patch: UpdateEpicInput
): Promise<Epic> {
  return mutateDocument(repository, (document) => {
    const epic = requireEpic(document, epicId);
    const nextAlias = patch.alias ? buildEntityAlias(document, patch.alias, patch.title ?? epic.title, epic.id, epic.id) : epic.alias;
    return {
      scopes: [nodeScope("epic", epicId)],
      summary: `Updated epic ${epic.title}.`,
      apply: (nextDocument) => {
        const nextEpic = requireEpic(nextDocument, epicId);
        Object.assign(nextEpic, patch, { alias: nextAlias });
        touchEntity(nextEpic, nowIso());
        return nextEpic;
      }
    };
  });
}

export async function deleteEpic(
  repository: TaskboardRepository,
  epicId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const epic = requireEpic(document, epicId);
    return {
      scopes: collectEpicDeletionScopes(document, epicId),
      summary: `Deleted epic ${epic.title}.`,
      apply: (nextDocument) => {
        deleteEpicFromDocument(nextDocument, epicId, nowIso());
        return { deletedId: epicId };
      }
    };
  });
}

export async function listFeatures(repository: TaskboardRepository, epicId?: string, epicAlias?: string): Promise<Feature[]> {
  const document = await repository.load();

  if (!epicId && !epicAlias) {
    return Object.values(document.features);
  }

  const epic = requireEpicReference(document, epicId, epicAlias);
  return epic.featureIds.map((featureId) => document.features[featureId]).filter(Boolean);
}

export async function getFeature(repository: TaskboardRepository, featureId: string): Promise<Feature> {
  const document = await repository.load();
  return requireFeature(document, featureId);
}

export async function createFeature(
  repository: TaskboardRepository,
  input: CreateFeatureInput
): Promise<Feature> {
  return mutateDocument(repository, (document) => {
    const epic = requireEpicReference(document, input.epicId, input.epicAlias);
    const timestamp = nowIso();
    const featureId = createId("feature");
    const feature: Feature = {
      id: featureId,
      alias: buildEntityAlias(document, input.alias, input.title, featureId),
      epicId: epic.id,
      title: input.title,
      summary: input.summary,
      status: input.status,
      priority: input.priority,
      comments: [],
      storyIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [childrenScope("epic", epic.id)],
      summary: `Created feature ${feature.title} under epic ${epic.title}.`,
      apply: (nextDocument) => {
        const nextEpic = requireEpicReference(nextDocument, input.epicId, input.epicAlias);
        nextDocument.features[feature.id] = feature;
        nextEpic.featureIds.push(feature.id);
        touchEntity(nextEpic, timestamp);
        return feature;
      }
    };
  });
}

export async function updateFeature(
  repository: TaskboardRepository,
  featureId: string,
  patch: UpdateFeatureInput
): Promise<Feature> {
  return mutateDocument(repository, (document) => {
    const feature = requireFeature(document, featureId);
    const nextAlias = patch.alias ? buildEntityAlias(document, patch.alias, patch.title ?? feature.title, feature.id, feature.id) : feature.alias;
    return {
      scopes: [nodeScope("feature", featureId)],
      summary: `Updated feature ${feature.title}.`,
      apply: (nextDocument) => {
        const nextFeature = requireFeature(nextDocument, featureId);
        Object.assign(nextFeature, patch, { alias: nextAlias });
        touchFeatureLineage(nextDocument, nextFeature, nowIso());
        return nextFeature;
      }
    };
  });
}

export async function deleteFeature(
  repository: TaskboardRepository,
  featureId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const feature = requireFeature(document, featureId);
    return {
      scopes: collectFeatureDeletionScopes(document, featureId),
      summary: `Deleted feature ${feature.title}.`,
      apply: (nextDocument) => {
        deleteFeatureFromDocument(nextDocument, featureId, nowIso());
        return { deletedId: featureId };
      }
    };
  });
}

export async function listUserStories(repository: TaskboardRepository, featureId?: string, featureAlias?: string): Promise<UserStory[]> {
  const document = await repository.load();

  if (!featureId && !featureAlias) {
    return Object.values(document.userStories);
  }

  const feature = requireFeatureReference(document, featureId, featureAlias);
  return feature.storyIds.map((storyId) => document.userStories[storyId]).filter(Boolean);
}

export async function getUserStory(repository: TaskboardRepository, storyId: string): Promise<UserStory> {
  const document = await repository.load();
  return requireStory(document, storyId);
}

export async function createUserStory(
  repository: TaskboardRepository,
  input: CreateUserStoryInput
): Promise<UserStory> {
  return mutateDocument(repository, (document) => {
    const feature = requireFeatureReference(document, input.featureId, input.featureAlias);
    const timestamp = nowIso();
    const storyId = createId("story");
    const story: UserStory = {
      id: storyId,
      alias: buildEntityAlias(document, input.alias, input.title, storyId),
      featureId: feature.id,
      title: input.title,
      summary: input.summary,
      status: input.status,
      priority: input.priority,
      comments: [],
      acceptanceCriteria: input.acceptanceCriteria,
      taskIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [childrenScope("feature", feature.id)],
      summary: `Created story ${story.title} under feature ${feature.title}.`,
      apply: (nextDocument) => {
        const nextFeature = requireFeatureReference(nextDocument, input.featureId, input.featureAlias);
        nextDocument.userStories[story.id] = story;
        nextFeature.storyIds.push(story.id);
        touchFeatureLineage(nextDocument, nextFeature, timestamp);
        return story;
      }
    };
  });
}

export async function updateUserStory(
  repository: TaskboardRepository,
  storyId: string,
  patch: UpdateUserStoryInput
): Promise<UserStory> {
  return mutateDocument(repository, (document) => {
    const story = requireStory(document, storyId);
    const nextAlias = patch.alias ? buildEntityAlias(document, patch.alias, patch.title ?? story.title, story.id, story.id) : story.alias;
    return {
      scopes: [nodeScope("story", storyId)],
      summary: `Updated story ${story.title}.`,
      apply: (nextDocument) => {
        const nextStory = requireStory(nextDocument, storyId);
        Object.assign(nextStory, patch, { alias: nextAlias });
        touchStoryLineage(nextDocument, nextStory, nowIso());
        return nextStory;
      }
    };
  });
}

export async function deleteUserStory(
  repository: TaskboardRepository,
  storyId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const story = requireStory(document, storyId);
    return {
      scopes: collectStoryDeletionScopes(document, storyId),
      summary: `Deleted story ${story.title}.`,
      apply: (nextDocument) => {
        deleteStoryFromDocument(nextDocument, storyId, nowIso());
        return { deletedId: storyId };
      }
    };
  });
}

export async function listTasks(repository: TaskboardRepository, storyId?: string, storyAlias?: string): Promise<Task[]> {
  const document = await repository.load();

  if (!storyId && !storyAlias) {
    return Object.values(document.tasks);
  }

  const story = requireStoryReference(document, storyId, storyAlias);
  return story.taskIds.map((taskId) => document.tasks[taskId]).filter(Boolean);
}

export async function getTask(repository: TaskboardRepository, taskId: string): Promise<Task> {
  const document = await repository.load();
  return requireTask(document, taskId);
}

export async function createTask(
  repository: TaskboardRepository,
  input: CreateTaskInput
): Promise<Task> {
  return mutateDocument(repository, (document) => {
    const story = requireStoryReference(document, input.storyId, input.storyAlias);
    const timestamp = nowIso();
    const taskId = createId("task");
    const task: Task = {
      id: taskId,
      alias: buildEntityAlias(document, input.alias, input.title, taskId),
      storyId: story.id,
      title: input.title,
      summary: input.summary,
      status: input.status,
      priority: input.priority,
      comments: [],
      implementationNotes: input.implementationNotes,
      estimate: input.estimate,
      tags: input.tags,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [childrenScope("story", story.id)],
      summary: `Created task ${task.title} under story ${story.title}.`,
      apply: (nextDocument) => {
        const nextStory = requireStoryReference(nextDocument, input.storyId, input.storyAlias);
        nextDocument.tasks[task.id] = task;
        nextStory.taskIds.push(task.id);
        touchStoryLineage(nextDocument, nextStory, timestamp);
        return task;
      }
    };
  });
}

export async function updateTask(
  repository: TaskboardRepository,
  taskId: string,
  patch: UpdateTaskInput
): Promise<Task> {
  return mutateDocument(repository, (document) => {
    const task = requireTask(document, taskId);
    const nextAlias = patch.alias ? buildEntityAlias(document, patch.alias, patch.title ?? task.title, task.id, task.id) : task.alias;
    return {
      scopes: [nodeScope("task", taskId)],
      summary: `Updated task ${task.title}.`,
      apply: (nextDocument) => {
        const nextTask = requireTask(nextDocument, taskId);
        Object.assign(nextTask, patch, { alias: nextAlias });
        touchTaskLineage(nextDocument, nextTask, nowIso());
        return nextTask;
      }
    };
  });
}

export async function deleteTask(
  repository: TaskboardRepository,
  taskId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const task = requireTask(document, taskId);
    return {
      scopes: collectTaskDeletionScopes(taskId),
      summary: `Deleted task ${task.title}.`,
      apply: (nextDocument) => {
        deleteTaskFromDocument(nextDocument, taskId, nowIso());
        return { deletedId: taskId };
      }
    };
  });
}

export async function resolveNode(repository: TaskboardRepository, input: ResolveNodeInput): Promise<BoardNodeSummary> {
  const document = await repository.load();

  if (input.id) {
    switch (input.type) {
      case "epic":
        return toNodeSummary(document, "epic", requireEpic(document, input.id));
      case "feature":
        return toNodeSummary(document, "feature", requireFeature(document, input.id));
      case "story":
        return toNodeSummary(document, "story", requireStory(document, input.id));
      case "task":
        return toNodeSummary(document, "task", requireTask(document, input.id));
    }
  }

  const node = input.alias ? findNodeByAlias(document, input.alias) : null;
  if (!node || node.type !== input.type) {
    throw new NotFoundError(`${input.type} ${input.alias ?? input.id ?? ""} was not found.`);
  }

  return node;
}

export async function findNodes(repository: TaskboardRepository, input: FindNodesInput): Promise<BoardNodeSummary[]> {
  const document = await repository.load();
  const normalizedQuery = normalizeAliasValue(input.query);
  const loweredQuery = input.query.toLowerCase().trim();

  return getAllNodeSummaries(document)
    .filter((node) => !input.type || node.type === input.type)
    .map((node) => {
      const aliasExact = node.alias === normalizedQuery ? 0 : node.alias.startsWith(normalizedQuery) ? 1 : node.alias.includes(normalizedQuery) ? 2 : 99;
      const titleLower = node.title.toLowerCase();
      const titleExact = titleLower === loweredQuery ? 0 : titleLower.startsWith(loweredQuery) ? 1 : titleLower.includes(loweredQuery) ? 2 : 99;
      const score = Math.min(aliasExact, titleExact);
      return { node, score };
    })
    .filter((entry) => entry.score < 99)
    .sort((left, right) => left.score - right.score || left.node.title.localeCompare(right.node.title))
    .slice(0, input.limit)
    .map((entry) => entry.node);
}

export async function listWorkLinks(repository: TaskboardRepository): Promise<WorkLink[]> {
  const document = await repository.load();
  return document.linkIds.map((linkId) => document.links[linkId]).filter(Boolean);
}

export async function getWorkLink(repository: TaskboardRepository, linkId: string): Promise<WorkLink> {
  const document = await repository.load();
  return requireWorkLink(document, linkId);
}

export async function createWorkLink(
  repository: TaskboardRepository,
  input: CreateWorkLinkInput
): Promise<WorkLink> {
  return mutateDocument(repository, (document) => {
    const timestamp = nowIso();
    const source = resolveWorkItemReference(document, input.sourceType, input.sourceId, input.sourceAlias, "source");
    const target = resolveWorkItemReference(document, input.targetType, input.targetId, input.targetAlias, "target");
    const link: WorkLink = {
      id: createId("link"),
      sourceType: source.itemType,
      sourceId: source.itemId,
      targetType: target.itemType,
      targetId: target.itemId,
      kind: input.kind,
      note: input.note,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    return {
      scopes: [linkCollectionScope(link.sourceType, link.sourceId), linkCollectionScope(link.targetType, link.targetId)],
      summary: `Created ${link.kind} link from ${link.sourceType} ${link.sourceId} to ${link.targetType} ${link.targetId}.`,
      apply: (nextDocument) => {
        assertWorkLink(nextDocument, link);
        nextDocument.links[link.id] = link;
        nextDocument.linkIds.push(link.id);
        touchWorkItemLineageIfPresent(nextDocument, link.sourceType, link.sourceId, timestamp);
        touchWorkItemLineageIfPresent(nextDocument, link.targetType, link.targetId, timestamp);
        return link;
      }
    };
  });
}

export async function updateWorkLink(
  repository: TaskboardRepository,
  linkId: string,
  patch: UpdateWorkLinkInput
): Promise<WorkLink> {
  return mutateDocument(repository, (document) => {
    const existing = requireWorkLink(document, linkId);
    const nextLink: WorkLink = {
      ...existing,
      ...patch,
      updatedAt: nowIso()
    };

    return {
      scopes: [linkScope(linkId), linkCollectionScope(existing.sourceType, existing.sourceId), linkCollectionScope(existing.targetType, existing.targetId)],
      summary: `Updated link ${linkId}.`,
      apply: (nextDocument) => {
        assertWorkLink(nextDocument, nextLink, linkId);
        nextDocument.links[linkId] = nextLink;
        touchWorkItemLineageIfPresent(nextDocument, nextLink.sourceType, nextLink.sourceId, nextLink.updatedAt);
        touchWorkItemLineageIfPresent(nextDocument, nextLink.targetType, nextLink.targetId, nextLink.updatedAt);
        return nextLink;
      }
    };
  });
}

export async function deleteWorkLink(
  repository: TaskboardRepository,
  linkId: string
): Promise<{ deletedId: string }> {
  return mutateDocument(repository, (document) => {
    const link = requireWorkLink(document, linkId);
    return {
      scopes: [linkScope(linkId), linkCollectionScope(link.sourceType, link.sourceId), linkCollectionScope(link.targetType, link.targetId)],
      summary: `Deleted link ${linkId}.`,
      apply: (nextDocument) => {
        deleteWorkLinkFromDocument(nextDocument, linkId, nowIso());
        return { deletedId: linkId };
      }
    };
  });
}
