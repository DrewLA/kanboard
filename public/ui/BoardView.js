import React, { useMemo } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, statusLabels, getTaskContexts, priorityClass } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";

const html = htm.bind(React.createElement);

export function BoardView({ taskboard, filters, onFilterChange, onAddTask, onTaskClick, onMoveTask, onAddEpic, onAddFeature }) {
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
