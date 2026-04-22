# Local Kanban Taskboard

A local-only taskboard for tracking software delivery from epic down to task.

The board keeps one shared source of truth for:

- the BoardBrief, which defines the overall product objective and scope
- the agile hierarchy: epic -> feature -> user story -> task
- links between features and tasks
- node comments for agent coordination
- shared CRUD logic reused by the REST API, browser UI, and MCP endpoint

## Runtime model

This project runs as one localhost-only Fastify process.

- the browser UI is served from `http://127.0.0.1:8787`
- the REST API is served under `/api/*`
- the MCP endpoint is served at `POST /mcp`

## What is included

- local HTTP UI
- local JSON API
- localhost HTTP MCP endpoint
- full CRUD for BoardBrief, epics, features, stories, tasks, comments, and links
- Upstash Redis or local JSON persistence
- Makefile commands for local development

## Local-only design

The server binds to `127.0.0.1` by default and is intended for private local use only.

> WARNING
> This project does not implement production security controls (for example: authentication, authorization, multi-tenant isolation, rate limiting, or internet-facing hardening).
> It is designed only for trusted local development on localhost.
> Never expose this service to the public internet.

- do not expose it publicly
- do not reverse-proxy it to the internet
- keep MCP clients pointed at localhost only

## Setup

1. Copy `.env.example` to `.env`.
2. Choose a storage mode.
3. Install dependencies.
4. Start the server.

For Upstash mode:

- leave `TASKBOARD_STORAGE=upstash`
- fill in `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

For local JSON mode:

- set `TASKBOARD_STORAGE=local`
- optionally change `TASKBOARD_LOCAL_FILE`
- no Redis instance is required

```bash
make install
make local
```

Open `http://127.0.0.1:8787`.

## Environment variables

```bash
TASKBOARD_STORAGE=upstash
TASKBOARD_LOCAL_FILE=.taskboard/local-taskboard.json
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
TASKBOARD_REDIS_KEY=taskboard:main
TASKBOARD_HOST=127.0.0.1
TASKBOARD_PORT=8787
```

## Commands

```bash
make install   # npm install
make build     # compile TypeScript to dist/
make dev       # run the localhost HTTP server with tsx watch
make start     # run the compiled HTTP server from dist/
make local     # run the localhost HTTP server with local JSON persistence
make local-dev # run the local JSON server with tsx watch
make mcp       # run the stdio MCP server (shares the same core tools)
make mcp-local # run the stdio MCP server with local JSON persistence
make start     # run the compiled server
make check     # typecheck and build
make migrate-up   # migrate data from local JSON to Upstash Redis
make migrate-down # migrate data from Upstash Redis to local JSON
```

## HTTP API

Health:

- `GET /api/health`

Board and brief:

- `GET /api/taskboard`
- `GET /api/board-brief`
- `PUT /api/board-brief`
- `GET /api/metadata`
- `PUT /api/metadata`

Hierarchy:

- `GET|POST /api/epics`
- `GET|PATCH|DELETE /api/epics/:epicId`
- `GET|POST /api/features`
- `GET|PATCH|DELETE /api/features/:featureId`
- `GET|POST /api/stories`
- `GET|PATCH|DELETE /api/stories/:storyId`
- `GET|POST /api/tasks`
- `GET|PATCH|DELETE /api/tasks/:taskId`

Coordination:

- `POST /api/comments`
- `GET|PATCH|DELETE /api/comments/:commentId`
- `GET|POST /api/links`
- `GET|PATCH|DELETE /api/links/:linkId`
- `GET /api/nodes/resolve`
- `GET /api/nodes/search`

## MCP endpoint

The same server also exposes MCP over localhost HTTP at `POST /mcp`.

Start it with either:

```bash
make dev
```

or:

```bash
make local
```

Point your MCP client at:

```text
http://127.0.0.1:8787/mcp
```

Available tools include:

- `get_taskboard`, `get_board_brief`, `update_board_brief`
- `get_metadata`, `update_metadata`
- `list_epics`, `get_epic`, `create_epic`, `update_epic`, `delete_epic`
- `list_features`, `get_feature`, `create_feature`, `update_feature`, `delete_feature`
- `list_user_stories`, `get_user_story`, `create_user_story`, `update_user_story`, `delete_user_story`
- `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`
- `resolve_node`, `find_nodes`
- `create_comment`, `get_comment`, `update_comment`, `delete_comment`
- `list_links`, `get_link`, `create_link`, `update_link`, `delete_link`

## Persistence

The board persists as one document.

Upstash mode:

- stores the JSON document at `TASKBOARD_REDIS_KEY`
- useful when you want remote persistence without hosting your own database

Local mode:

- stores the JSON document at `TASKBOARD_LOCAL_FILE`
- requires no Redis service
- is the simplest private local setup

Writes are serialized in-process so the UI and localhost MCP clients operate against one consistent runtime.

## Project structure

```text
public/                  Static UI
src/config.ts            Environment parsing
src/model.ts             Types, schemas, and snapshot mapping
src/repository.ts        Upstash and local JSON persistence
src/taskboard-service.ts Shared CRUD logic and mutation rules
src/http-server.ts       Local Fastify server for UI, API, and HTTP MCP
src/mcp-core.ts          Shared MCP tool definitions and handlers
src/mcp-server.ts        Optional stdio wrapper around the same MCP core
docs/architecture.md     Design notes
docs/agent-skill-prompt.md Agent operating prompt
```

## Agent guidance

Use `docs/agent-skill-prompt.md` when you want an external agent to operate on the board consistently.

## TODOs

- improve token efficiency
- optimize multi-agent chat with a relay instead of static node comments