# Kanban Taskboard

A local-only kanboard for tracking software delivery from epic down to task. Each team member runs their own local backend; team mode coordinates through a shared remote DB connection string — there is no central server.

The board maintains one shared source of truth for:

- the **BoardBrief**: board name, product objective, scope, non-goals, success criteria, and current focus
- the agile hierarchy: **epic → feature → user story → task**
- links between features and tasks (blocks / relates-to)
- node comments for agent coordination
- shared CRUD logic reused by the REST API, browser UI, and MCP endpoint

## Modes

| Mode | Storage authority | Team coordination |
|---|---|---|
| `private` | Local JSON state | No |
| `private-backup` | Local JSON state | DB used as hourly backup |
| `team` | Shared remote DB | Yes — every member syncs through the same DB prefix |

**Team mode makes every registered user an admin.** There is no per-user permission tiering; the shared DB connection string is the access boundary and effective trust boundary for the shared board.

State is versioned by row. Every mutation reads the current row version, applies changes, and increments the version. Conflicts are detected atomically and returned as `409` with full recovery guidance.

## Runtime model

One `127.0.0.1`-bound Fastify process per user.

- UI served at `http://127.0.0.1:8787`
- REST API at `/api/*`
- MCP endpoint at `POST /mcp`

> **Security notice**: This project does not implement production security controls (authentication, authorization, rate limiting, or internet-facing hardening). It is designed for trusted local use only. Never expose this service to the public internet.

## Requirements

