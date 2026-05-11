import React, { useMemo } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, statusLabels, getTaskContexts, priorityClass, formatRelativeTime } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";

const html = htm.bind(React.createElement);

function userInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

export { MetaChip };

export function BoardView({ taskboard, filters, onFilterChange, onAddTask, onTaskClick, onMoveTask, onAddEpic, onAddFeature, usersMap }) {
  const epics = taskboard?.epics || [];
  const allContexts = useMemo(() => getTaskContexts(taskboard), [taskboard]);

  const visibleFeatures = filters.epicId
    ? epics.find((e) => e.id === filters.epicId)?.features || []
    : epics.flatMap((e) => e.features);

  const contexts = allContexts.filter(({ epic, feature }) => {
    if (filters.epicId && epic.id !== filters.epicId) return false;
    if (filters.featureId && feature.id !== filters.featureId) return false;
    return true;
  });

  return html`
    <section className="view-shell">
      <div className="panel-toolbar glass-panel">
        <${CustomSelect}
          value=${filters.epicId}
          onChange=${(v) => onFilterChange({ epicId: v, featureId: "" })}
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
                        ? items.map(({ epic, feature, story, task }) => html`
                            <article
                              key=${task.id}
                              className=${`task-card${task.isBlockedByLinks ? " blocked" : ""}`}
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
                            </article>
                          `)
                        : html`<p className="empty-minor">No tasks</p>`}
                    </div>
                  </section>
                `;
              })}
            </div>
          `
        : html`<p className="empty-major">No tasks match the current filter.</p>`}
    </section>
  `;
}
