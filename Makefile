SHELL := /bin/zsh

.PHONY: install build dev start local mcp mcp-local check identity-onboard team-init team-add-user migrate-up migrate-down

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

identity-onboard:
	npm run identity:onboard

team-init:
	npm run team:init

team-add-user:
	npm run team:add-user

migrate-up:
	npx tsx src/scripts/migrate.ts up

migrate-down:
	npx tsx src/scripts/migrate.ts down
