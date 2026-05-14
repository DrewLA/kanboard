import React, { useEffect, useState } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { request } from "./api.js";
import { formatRelativeTime } from "./utils.js";

const html = htm.bind(React.createElement);

const typeLabels = {
  comment: "Comment",
  task: "Task",
  story: "Story",
  feature: "Feature",
  epic: "Epic"
};

export function RecycleBinPane({ open, onClose, usersMap, onChanged, onConfirm }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await request("/api/recycle-bin");
      setEntries(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recycle bin.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load();
  }, [open]);

  async function restore(entryId) {
    if (busyId) return;
    setBusyId(entryId);
    try {
      await request(`/api/recycle-bin/${entryId}/restore`, { method: "POST", body: JSON.stringify({}) });
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore.");
    } finally {
      setBusyId(null);
    }
  }

  async function permanentDelete(entryId) {
    if (busyId) return;
    if (onConfirm && !await onConfirm("Permanently delete? This cannot be undone.")) return;
    else if (!onConfirm) return;
    setBusyId(entryId);
    try {
      await request(`/api/recycle-bin/${entryId}`, { method: "DELETE", body: JSON.stringify({}) });
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setBusyId(null);
    }
  }

  async function emptyAll() {
    if (busyId || !entries.length) return;
    if (onConfirm && !await onConfirm(`Permanently delete all ${entries.length} item(s)? This cannot be undone.`)) return;
    else if (!onConfirm) return;
    setBusyId("__all__");
    try {
      await request(`/api/recycle-bin`, { method: "DELETE", body: JSON.stringify({}) });
      setEntries([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to empty recycle bin.");
    } finally {
      setBusyId(null);
    }
  }

  function resolveDeletedBy(id) {
    if (!id) return "unknown";
    return usersMap?.[id]?.name || `${id.slice(0, 6)}…`;
  }

  return html`
    <aside className=${`recycle-pane glass-panel${open ? " recycle-pane--open" : ""}`} aria-label="Recycle bin" aria-hidden=${!open}>
      <header className="recycle-pane-header">
        <span className="recycle-pane-title">Recycle Bin</span>
        <span className="recycle-pane-count">${entries.length}</span>
        <button className="button button-ghost recycle-pane-close" type="button" onClick=${onClose} aria-label="Close">✕</button>
      </header>

      <div className="recycle-pane-toolbar">
        <button className="button button-ghost" type="button" onClick=${load} disabled=${loading}>${loading ? "Loading…" : "Refresh"}</button>
        <button
          className="button button-ghost recycle-pane-empty-btn"
          type="button"
          onClick=${emptyAll}
          disabled=${!entries.length || busyId === "__all__"}
        >${busyId === "__all__" ? "Emptying…" : "Empty bin"}</button>
      </div>

      ${error ? html`<div className="recycle-pane-error">${error}</div>` : null}

      <div className="recycle-pane-body">
        ${loading
          ? html`<p className="recycle-pane-empty">Loading…</p>`
          : entries.length === 0
            ? html`<p className="recycle-pane-empty">Nothing here. Deleted items will appear here.</p>`
            : entries.map((entry) => html`
              <article key=${entry.id} className=${`recycle-card recycle-card--${entry.entityType}`}>
                <div className="recycle-card-head">
                  <span className=${`recycle-card-type recycle-card-type--${entry.entityType}`}>${typeLabels[entry.entityType] || entry.entityType}</span>
                  <span className="recycle-card-time">${formatRelativeTime(entry.deletedAt) || "just now"}</span>
                </div>
                <p className="recycle-card-title">${entry.title || "(no title)"}</p>
                <p className="recycle-card-meta">Deleted by ${resolveDeletedBy(entry.deletedBy)}</p>
                <div className="recycle-card-actions">
                  <button
                    className="button button-ghost"
                    type="button"
                    onClick=${() => restore(entry.id)}
                    disabled=${busyId === entry.id}
                  >${busyId === entry.id ? "Restoring…" : "Restore"}</button>
                  <button
                    className="button button-ghost recycle-card-delete-btn"
                    type="button"
                    onClick=${() => permanentDelete(entry.id)}
                    disabled=${busyId === entry.id}
                  >Delete forever</button>
                </div>
              </article>
            `)}
      </div>
    </aside>
  `;
}
