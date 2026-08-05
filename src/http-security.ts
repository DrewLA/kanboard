import type { IncomingHttpHeaders } from "node:http";

import { z } from "zod";

import type { AppConfig } from "./config";

export const unlockIdentityInputSchema = z.object({
  password: z.string().min(1, "Password is required.")
});

export const API_IDENTITY_UNLOCK_REQUIRED_RESPONSE = {
  message: "HTTP API access requires an unlocked browser session.",
  code: "KB_IDENTITY_UNLOCK_SESSION_REQUIRED",
  recovery: "Unlock identity from the browser UI. Agents must use the MCP endpoint and must not call the HTTP API directly."
} as const;

const UNLOCK_RATE_WINDOW_MS = 60_000;
const UNLOCK_RATE_MAX_ATTEMPTS = 5;
const IDENTITY_UNLOCK_COOKIE_NAME = "kb_identity_unlocked";

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildAllowedHosts(config: AppConfig): Set<string> {
  const allowed = new Set<string>();

  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    allowed.add(`${hostname}:${config.port}`);
  }

  if (config.host !== "127.0.0.1" && config.host !== "0.0.0.0") {
    allowed.add(`${config.host}:${config.port}`);
  }

  return allowed;
}

export function createUnlockRateLimiter(): (ip: string) => boolean {
  const attempts = new Map<string, number[]>();

  return (ip: string): boolean => {
    const now = Date.now();
    const cutoff = now - UNLOCK_RATE_WINDOW_MS;
    const history = (attempts.get(ip) ?? []).filter((stamp) => stamp >= cutoff);

    if (history.length >= UNLOCK_RATE_MAX_ATTEMPTS) {
      attempts.set(ip, history);
      return false;
    }

    attempts.set(ip, [...history, now]);
    return true;
  };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return Object.fromEntries(cookieHeader.split(";").flatMap((part) => {
    const [name, ...rawValue] = part.trim().split("=");
    if (!name) return [];
    return [[name, decodeURIComponent(rawValue.join("="))]];
  }));
}

export function buildIdentityUnlockCookie(token: string): string {
  return [
    `${IDENTITY_UNLOCK_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ");
}

export function hasIdentityUnlockSession(headers: IncomingHttpHeaders, sessions: Set<string>): boolean {
  const token = parseCookies(firstHeaderValue(headers.cookie))[IDENTITY_UNLOCK_COOKIE_NAME];
  return Boolean(token && sessions.has(token));
}

export function isPreUnlockApiRequest(method: string, url: string): boolean {
  return (
    (method === "GET" && url === "/api/health") ||
    (method === "POST" && url === "/api/identity/unlock")
  );
}
