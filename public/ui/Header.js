import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { viewLabels, runStateLabel, runStateTitle } from "./utils.js";

const html = htm.bind(React.createElement);

export function Header({ productName, health, activeView, onViewChange, onRefresh }) {
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
        <button className="button button-ghost btn-icon" onClick=${onRefresh} aria-label="Refresh" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12.5 7A5.5 5.5 0 1 1 9.4 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M9 1v3.5H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </header>
  `;
}
