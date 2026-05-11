import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

function mcpUrl(health) {
  if (!health) return null;
  const host = health.host === "127.0.0.1" ? "localhost" : health.host;
  return `http://${host}:${health.port}/mcp`;
}

function formatRelativeTime(value) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function agentName(session) {
  const info = session.clientInfo || {};
  return info.title || info.name || "Unknown MCP client";
}

function agentDescription(session) {
  const info = session.clientInfo || {};
  const parts = [];
  if (info.name && info.name !== agentName(session)) parts.push(info.name);
  if (info.version) parts.push(`v${info.version}`);
  if (session.lastToolName) parts.push(session.lastToolName);
  else if (session.lastMethod) parts.push(session.lastMethod);
  return parts.join(" · ");
}

function AgentCard({ session }) {
  const status = session.status || "recent";
  const isConnected = status === "connected";
  const lastSeen = formatRelativeTime(session.lastSeenAt);

  return html`
    <div className="agent-card">
      <div className="agent-card-header">
        <span className=${`agent-dot${isConnected ? "" : " agent-dot--recent"}`}></span>
        <span className="agent-name">${agentName(session)}</span>
        <span className=${`agent-chip${isConnected ? " agent-chip--connected" : ""}`}>${isConnected ? "connected" : "recent"}</span>
      </div>
      <p className="agent-desc">${agentDescription(session) || session.sessionId}</p>
      <span className="agent-lastseen">
        ${lastSeen ? `Last active ${lastSeen}` : "Last active unknown"}
        ${session.toolCallCount ? ` · ${session.toolCallCount} tool calls` : ""}
      </span>
    </div>
  `;
}

export function AgentsPane({ open, onClose, health, agents = { sessions: [], counts: { connected: 0, recent: 0 } } }) {
  const url = mcpUrl(health);
  const connected = Boolean(health?.ok);
  const sessions = agents.sessions || [];
  const counts = agents.counts || { connected: 0, recent: 0 };

  return html`
    <${React.Fragment}>
      ${open ? html`<div className="agents-backdrop" onClick=${onClose} />` : null}
      <aside className=${`agents-pane glass-panel${open ? " agents-pane--open" : ""}`} aria-label="Agents" aria-hidden=${!open}>
        <div className="agents-header">
          <div className="agents-header-left">
            <svg className="agents-header-icon" width="16" height="16" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="2.25" stroke="currentColor" stroke-width="1.4"/>
              <circle cx="6.5" cy="1.5" r="1" fill="currentColor" opacity="0.55"/>
              <circle cx="6.5" cy="11.5" r="1" fill="currentColor" opacity="0.55"/>
              <circle cx="1.5" cy="6.5" r="1" fill="currentColor" opacity="0.55"/>
              <circle cx="11.5" cy="6.5" r="1" fill="currentColor" opacity="0.55"/>
              <line x1="6.5" y1="2.5" x2="6.5" y2="4.25" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
              <line x1="6.5" y1="8.75" x2="6.5" y2="10.5" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
              <line x1="2.5" y1="6.5" x2="4.25" y2="6.5" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
              <line x1="8.75" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
            </svg>
            <span className="agents-header-title">Agents</span>
            <span className=${`agents-status-dot${connected ? " agents-status-dot--live" : ""}`} title=${connected ? "MCP server reachable" : "Disconnected"}></span>
          </div>
          <button className="button button-ghost btn-icon" onClick=${onClose} aria-label="Close agents pane">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div className="agents-mcp-bar">
          <span className="agents-mcp-label">MCP endpoint</span>
          <code className="agents-mcp-url">${url || "—"}</code>
        </div>

        <div className="agents-body">
          <div className="agents-section-label">
            ${counts.connected} connected · ${counts.recent} recent
          </div>

          ${sessions.length ? sessions.map((session) => html`
            <${AgentCard} key=${session.sessionId} session=${session} />
          `) : html`<div className="agents-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <circle cx="16" cy="10" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/>
              <path d="M5 27c0-5.523 4.925-10 11-10s11 4.477 11 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 2"/>
            </svg>
            <p>No agents connected yet.</p>
            <span>Agents will appear here when they connect via the MCP endpoint above.</span>
          </div>`}
        </div>
      </aside>
    <//>
  `;
}
