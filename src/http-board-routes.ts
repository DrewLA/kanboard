import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { NotFoundError } from "./application-errors";
import type { AppConfig } from "./config";
import { sendAttachmentContent } from "./http-attachments";
import {
  boardBriefPatchSchema,
  createAttachmentUploadInputSchema,
  createEpicInputSchema,
  createFeatureInputSchema,
  createNodeCommentInputSchema,
  createTaskInputSchema,
  createUserStoryInputSchema,
  createWorkLinkInputSchema,
  findNodesInputSchema,
  resolveNodeInputSchema,
  updateEpicInputSchema,
  updateFeatureInputSchema,
  updateNodeCommentInputSchema,
  updateTaskInputSchema,
  updateUserStoryInputSchema,
  updateWorkLinkInputSchema
} from "./model";
import type { TaskboardRepository } from "./repository";
import { buildWorkItemAttachmentKey, createAttachmentUploadUrl, normalizeAttachmentToken } from "./r2";
import {
  createEpic,
  createFeature,
  createNodeComment,
  createTask,
  createUserStory,
  createWorkLink,
  deleteEpic,
  deleteFeature,
  deleteNodeComment,
  deleteTask,
  deleteUserStory,
  deleteWorkLink,
  emptyRecycleBin,
  findNodes,
  getBoardBrief,
  getEpic,
  getFeature,
  getNodeComment,
  getTask,
  getTaskboard,
  getUserStory,
  getWorkLink,
  listEpics,
  listFeatures,
  listNotifications,
  listRecycleBin,
  listTasks,
  listUserStories,
  listWorkLinks,
  permanentDeleteRecycleEntry,
  readNodeNotifications,
  resolveNode,
  restoreFromRecycleBin,
  updateBoardBrief,
  updateEpic,
  updateFeature,
  updateNodeComment,
  updateTask,
  updateUserStory,
  updateWorkLink
} from "./taskboard-service";

const readNodeNotificationsInputSchema = z.object({
  nodeId: z.string().min(1),
  sourceType: z.enum(["comment", "field"]).optional()
});

function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

