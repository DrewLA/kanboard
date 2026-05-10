import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { viewLabels, runStateLabel, runStateTitle } from "./utils.js";

const html = htm.bind(React.createElement);

function userInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function UserChip({ user }) {
  if (!user) return null;
  const initials = user.avatarIcon || userInitials(user.name);
  const color = user.avatarColor || "var(--accent)";
  return html`
    <div className="user-chip" title=${`${user.name} · ${user.role}`}>
      <span className="user-avatar" style=${{ background: color }}>${initials}</span>
      <span className="user-chip-info">
        <span className="user-chip-name">${user.name}</span>
        <span className="user-chip-role">${user.role}</span>
      </span>
    </div>
  `;
}

export function Header({ productName, health, activeView, onViewChange, onRefresh, onToggleAgents, agentsOpen, currentUser }) {
  return html`
    <header className="topbar glass-panel">
      <div className="brand-cluster">
        <h1>${productName || "Kanboard"}</h1>
        <span className="run-state" title=${runStateTitle(health)}>${runStateLabel(health)}</span>
      </div>
      <nav className="tabs" aria-label="View navigation">
        ${Object.entries(viewLabels).map(
          ([view, label]) => html`
            <button
              key=${view}
              className=${`tab${activeView === view ? " active" : ""}`}
              onClick=${() => onViewChange(view)}
            >
              ${label}
            </button>
          `
        )}
      </nav>
      <div className="status-cluster">
        <${UserChip} user=${currentUser} />
        <button className="button button-ghost btn-icon" onClick=${onRefresh} aria-label="Refresh" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12.5 7A5.5 5.5 0 1 1 9.4 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M9 1v3.5H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          className=${`button button-ghost btn-icon${agentsOpen ? " active" : ""}`}
          onClick=${onToggleAgents}
          aria-label="Toggle agents pane"
          title="Agents"
          aria-expanded=${agentsOpen}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="5" r="2.75" stroke="currentColor" stroke-width="1.5"/>
            <path d="M1.5 13.5c0-2.485 2.686-4.5 6-4.5s6 2.015 6 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </header>
  `;
}
