import type { IncomingMessage, ServerResponse } from "node:http";

type BoardChangePayload = {
  revision: number;
  source: "mcp" | "api";
  tools?: string[];
  changedAt: string;
};

export type AgentsPayload = {
  sessions: unknown[];
  counts: { connected: number; recent: number };
};

export class BoardEventHub {
  private clients = new Set<ServerResponse>();

  open(request: IncomingMessage, response: ServerResponse, initialRevision: number): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    this.clients.add(response);
    this.writeEvent(response, "board-ready", {
      revision: initialRevision,
      connectedAt: new Date().toISOString()
    });

    request.on("close", () => {
      this.clients.delete(response);
    });
  }

  emitBoardChanged(payload: BoardChangePayload): void {
    for (const client of this.clients) {
      this.writeEvent(client, "board-changed", payload);
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  private writeEvent(response: ServerResponse, event: string, payload: unknown): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

export class AgentEventHub {
  private clients = new Set<ServerResponse>();

  open(request: IncomingMessage, response: ServerResponse, initialPayload: AgentsPayload): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    this.clients.add(response);
    this.writeEvent(response, "agents-ready", initialPayload);

    request.on("close", () => {
      this.clients.delete(response);
    });
  }

  emit(payload: AgentsPayload): void {
    for (const client of this.clients) {
      this.writeEvent(client, "agents-changed", payload);
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  private writeEvent(response: ServerResponse, event: string, payload: unknown): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
