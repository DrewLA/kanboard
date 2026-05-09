import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

function mcpUrl(health) {
  if (!health) return null;
  const host = health.host === "127.0.0.1" ? "localhost" : health.host;
  return `http://${host}:${health.port}/mcp`;
}

function AgentCard({ name, description, lastSeen, toolCount }) {
  return html`
    <div className="agent-card">
      <div className="agent-card-header">
        <span className="agent-dot"></span>
        <span className="agent-name">${name}</span>
        ${toolCount != null ? html`<span className="agent-chip">${toolCount} tools</span>` : null}
      </div>
      ${description ? html`<p className="agent-desc">${description}</p>` : null}
      ${lastSeen ? html`<span className="agent-lastseen">Last active ${lastSeen}</span>` : null}
    </div>
  `;
}

export function AgentsPane({ open, onClose, health }) {
  const url = mcpUrl(health);
  const connected = Boolean(health?.ok);

  return html`
    <${React.Fragment}>
      ${open ? html`<div className="agents-backdrop" onClick=${onClose} />` : null}
      <aside className=${`agents-pane glass-panel${open ? " agents-pane--open" : ""}`} aria-label="Agents" aria-hidden=${!open}>
        <div className="agents-header">
          <div className="agents-header-left">
            <svg className="agents-header-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 13c0-2.761 2.686-5 6-5s6 2.239 6 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
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
          <div className="agents-section-label">Connected agents</div>

          <div className="agents-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <circle cx="16" cy="10" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/>
              <path d="M5 27c0-5.523 4.925-10 11-10s11 4.477 11 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 2"/>
            </svg>
            <p>No agents connected yet.</p>
            <span>Agents will appear here when they connect via the MCP endpoint above.</span>
          </div>
        </div>
      </aside>
    <//>
  `;
}
