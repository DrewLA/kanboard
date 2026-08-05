SHELL := /bin/zsh

.PHONY: install build dev dev-watch start local mcp mcp-local check upgrade identity-onboard identity-whoami

install:
	npm install

build:
	npm run build

dev:
	npm run dev

dev-watch:
	npm run dev:watch

start: build
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
