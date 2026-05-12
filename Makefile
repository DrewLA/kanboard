SHELL := /bin/zsh

.PHONY: install build dev start local mcp mcp-local check upgrade identity-onboard identity-whoami migrate-up migrate-down

install:
	npm install

build:
	npm run build

dev:
	npm run dev

start:
	npm run start

local:
	TASKBOARD_MODE=private npm run local

mcp:
	npm run mcp

mcp-local:
	TASKBOARD_MODE=private npm run mcp

check:
	npm run typecheck
	npm run build

upgrade:
	npm run upgrade

identity-onboard:
	npm run identity:onboard

identity-whoami:
	npm run identity:whoami

migrate-up:
	npx tsx src/scripts/migrate.ts up

migrate-down:
	npx tsx src/scripts/migrate.ts down