- **Node.js** ≥ 20 (LTS recommended — [nodejs.org](https://nodejs.org))
- **npm** ≥ 10 (bundled with Node 20+)

Verify before installing:

```bash
node --version   # should print v20.x.x or higher
npm --version    # should print 10.x.x or higher
```

## First-run setup

### 1. Install dependencies

```bash
make install
```

### 2. Configure environment

Copy `.env.example` to `.env` and set values:

```bash
cp .env.example .env
```

Minimum for **private mode** (no DB required):

```ini
TASKBOARD_MODE=private
```

For **team mode**, also set:

```ini
TASKBOARD_MODE=team
TASKBOARD_DB_STRING=upstash;url=https://...;token=...;prefix=kanboard:main
```

To enable task attachments backed by R2, also set:

```ini
R2_ENDPOINT=https://<your-r2-endpoint>
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=kanboard
```

The DB prefix scopes all keys in the shared database. Change it to create a separate board in the same DB instance.

### 3. Set up your identity

```bash
npm run identity:onboard
```

This interactive script:

1. Shows an intro banner with the detected mode
2. Pings the DB if configured, reports if this is a first-time team setup (no `users` table yet)
3. Prompts for your name, role, and optional email
4. Generates a new EVM identity — shows the seed phrase once (write it down)
5. Prompts you to set and confirm an identity password
6. Writes the encrypted identity to `.kanboard/identity.json`
7. Writes your profile to `.kanboard/user.json`
8. If the team DB is empty, initializes the shared board tables automatically
9. Registers you in the team DB
10. Prints your address, name, and role, then tells you to run `make dev` and open the board UI

For subsequent team members: each member runs `npm run identity:onboard` on their own machine. The script registers them in the same shared DB automatically.

### 4. Start the server

```bash
make dev
```

Then open `http://127.0.0.1:8787` in your browser and log in with the identity password you set.

## Environment variables

```ini
TASKBOARD_MODE=private                       # private | private-backup | team
TASKBOARD_STATE_DIR=.kanboard/state          # local JSON state directory
TASKBOARD_IDENTITY_FILE=.kanboard/identity.json
TASKBOARD_USER_FILE=.kanboard/user.json
TASKBOARD_PRIVATE_USERNAME=Private User      # display name for private mode (no identity)
TASKBOARD_DB_STRING=upstash;url=...;token=...;prefix=kanboard:main
TASKBOARD_EVM_PRIVATE_KEY=...               # alternative to identity file (team mode)
TASKBOARD_BACKUP_INTERVAL_MINUTES=60         # for private-backup mode
TASKBOARD_HOST=127.0.0.1
TASKBOARD_PORT=8787
R2_ENDPOINT=                                 # raw R2 S3 endpoint URL
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=kanboard
```

## R2 setup

The application-side integration is built in, but the one-time R2 account setup is still manual:

1. Create an R2 bucket named `kanboard`.
2. Add an R2 CORS rule that allows your frontend origin and the `PUT`, `GET`, and `HEAD` methods. For the default local UI, this is a working baseline:

```json
[
	{
		"AllowedOrigins": ["http://127.0.0.1:8787", "http://localhost:8787"],
		"AllowedMethods": ["GET", "HEAD", "PUT"],
		"AllowedHeaders": ["content-type"],
		"ExposeHeaders": ["etag"],
		"MaxAgeSeconds": 3600
	}
]
```

If you change `TASKBOARD_PORT`, update the origin list to match. When this rule is missing, the browser blocks the presigned upload before it reaches R2 and reports a CORS preflight failure.
3. Copy the raw S3 endpoint your R2 provider gives you into `R2_ENDPOINT`. This avoids hardcoding any single account-id URL format and works with region or geo-specific endpoint variants.
4. Copy the Access Key ID and Secret Access Key for that R2 bucket into `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

This code authenticates to the R2 S3-compatible API with AWS SigV4 using `R2_ACCESS_KEY_ID` plus `R2_SECRET_ACCESS_KEY`. There is no separate bearer auth token in this upload path, and the browser itself uses short-lived presigned URLs rather than direct credentials.

The browser uploads directly to R2 using presigned URLs. The taskboard stores only attachment metadata and object keys in entity records; it never stores file contents in Redis or local state.

MCP agents use a separate path: the `upload_attachment` tool sends the file bytes inline to the local server, which uploads them to R2 with the same SigV4 credentials and records the metadata. Agent-supplied bytes therefore pass through the local taskboard process, but are still stored only as R2 objects plus metadata, never in Redis or local state.

Attachment reads do not use a stored public object read URL. The UI fetches attachment content through the local taskboard server on `127.0.0.1`, which then streams the object from R2.

That read path does **not** provide application-level confidentiality for the object itself. Uploaded files are not encrypted by this application before they reach R2, so anyone who can read the underlying R2 object data can still recover the plaintext attachment.

In team mode, the shared DB connection string remains the primary trust boundary for board data and attachment metadata. If this project later adds attachment encryption and stores the shared decryption secret in the team DB, that same DB connection string would also become the decryption boundary.

Until application-level encryption exists, treat the R2 bucket as plaintext object storage and proceed with caution.

## Commands

```bash
make install              # npm install
make build                # compile TypeScript to dist/
make dev                  # start localhost server with tsx watch (hot reload)
make start                # run compiled server from dist/
make local                # run server in private mode (ignores mode env var)
make check                # typecheck + build

npm run identity:onboard  # interactive first-run setup (identity + DB registration)
npm run identity:whoami   # print current local identity address

make migrate-up           # migrate local JSON state to Upstash Redis
make migrate-down         # migrate Upstash Redis back to local JSON
```

## HTTP API

Health and users:

- `GET /api/health`
- `GET /api/users`
- `GET /api/users/me`
- `POST /api/identity/unlock`

Board and brief:

- `GET /api/taskboard`
- `GET /api/board-brief` / `PUT /api/board-brief`
- `GET /api/metadata` / `PUT /api/metadata` (alias)

Hierarchy:

- `GET|POST /api/epics` — `GET|PATCH|DELETE /api/epics/:epicId`
- `GET|POST /api/features` — `GET|PATCH|DELETE /api/features/:featureId`
- `GET|POST /api/stories` — `GET|PATCH|DELETE /api/stories/:storyId`
- `GET|POST /api/tasks` — `GET|PATCH|DELETE /api/tasks/:taskId`
- `POST /api/epics/:epicId/upload-url`, `POST /api/features/:featureId/upload-url`, `POST /api/tasks/:taskId/upload-url` — create a presigned R2 upload URL for an image or mockup asset

Coordination:

- `POST /api/comments` — `GET|PATCH|DELETE /api/comments/:commentId`
- `GET|POST /api/links` — `GET|PATCH|DELETE /api/links/:linkId`
- `GET /api/nodes/resolve`
- `GET /api/nodes/search`

## MCP endpoint

The same server exposes MCP over localhost HTTP at `POST /mcp`.

Point your MCP client at:

```text
http://127.0.0.1:8787/mcp
```

Available tools: `get_taskboard`, `get_board_brief`, `update_board_brief`, `list_epics`, `get_epic`, `create_epic`, `update_epic`, `delete_epic`, `list_features`, `get_feature`, `create_feature`, `update_feature`, `delete_feature`, `list_user_stories`, `get_user_story`, `create_user_story`, `update_user_story`, `delete_user_story`, `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`, `upload_attachment`, `resolve_node`, `find_nodes`, `create_comment`, `get_comment`, `update_comment`, `delete_comment`, `list_links`, `get_link`, `create_link`, `update_link`, `delete_link`.

See `docs/agent-skill-prompt.md` for the agent operating prompt.

## Persistence

Local state is one JSON file per table under `TASKBOARD_STATE_DIR`:

- `users.json`, `boardBrief.json`, `epics.json`, `features.json`, `userStories.json`
- `tasks.json`, `comments.json`, `links.json`, `indexes.json`, `metadata.json`

Each row carries its own version number. Mutations read the current version, apply changes, increment, and write back. Conflicting concurrent writes return a `409` with the conflicting revisions and recovery steps.

In team mode the remote DB adapter performs version checks atomically. The local state package mirrors the shared DB after each read and successful write.

## Project structure

```text
public/                  Browser UI (React + htm, no build step)
src/config.ts            Environment parsing and validation
src/model.ts             Types, Zod schemas, and board snapshot mapping
src/repository.ts        Modular local and remote persistence layer
src/state-package.ts     Table-shaped state document with version tracking
src/identity.ts          EVM identity derivation and EIP-712 signing
src/identity-store.ts    Encrypted identity file read/write
src/taskboard-service.ts All board mutations — single source of truth
src/http-server.ts       Fastify server (UI, REST API, HTTP MCP)
src/mcp-core.ts          Shared MCP tool definitions and handlers
src/mcp-server.ts        Optional stdio MCP wrapper
src/startup-errors.ts    Startup and conflict error formatting
src/scripts/             CLI tools (onboarding, team admin, migration)
docs/architecture.md     Design notes
docs/internal-tools.md   EVM identity and team admin reference
docs/agent-skill-prompt.md Agent operating prompt
```

## TODO:

- Add tests
- Improve token efficiency
- Add dedicated agents relay