export function registerBoardRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: TaskboardRepository
): void {
  app.get("/api/bootstrap", async () => {
    const [taskboard, currentUser, users] = await Promise.all([
      getTaskboard(repository),
      repository.getCurrentUser?.() ?? null,
      repository.listUsers?.() ?? []
    ]);
    const notifications = currentUser?.id
      ? await listNotifications(repository, currentUser.id)
      : [];

    return { taskboard, currentUser, users, notifications };
  });

  app.get("/api/users", async () => repository.listUsers?.() ?? []);
  app.get("/api/users/me", async () => repository.getCurrentUser?.() ?? null);
  app.get("/api/taskboard", async () => getTaskboard(repository));
  app.get("/api/nodes/resolve", async (request) => resolveNode(repository, parse(resolveNodeInputSchema, request.query)));
  app.get("/api/nodes/search", async (request) => findNodes(repository, parse(findNodesInputSchema, request.query)));

  app.get("/api/board-brief", async () => getBoardBrief(repository));
  app.put("/api/board-brief", async (request) => updateBoardBrief(repository, parse(boardBriefPatchSchema, request.body)));

  app.get("/api/notifications", async () => {
    const currentUser = await repository.getCurrentUser?.();
    return currentUser?.id ? listNotifications(repository, currentUser.id) : [];
  });

  app.post("/api/notifications/read-node", async (request) => {
    const { nodeId, sourceType } = parse(readNodeNotificationsInputSchema, request.body);
    const currentUser = await repository.getCurrentUser?.();
    if (currentUser?.id) await readNodeNotifications(repository, currentUser.id, nodeId, sourceType);
    return { ok: true };
  });

  app.get("/api/recycle-bin", async () => listRecycleBin(repository));
  app.post("/api/recycle-bin/:entryId/restore", async (request) =>
    restoreFromRecycleBin(repository, (request.params as { entryId: string }).entryId)
  );
  app.delete("/api/recycle-bin/:entryId", async (request) => {
    await permanentDeleteRecycleEntry(repository, (request.params as { entryId: string }).entryId);
    return { ok: true };
  });
  app.delete("/api/recycle-bin", async () => {
    await emptyRecycleBin(repository);
    return { ok: true };
  });

  app.post("/api/comments", async (request) => createNodeComment(repository, parse(createNodeCommentInputSchema, request.body)));
  app.get("/api/comments/:commentId", async (request) => getNodeComment(repository, (request.params as { commentId: string }).commentId));
  app.patch("/api/comments/:commentId", async (request) =>
    updateNodeComment(repository, (request.params as { commentId: string }).commentId, parse(updateNodeCommentInputSchema, request.body))
  );
  app.delete("/api/comments/:commentId", async (request) => deleteNodeComment(repository, (request.params as { commentId: string }).commentId));

  app.get("/api/epics", async () => listEpics(repository));
  app.post("/api/epics", async (request) => createEpic(repository, parse(createEpicInputSchema, request.body)));
  app.get("/api/epics/:epicId", async (request) => getEpic(repository, (request.params as { epicId: string }).epicId));
  app.post("/api/epics/:epicId/upload-url", async (request) => {
    const epicId = (request.params as { epicId: string }).epicId;
    await getEpic(repository, epicId);
    const input = parse(createAttachmentUploadInputSchema, request.body);
    const attachmentId = normalizeAttachmentToken(input.attachmentId ?? randomUUID());
    const key = buildWorkItemAttachmentKey("epic", epicId, attachmentId, input.kind, input.fileName, input.relativePath);
    return createAttachmentUploadUrl(config, key, input.contentType);
  });
  app.get("/api/epics/:epicId/attachments/:attachmentId/content", async (request, reply) => {
    const { epicId, attachmentId } = request.params as { epicId: string; attachmentId: string };
    const epic = await getEpic(repository, epicId);
    const attachment = epic.attachments.find((entry) => entry.id === attachmentId);
    if (!attachment) throw new NotFoundError(`Attachment ${attachmentId} was not found on epic ${epicId}.`);
    return sendAttachmentContent(config, reply, attachment, attachmentId, `epic ${epicId}`, (request.query as { download?: string }).download);
  });
  app.patch("/api/epics/:epicId", async (request) =>
    updateEpic(repository, (request.params as { epicId: string }).epicId, parse(updateEpicInputSchema, request.body))
  );
  app.delete("/api/epics/:epicId", async (request) => deleteEpic(repository, (request.params as { epicId: string }).epicId));

  app.get("/api/features", async (request) => {
    const query = request.query as { epicId?: string; epicAlias?: string };
    return listFeatures(repository, query.epicId, query.epicAlias);
  });
  app.post("/api/features", async (request) => createFeature(repository, parse(createFeatureInputSchema, request.body)));
  app.get("/api/features/:featureId", async (request) => getFeature(repository, (request.params as { featureId: string }).featureId));
  app.post("/api/features/:featureId/upload-url", async (request) => {
    const featureId = (request.params as { featureId: string }).featureId;
    await getFeature(repository, featureId);
    const input = parse(createAttachmentUploadInputSchema, request.body);
    const attachmentId = normalizeAttachmentToken(input.attachmentId ?? randomUUID());
    const key = buildWorkItemAttachmentKey("feature", featureId, attachmentId, input.kind, input.fileName, input.relativePath);
    return createAttachmentUploadUrl(config, key, input.contentType);
  });
  app.get("/api/features/:featureId/attachments/:attachmentId/content", async (request, reply) => {
    const { featureId, attachmentId } = request.params as { featureId: string; attachmentId: string };
    const feature = await getFeature(repository, featureId);
    const attachment = feature.attachments.find((entry) => entry.id === attachmentId);
    if (!attachment) throw new NotFoundError(`Attachment ${attachmentId} was not found on feature ${featureId}.`);
    return sendAttachmentContent(config, reply, attachment, attachmentId, `feature ${featureId}`, (request.query as { download?: string }).download);
  });
  app.patch("/api/features/:featureId", async (request) =>
    updateFeature(repository, (request.params as { featureId: string }).featureId, parse(updateFeatureInputSchema, request.body))
  );
  app.delete("/api/features/:featureId", async (request) => deleteFeature(repository, (request.params as { featureId: string }).featureId));

  app.get("/api/stories", async (request) => {
    const query = request.query as { featureId?: string; featureAlias?: string };
    return listUserStories(repository, query.featureId, query.featureAlias);
  });
  app.post("/api/stories", async (request) => createUserStory(repository, parse(createUserStoryInputSchema, request.body)));
  app.get("/api/stories/:storyId", async (request) => getUserStory(repository, (request.params as { storyId: string }).storyId));
  app.patch("/api/stories/:storyId", async (request) =>
    updateUserStory(repository, (request.params as { storyId: string }).storyId, parse(updateUserStoryInputSchema, request.body))
  );
  app.delete("/api/stories/:storyId", async (request) => deleteUserStory(repository, (request.params as { storyId: string }).storyId));

  app.get("/api/tasks", async (request) => {
    const query = request.query as { storyId?: string; storyAlias?: string };
    return listTasks(repository, query.storyId, query.storyAlias);
  });
  app.post("/api/tasks", async (request) => createTask(repository, parse(createTaskInputSchema, request.body)));
  app.get("/api/tasks/:taskId", async (request) => getTask(repository, (request.params as { taskId: string }).taskId));
  app.post("/api/tasks/:taskId/upload-url", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    await getTask(repository, taskId);
    const input = parse(createAttachmentUploadInputSchema, request.body);
    const attachmentId = normalizeAttachmentToken(input.attachmentId ?? randomUUID());
    const key = buildWorkItemAttachmentKey("task", taskId, attachmentId, input.kind, input.fileName, input.relativePath);
    return createAttachmentUploadUrl(config, key, input.contentType);
  });
  app.get("/api/tasks/:taskId/attachments/:attachmentId/content", async (request, reply) => {
    const { taskId, attachmentId } = request.params as { taskId: string; attachmentId: string };
    const task = await getTask(repository, taskId);
    const attachment = task.attachments.find((entry) => entry.id === attachmentId);
    if (!attachment) throw new NotFoundError(`Attachment ${attachmentId} was not found on task ${taskId}.`);
    return sendAttachmentContent(config, reply, attachment, attachmentId, `task ${taskId}`, (request.query as { download?: string }).download);
  });
  app.patch("/api/tasks/:taskId", async (request) =>
    updateTask(repository, (request.params as { taskId: string }).taskId, parse(updateTaskInputSchema, request.body))
  );
  app.delete("/api/tasks/:taskId", async (request) => deleteTask(repository, (request.params as { taskId: string }).taskId));

  app.get("/api/links", async () => listWorkLinks(repository));
  app.post("/api/links", async (request) => createWorkLink(repository, parse(createWorkLinkInputSchema, request.body)));
  app.get("/api/links/:linkId", async (request) => getWorkLink(repository, (request.params as { linkId: string }).linkId));
  app.patch("/api/links/:linkId", async (request) =>
    updateWorkLink(repository, (request.params as { linkId: string }).linkId, parse(updateWorkLinkInputSchema, request.body))
  );
  app.delete("/api/links/:linkId", async (request) => deleteWorkLink(repository, (request.params as { linkId: string }).linkId));
}
