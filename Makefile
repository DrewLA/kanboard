SHELL := /bin/zsh

.PHONY: install build dev start local local-dev mcp mcp-local check migrate-up migrate-down

install:
	npm install

build:
	npm run build

dev:
	npm run dev

start:
	npm run start

local:
	TASKBOARD_STORAGE=local npm run local

local-dev:
	TASKBOARD_STORAGE=local npm run local:dev

mcp:
	npm run mcp

mcp-local:
	TASKBOARD_STORAGE=local npm run mcp

check:
	npm run typecheck
	npm run build

migrate-up:
	npx tsx src/scripts/migrate.ts up

migrate-down:
	npx tsx src/scripts/migrate.ts down