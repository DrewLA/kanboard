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