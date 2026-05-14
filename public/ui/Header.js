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
  const initials = userInitials(user.name);
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

export function Header({ productName, health, activeView, onViewChange, onRefresh, refreshing, onToggleAgents, agentsOpen, agentCount, currentUser, notificationCount = 0, onToggleRecycle, recycleOpen }) {
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
        ${notificationCount > 0 ? html`
          <div className="header-notif-pill" title=${`${notificationCount} unread mention${notificationCount === 1 ? "" : "s"}`}>
            <span>@mentions</span>
            <span className="header-notif-pill-count">${notificationCount}</span>
          </div>
        ` : null}
        <${UserChip} user=${currentUser} />
        <button
          className=${`refresh-btn${refreshing ? " refresh-btn--loading" : ""}`}
          onClick=${onRefresh}
          aria-label="Refresh"
          aria-busy=${refreshing}
          title=${refreshing ? "Refreshing" : "Refresh"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
            <path d="M8 16H3v5"/>
          </svg>
        </button>
        <button
          className=${`recycle-btn${recycleOpen ? " recycle-btn--open" : ""}`}
          onClick=${onToggleRecycle}
          aria-label="Toggle recycle bin"
          aria-expanded=${recycleOpen}
          title="Recycle bin"
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
        <button
          className=${`agents-btn${agentsOpen ? " agents-btn--open" : ""}${agentCount > 0 ? " agents-btn--live" : ""}`}
          onClick=${onToggleAgents}
          aria-label="Toggle agents pane"
          aria-expanded=${agentsOpen}
          title="Agents"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
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
          <span className="agents-btn-label">Agents</span>
          ${agentCount > 0 ? html`
            <span className="agents-btn-badge">
              <span className="agents-btn-badge-ring"></span>
              ${agentCount}
            </span>
          ` : null}
        </button>
      </div>
    </header>
  `;
}
