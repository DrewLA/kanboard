# Architecture

## Goals

- keep the board local, private, and simple
- model software delivery cleanly from epics to tasks
- centralize all board mutations in one service layer
- reuse the same CRUD functions from the UI, REST API, and MCP entrypoints

## Data model

The persisted document contains:

- one BoardBrief root object that describes the shared objective, scope, non-goals, success criteria, and current focus above all epics
- a monotonic board `revision`
- ordered epic ids
- keyed records for epics, features, user stories, and tasks
- per-node edit attribution fields: `updatedAt`, `updatedBy` (public address), and `updatedVia` (`"api" | "mcp"`)

Relationships are explicit:

- epics hold `featureIds`
- features hold `storyIds`
- user stories hold `taskIds`
- children also keep their parent id for direct lookup

This shape makes the implementation compact while still supporting:

- nested rendering for the UI
- targeted CRUD operations
- cascading deletes
- one-read snapshot generation for MCP and HTTP consumers

### Comments

Comments are stored in a flat `comments` table in the state package, separate from the entity rows. Each record carries `nodeType` and `nodeId` to link back to the owning entity. At read time, `attachComments` joins them onto the entity's `comments[]` field. At write time, `stripComments` removes them from entity rows and `collectComments` rebuilds the flat table. This means entity rows on disk always have `comments: []` — the flat table is the source of truth.

Comments are first-class objects exposed via the REST API and MCP. Agents use them for agent-to-agent coordination (requirements, blockers, handoff notes). The UI exposes a comments pane on task edit overlays.

### Attachments

Epics, features, and tasks each carry an `attachments[]` array of metadata records (id, kind, name, R2 object key, content type, size). The file bytes live in R2; the document stores only the metadata and key. Stories do not have attachments.

There are two write paths into the same metadata shape:

- **Browser**: the server hands out a short-lived presigned PUT URL (`POST /api/{epics|features|tasks}/:id/upload-url`), the browser uploads bytes straight to R2, then PATCHes the entity to append the metadata.
- **Agents (MCP)**: the `upload_attachment` tool sends bytes inline; the service decodes them, uploads to R2 with `putAttachmentObject`, and appends the metadata inside a serialized mutation. Agents are limited to `image` and `mockup` kinds.

Reads for both paths stream through the local server (`GET /api/{epics|features|tasks}/:id/attachments/:attachmentId/content`), which fetches the object from R2.

### Task fields

Tasks carry additional fields beyond the base entity:

- `implementationNotes`: freeform execution detail for the task (string, up to 4000 chars)
- `estimate`: effort estimate expressed as any string the team uses — story points, t-shirt size, hours (string, up to 120 chars)
- `tags`: arbitrary labels for filtering and grouping (string array)
- `assignedTo`: user ID of the assigned team member (optional)
- `acceptanceCriteria`: structured list of verifiable done-conditions (see below)

#### Acceptance criteria

Each criterion is stored as `{ id, text, done }`:

- `id` — stable server-generated id (`ac_<uuid>`). Assigned on creation; preserved across updates as long as the item stays in the list.
- `text` — the criterion text (string, up to 500 chars)
- `done` — whether the criterion has been met (boolean)

Criterion ids are stable for the lifetime of the item. The MCP layer exposes dedicated per-item tools so agents never need to reconstruct the full list:

- `add_acceptance_criterion` — append one item, returns the new criterion with its id
- `check_acceptance_criterion` — toggle `done` on one item by id
- `update_acceptance_criterion` — edit one item's text by id
- `delete_acceptance_criterion` — remove one item by id
- `reorder_acceptance_criteria` — reorder by providing all existing ids in the desired order

`update_task` (via REST) accepts a full `acceptanceCriteria` replacement for the UI's form-save path. That path does id-preservation: items whose id matches an existing criterion keep it; items without an id get a fresh server-generated one; an unrecognised id is an error. MCP agents should not use this path — use the dedicated tools instead.

## Persistence model

The board persists as one JSON document behind a repository interface.

Supported backends:

- Upstash Redis at a single key
- local file storage at a single JSON file path

Why this is the right tradeoff here:

- the board is private and local-only
- usage is expected to be low-to-moderate concurrency across a small number of cooperating agents
- the hierarchy is small and naturally document-shaped
- backup and migration stay straightforward

Writes are serialized inside the runtime.

- the browser UI, REST API callers, and localhost MCP callers all hit the same process
- each mutation loads the current document, applies the change, increments revision, and saves

If this ever grows into a higher-write or heavily collaborative tool, the next step would be splitting entities into separate keys with stronger per-entity concurrency controls.

## Service layer

`src/taskboard-service.ts` is the source of truth for all board mutations.

It owns:

- create, read, update, delete functions for every entity level
- cascade behavior when parents are deleted
- lineage timestamp updates so recent activity bubbles upward
- snapshot generation for UI and agent consumers

The HTTP server and MCP server do not mutate data directly.

## Runtime topology

The normal local runtime is a single Fastify server bound to localhost.

- `/` serves the browser UI
- `/api/*` serves the REST API
- `/mcp` serves stateless HTTP MCP requests

An optional stdio wrapper exists for compatibility, but the intended local flow is one localhost process serving both humans and agents.

## Local-only boundary

The HTTP server binds to `127.0.0.1` by default.

- do not expose it publicly
- keep MCP clients pointed at localhost
- treat Upstash credentials as local secrets in `.env`