import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import {
  boardBriefPatchSchema,
  createNodeCommentInputSchema,
  createEpicInputSchema,
  createFeatureInputSchema,
  createTaskInputSchema,
  createUserStoryInputSchema,
  createWorkLinkInputSchema,
  findNodesInputSchema,
  resolveNodeInputSchema,
  updateNodeCommentInputSchema,
  updateEpicInputSchema,
  updateFeatureInputSchema,
  updateTaskInputSchema,
  updateUserStoryInputSchema,
  updateWorkLinkInputSchema
} from "./model";
import {
  RepositoryAccessError,
  RepositoryConflictError,
  TaskboardRepository
} from "./repository";
import {
  NotFoundError,
  createNodeComment,
  createEpic,
  createFeature,
  createTask,
  createUserStory,
  createWorkLink,
  deleteNodeComment,
  deleteEpic,
  deleteFeature,
  deleteTask,
  deleteUserStory,
  deleteWorkLink,
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
  listTasks,
  listUserStories,
  listWorkLinks,
  resolveNode,
  updateBoardBrief,
  updateEpic,
  updateFeature,
  updateNodeComment,
  updateTask,
  updateUserStory,
  updateWorkLink,
  withMcpMutationSource
} from "./taskboard-service";

export const toolDefinitions = [
  {
    name: "get_taskboard",
    description: "Return the full agile taskboard snapshot with the board brief, hierarchy, and links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_board_brief",
    description: "Return the top-level BoardBrief that defines what all epics are collectively delivering.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_metadata",
    description: "Compatibility alias for get_board_brief.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_epics",
    description: "List all epics without loading the full taskboard snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_epic",
    description: "Get one epic by id.",
    inputSchema: {
      type: "object",
      required: ["epicId"],
      properties: { epicId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "resolve_node",
    description: "Resolve a single epic, feature, story, or task by id or alias and return a compact summary.",
    inputSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["epic", "feature", "story", "task"] },
        id: { type: "string" },
        alias: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "find_nodes",
    description: "Search epics, features, stories, and tasks by alias or title and return compact matches.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["epic", "feature", "story", "task"] },
        limit: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_board_brief",
    description: "Update the top-level BoardBrief.",
    inputSchema: {
      type: "object",
      properties: {
        productName: { type: "string" },
        objective: { type: "string" },
        scopeDefinition: { type: "string" },
        nonGoals: { type: "string" },
        successCriteria: { type: "string" },
        implementationNotes: { type: "string" },
        currentFocus: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_metadata",
    description: "Compatibility alias for update_board_brief.",
    inputSchema: {
      type: "object",
      properties: {
        productName: { type: "string" },
        objective: { type: "string" },
        scopeDefinition: { type: "string" },
        nonGoals: { type: "string" },
        successCriteria: { type: "string" },
        implementationNotes: { type: "string" },
        currentFocus: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_comment",
    description: "Create a comment on an epic, feature, story, or task.",
    inputSchema: {
      type: "object",
      required: ["nodeType", "author", "body"],
      properties: {
        nodeType: { type: "string", enum: ["epic", "feature", "story", "task"] },
        nodeId: { type: "string" },
        nodeAlias: { type: "string" },
        author: { type: "string" },
        kind: { type: "string", enum: ["note", "requirement", "blocker"] },
        body: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_comment",
    description: "Get a single node comment by id.",
    inputSchema: {
      type: "object",
      required: ["commentId"],
      properties: { commentId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "update_comment",
    description: "Update a node comment by id.",
    inputSchema: {
      type: "object",
      required: ["commentId"],
      properties: {
        commentId: { type: "string" },
        author: { type: "string" },
        kind: { type: "string", enum: ["note", "requirement", "blocker"] },
        body: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_comment",
    description: "Delete a node comment by id.",
    inputSchema: {
      type: "object",
      required: ["commentId"],
      properties: { commentId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "create_epic",
    description: "Create a new epic.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_epic",
    description: "Update an epic by id.",
    inputSchema: {
      type: "object",
      required: ["epicId"],
      properties: {
        epicId: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_epic",
    description: "Delete an epic and all descendants.",
    inputSchema: {
      type: "object",
      required: ["epicId"],
      properties: { epicId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "create_feature",
    description: "Create a feature under an epic.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        epicId: { type: "string" },
        epicAlias: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_feature",
    description: "Update a feature by id.",
    inputSchema: {
      type: "object",
      required: ["featureId"],
      properties: {
        featureId: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_feature",
    description: "Delete a feature and all descendants.",
    inputSchema: {
      type: "object",
      required: ["featureId"],
      properties: { featureId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "list_features",
    description: "List features, optionally scoped to an epic by id or alias.",
    inputSchema: {
      type: "object",
      properties: { epicId: { type: "string" }, epicAlias: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "get_feature",
    description: "Get one feature by id.",
    inputSchema: {
      type: "object",
      required: ["featureId"],
      properties: { featureId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "create_user_story",
    description: "Create a user story under a feature.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        featureId: { type: "string" },
        featureAlias: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_user_story",
    description: "Update a user story by id.",
    inputSchema: {
      type: "object",
      required: ["storyId"],
      properties: {
        storyId: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_user_story",
    description: "Delete a user story and all tasks under it.",
    inputSchema: {
      type: "object",
      required: ["storyId"],
      properties: { storyId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "list_user_stories",
    description: "List user stories, optionally scoped to a feature by id or alias.",
    inputSchema: {
      type: "object",
      properties: { featureId: { type: "string" }, featureAlias: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "get_user_story",
    description: "Get one user story by id.",
    inputSchema: {
      type: "object",
      required: ["storyId"],
      properties: { storyId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "create_task",
    description: "Create a task under a user story.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        storyId: { type: "string" },
        storyAlias: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        implementationNotes: { type: "string" },
        estimate: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        assignedTo: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_task",
    description: "Update a task by id.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        alias: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        implementationNotes: { type: "string" },
        estimate: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        assignedTo: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_task",
    description: "Delete a task by id.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "list_tasks",
    description: "List tasks, optionally scoped to a user story by id or alias.",
    inputSchema: {
      type: "object",
      properties: { storyId: { type: "string" }, storyAlias: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "get_task",
    description: "Get one task by id.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "list_links",
    description: "List all feature/task links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_link",
    description: "Get a single link by id.",
    inputSchema: {
      type: "object",
      required: ["linkId"],
      properties: { linkId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "create_link",
    description: "Create a link between a feature or task using ids or aliases.",
    inputSchema: {
      type: "object",
      properties: {
        sourceType: { type: "string", enum: ["feature", "task"] },
        sourceId: { type: "string" },
        sourceAlias: { type: "string" },
        targetType: { type: "string", enum: ["feature", "task"] },
        targetId: { type: "string" },
        targetAlias: { type: "string" },
        kind: { type: "string", enum: ["blocks", "relates-to"] },
        note: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "update_link",
    description: "Update a link note or kind by id.",
    inputSchema: {
      type: "object",
      required: ["linkId"],
      properties: {
        linkId: { type: "string" },
        kind: { type: "string", enum: ["blocks", "relates-to"] },
        note: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "delete_link",
    description: "Delete a link by id.",
    inputSchema: {
      type: "object",
      required: ["linkId"],
      properties: { linkId: { type: "string" } },
      additionalProperties: false
    }
  }
] as const;

function toText(result: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function toToolError(error: unknown) {
  if (error instanceof RepositoryAccessError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              recovery: error.recovery
            }
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  if (error instanceof RepositoryConflictError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: "KB_STORAGE_CONFLICT",
              message: error.message,
              recovery: "Reload board state and retry. If conflicts continue, check for another process or client writing to the same board.",
              detail: {
                operation: error.operation,
                expectedRevision: error.expectedRevision,
                currentRevision: error.currentRevision
              }
            }
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  if (error instanceof NotFoundError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: "KB_NOT_FOUND",
              message: error.message,
              recovery: "Refresh node references and retry with current ids or aliases."
            }
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  if (error instanceof ZodError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: "KB_INVALID_INPUT",
              message: "Invalid tool input payload.",
              recovery: "Validate required fields and enum values, then retry.",
              detail: error.flatten()
            }
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  if (error instanceof Error && error.message.startsWith("Unknown tool:")) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: "KB_UNKNOWN_TOOL",
              message: error.message,
              recovery: "Use list_tools to discover supported MCP tool names, then retry with a valid name."
            }
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "KB_INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unexpected MCP tool error.",
            recovery: "Retry the request. If it still fails, inspect server logs and verify local storage and DB configuration."
          }
        }, null, 2)
      }
    ],
    isError: true
  };
}

export function buildMcpServer(repository: TaskboardRepository): Server {
  const server = new Server(
    {
      name: "private-taskboard-mcp",
      version: "0.1.0"
    },
    {
      capabilities: { tools: {} }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefinitions] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return withMcpMutationSource(async () => {
    try {
      const args = request.params.arguments ?? {};

      switch (request.params.name) {
        case "get_taskboard":
          return toText(await getTaskboard(repository));
        case "get_board_brief":
        case "get_metadata":
          return toText(await getBoardBrief(repository));
        case "list_epics":
          return toText(await listEpics(repository));
        case "get_epic":
          return toText(await getEpic(repository, String((args as { epicId: string }).epicId)));
        case "resolve_node":
          return toText(await resolveNode(repository, resolveNodeInputSchema.parse(args)));
        case "find_nodes":
          return toText(await findNodes(repository, findNodesInputSchema.parse(args)));
        case "update_board_brief":
        case "update_metadata":
          return toText(await updateBoardBrief(repository, boardBriefPatchSchema.parse(args)));
        case "create_comment":
          return toText(await createNodeComment(repository, createNodeCommentInputSchema.parse(args)));
        case "get_comment":
          return toText(await getNodeComment(repository, String((args as { commentId: string }).commentId)));
        case "update_comment": {
          const commentId = String((args as { commentId: string }).commentId);
          return toText(await updateNodeComment(repository, commentId, updateNodeCommentInputSchema.parse(args)));
        }
        case "delete_comment":
          return toText(await deleteNodeComment(repository, String((args as { commentId: string }).commentId)));
        case "create_epic":
          return toText(await createEpic(repository, createEpicInputSchema.parse(args)));
        case "update_epic": {
          const epicId = String((args as { epicId: string }).epicId);
          return toText(await updateEpic(repository, epicId, updateEpicInputSchema.parse(args)));
        }
        case "delete_epic":
          return toText(await deleteEpic(repository, String((args as { epicId: string }).epicId)));
        case "create_feature":
          return toText(await createFeature(repository, createFeatureInputSchema.parse(args)));
        case "update_feature": {
          const featureId = String((args as { featureId: string }).featureId);
          return toText(await updateFeature(repository, featureId, updateFeatureInputSchema.parse(args)));
        }
        case "delete_feature":
          return toText(await deleteFeature(repository, String((args as { featureId: string }).featureId)));
        case "list_features": {
          const parsed = args as { epicId?: string; epicAlias?: string };
          return toText(await listFeatures(repository, parsed.epicId, parsed.epicAlias));
        }
        case "get_feature":
          return toText(await getFeature(repository, String((args as { featureId: string }).featureId)));
        case "create_user_story":
          return toText(await createUserStory(repository, createUserStoryInputSchema.parse(args)));
        case "update_user_story": {
          const storyId = String((args as { storyId: string }).storyId);
          return toText(await updateUserStory(repository, storyId, updateUserStoryInputSchema.parse(args)));
        }
        case "delete_user_story":
          return toText(await deleteUserStory(repository, String((args as { storyId: string }).storyId)));
        case "list_user_stories": {
          const parsed = args as { featureId?: string; featureAlias?: string };
          return toText(await listUserStories(repository, parsed.featureId, parsed.featureAlias));
        }
        case "get_user_story":
          return toText(await getUserStory(repository, String((args as { storyId: string }).storyId)));
        case "create_task":
          return toText(await createTask(repository, createTaskInputSchema.parse(args)));
        case "update_task": {
          const taskId = String((args as { taskId: string }).taskId);
          return toText(await updateTask(repository, taskId, updateTaskInputSchema.parse(args)));
        }
        case "delete_task":
          return toText(await deleteTask(repository, String((args as { taskId: string }).taskId)));
        case "list_tasks": {
          const parsed = args as { storyId?: string; storyAlias?: string };
          return toText(await listTasks(repository, parsed.storyId, parsed.storyAlias));
        }
        case "get_task":
          return toText(await getTask(repository, String((args as { taskId: string }).taskId)));
        case "list_links":
          return toText(await listWorkLinks(repository));
        case "get_link":
          return toText(await getWorkLink(repository, String((args as { linkId: string }).linkId)));
        case "create_link":
          return toText(await createWorkLink(repository, createWorkLinkInputSchema.parse(args)));
        case "update_link": {
          const linkId = String((args as { linkId: string }).linkId);
          return toText(await updateWorkLink(repository, linkId, updateWorkLinkInputSchema.parse(args)));
        }
        case "delete_link":
          return toText(await deleteWorkLink(repository, String((args as { linkId: string }).linkId)));
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      return toToolError(error);
    }
    });
  });

  return server;
}
