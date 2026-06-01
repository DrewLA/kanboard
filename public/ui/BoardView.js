import React, { useMemo } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, statusLabels, getTaskContexts, priorityClass, formatRelativeTime } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";

const html = htm.bind(React.createElement);

// Build a single lowercased haystack string per task, covering every text
// element a user might reasonably search for: the task itself, its parent
// epic/feature/story, tags, assignee, status and priority labels.
function buildHaystack(ctx, usersMap) {
  const { epic, feature, story, task } = ctx;
  const assignee = task.assignedTo ? usersMap?.[task.assignedTo]?.name : "";
  return [
    task.title,
    task.summary,
    task.alias,
    task.implementationNotes,
    task.estimate,
    task.priority,
    task.status,
    statusLabels[task.status],
    ...(task.tags || []),
    epic.title,
    feature.title,
    story.title,
    assignee,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function userInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function modifiedTime(ctx) {
  const value = ctx.task.updatedAt || ctx.task.createdAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareByLastModified(left, right) {
  return modifiedTime(right) - modifiedTime(left);
}

function MetaChip({ updatedBy, updatedAt, updatedVia, usersMap }) {
  if (!updatedBy && !updatedAt) return null;
  const isAgent = updatedVia === "mcp";
  const user = updatedBy ? usersMap?.[updatedBy] : null;
  const color = isAgent ? "var(--accent-agent, #7c3aed)" : (user?.avatarColor || "var(--text-muted)");
  const initials = user ? userInitials(user.name) : userInitials(updatedBy || "?");
  const label = user?.name || (updatedBy ? updatedBy.slice(0, 6) + "…" : "unknown");
  const time = formatRelativeTime(updatedAt);
  return html`
    <div className=${`meta-chip${isAgent ? " meta-chip--agent" : ""}`} title=${`Last edited by ${user?.name || updatedBy || "unknown"}${isAgent ? " (via agent)" : ""}${time ? " · " + time : ""}`}>
      <span className="meta-chip-avatar" style=${{ background: color }}>${initials}</span>
      <span className="meta-chip-name">${label}</span>
      ${time ? html`<span className="meta-chip-time">${time}</span>` : null}
    </div>
  `;
}

function UserCardChip({ user }) {
  if (!user) return null;

  const initials = user.name?.[0]?.toUpperCase() || "?";
  return html`
    <div className="user-card-chip" title=${`Assigned to ${user.name}${user.role ? " · " + user.role : ""}`}>
      <span className="user-card-chip-avatar" style=${{ background: user.avatarColor || "var(--accent)" }}>${initials}</span>
      <span className="user-card-chip-name">${user.name}</span>
    </div>
  `;
}

export { MetaChip };

export function BoardView({ taskboard, filters, onFilterChange, onAddTask, onTaskClick, onMoveTask, onAddEpic, onAddFeature, usersMap, notifications, currentUserId }) {
  const epics = taskboard?.epics || [];
  const allContexts = useMemo(() => getTaskContexts(taskboard), [taskboard]);

  const visibleFeatures = filters.epicId
    ? epics.find((e) => e.id === filters.epicId)?.features || []
    : epics.flatMap((e) => e.features);

  // Precompute the search haystack for each context once per data change so
  // typing only re-runs cheap string matching, not field gathering.
  const indexed = useMemo(
    () => allContexts.map((ctx) => ({ ctx, haystack: buildHaystack(ctx, usersMap) })),
    [allContexts, usersMap]
  );

  // Split the query into terms; every term must match (AND), so "auth high"
  // narrows to high-priority auth work regardless of field or word order.
  const terms = (filters.query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);

  const contexts = indexed
    .filter(({ ctx, haystack }) => {
      if (filters.epicId && ctx.epic.id !== filters.epicId) return false;
      if (filters.featureId && ctx.feature.id !== filters.featureId) return false;
      if (terms.length && !terms.every((t) => haystack.includes(t))) return false;
      return true;
    })
    .map(({ ctx }) => ctx)
    .sort(compareByLastModified);

  return html`
    <section className="view-shell view-shell--board">
      <div className="panel-toolbar glass-panel">
        <${CustomSelect}
          value=${filters.epicId}
          onChange=${(v) => onFilterChange({ ...filters, epicId: v, featureId: "" })}
          options=${[{ value: "", label: "All Epics" }, ...epics.map((e) => ({ value: e.id, label: e.title }))]}
          placeholder="All Epics"
          actionItem=${{ label: "New Epic", onAction: onAddEpic }}
        />
        <${CustomSelect}
          value=${visibleFeatures.some((f) => f.id === filters.featureId) ? filters.featureId : ""}
          onChange=${(v) => onFilterChange({ ...filters, featureId: v })}
          options=${[{ value: "", label: "All Features" }, ...visibleFeatures.map((f) => ({ value: f.id, label: f.title }))]}
          placeholder="All Features"
          actionItem=${{ label: "New Feature", onAction: onAddFeature }}
        />
        <div className="board-search">
          <svg className="board-search-icon" width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.4" fill="none" />
            <path d="M8 8l2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <input
            className="board-search-input"
            type="text"
            placeholder="Search tasks..."
            aria-label="Search tasks"
            value=${filters.query || ""}
            onInput=${(e) => onFilterChange({ ...filters, query: e.target.value })}
            onKeyDown=${(e) => e.key === "Escape" && filters.query && onFilterChange({ ...filters, query: "" })}
          />
          ${filters.query
            ? html`<button
                type="button"
                className="board-search-clear"
                aria-label="Clear search"
                onClick=${() => onFilterChange({ ...filters, query: "" })}
              >×</button>`
            : null}
        </div>
        <button className="button button-solid" onClick=${onAddTask}>+ Task</button>
      </div>

      ${contexts.length
        ? html`
            <div className="kanban-grid">
              ${allowedStatuses.map((status) => {
                const items = contexts.filter((ctx) => ctx.task.status === status);
                return html`
                  <section key=${status} className="kanban-col glass-panel" data-status=${status}>
                    <header className="kanban-col-header">
                      <span>${statusLabels[status]}</span>
                      <span className="pill-count">${items.length}</span>
                    </header>
                    <div
                      className="kanban-cards"
                      onDragOver=${(e) => e.preventDefault()}
                      onDrop=${(e) => {
                        const taskId = e.currentTarget.dataset.dragTaskId;
                        if (taskId) onMoveTask(taskId, status);
                      }}
                    >
                      ${items.length
                        ? items.map(({ epic, feature, story, task }) => {
                            const notifCount = notifications?.filter((n) => n.nodeId === task.id).length || 0;
                            return html`
                            <article
                              key=${task.id}
                              className=${`task-card${task.isBlockedByLinks ? " blocked" : ""}${notifCount > 0 ? " task-card--has-notif" : ""}`}
                              draggable="true"
                              onDragStart=${(e) => {
                                e.currentTarget.closest(".kanban-grid").querySelectorAll(".kanban-cards").forEach((lane) => {
                                  lane.dataset.dragTaskId = task.id;
                                });
                              }}
                              onDragEnd=${(e) => {
                                e.currentTarget.closest(".kanban-grid").querySelectorAll(".kanban-cards").forEach((lane) => {
                                  lane.dataset.dragTaskId = "";
                                });
                              }}
                              onClick=${() => onTaskClick(task.id)}
                              title=${story.title}
                            >
                              ${notifCount > 0 ? html`<div className="notif-badge" aria-label=${`${notifCount} unread mention${notifCount === 1 ? "" : "s"}`}>@${notifCount}</div>` : null}
                              <h3>${task.title}</h3>
                              ${task.summary ? html`<p className="task-summary">${task.summary}</p>` : null}
                              <p className="context-line">${epic.title} / ${feature.title}</p>
                              <div className="card-foot">
                                <div className="tag-row">
                                  ${(task.tags || []).slice(0, 3).map((tag) => html`<span key=${tag} className="tag">${tag}</span>`)}
                                </div>
                                <div className="card-foot-right">
                                  ${task.estimate ? html`<span className="estimate">${task.estimate}</span>` : null}
                                  <span className=${`priority ${priorityClass(task.priority)}`}>${task.priority}</span>
                                </div>
                              </div>
                              ${(task.updatedBy || task.updatedAt) ? html`
                                <${MetaChip} updatedBy=${task.updatedBy} updatedAt=${task.updatedAt} updatedVia=${task.updatedVia} usersMap=${usersMap} />
                              ` : null}
                              ${task.assignedTo && usersMap?.[task.assignedTo] ? html`
                                ${(task.updatedBy || task.updatedAt) ? html`<div className="card-sep"></div>` : null}
                                <div className="card-assignee-row">
                                  <span className="card-assignee-label">ASSIGNED</span>
                                  <${UserCardChip} user=${usersMap[task.assignedTo]} />
                                </div>
                              ` : null}
                            </article>
                          `;
                          })
                        : html`<p className="empty-minor">No tasks</p>`}
                    </div>
                  </section>
                `;
              })}
            </div>
          `
        : html`<p className="empty-major">${terms.length ? `No tasks match “${filters.query.trim()}”.` : "No tasks match the current filter."}</p>`}
    </section>
  `;
}
