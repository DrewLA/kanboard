import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { priorityClass, statusLabels } from "./utils.js";

const html = htm.bind(React.createElement);

function BacklogNode({ type, item, expanded, onToggle, onAction, children }) {
  return html`
    <section className=${`backlog-node ${type} glass-panel`}>
      <header className="backlog-node-header" onClick=${onToggle}>
        <button className="expander" onClick=${(e) => { e.stopPropagation(); onToggle(); }} tabIndex="-1" aria-hidden="true">${expanded ? "▾" : "▸"}</button>
        <div className="backlog-node-title">
          <h3>${item.title}</h3>
          ${item.summary ? html`<p className="backlog-summary">${item.summary}</p>` : null}
        </div>
        <span className=${`status-badge status-${item.status}`}>${statusLabels?.[item.status] ?? item.status}</span>
        ${item.priority ? html`<span className=${`priority ${priorityClass(item.priority)}`}>${item.priority}</span>` : null}
        <div className="action-row" onClick=${(e) => e.stopPropagation()}>
          ${type === "epic" ? html`<button className="button button-ghost btn-sm" onClick=${() => onAction("add-feature", item.id)}>+ Feature</button>` : null}
          ${type === "feature" ? html`<button className="button button-ghost btn-sm" onClick=${() => onAction("add-story", item.id)}>+ Story</button>` : null}
          ${type === "story" ? html`<button className="button button-ghost btn-sm" onClick=${() => onAction("add-task", item.id)}>+ Task</button>` : null}
          <button className="button button-ghost btn-sm" onClick=${() => onAction(`edit-${type}`, item.id)}>Edit</button>
          <button className="button button-danger btn-sm" onClick=${() => onAction(`delete-${type}`, item.id)}>Delete</button>
        </div>
      </header>
      ${expanded ? html`<div className="backlog-children">${children}</div>` : null}
    </section>
  `;
}

export function BacklogView({ taskboard, expanded, onToggle, onAction, onAddEpic }) {
  const epics = taskboard?.epics || [];

  return html`
    <section className="view-shell">
      <div className="panel-toolbar glass-panel">
        <button className="button button-solid" onClick=${onAddEpic}>+ Epic</button>
      </div>
      ${epics.length
        ? html`
            <div className="backlog-wrap">
              ${epics.map((epic) => html`
                <${BacklogNode}
                  key=${epic.id}
                  type="epic"
                  item=${epic}
                  expanded=${expanded.has(epic.id)}
                  onToggle=${() => onToggle(epic.id)}
                  onAction=${onAction}
                >
                  ${epic.features.map((feature) => html`
                    <${BacklogNode}
                      key=${feature.id}
                      type="feature"
                      item=${feature}
                      expanded=${expanded.has(feature.id)}
                      onToggle=${() => onToggle(feature.id)}
                      onAction=${onAction}
                    >
                      ${feature.userStories.length
                        ? feature.userStories.map((story) => html`
                            <${BacklogNode}
                              key=${story.id}
                              type="story"
                              item=${story}
                              expanded=${expanded.has(story.id)}
                              onToggle=${() => onToggle(story.id)}
                              onAction=${onAction}
                            >
                              ${story.tasks.length
                                ? story.tasks.map((task) => html`
                                    <div key=${task.id} className="task-row">
                                      <div className="task-row-info">
                                        <h4>${task.title}</h4>
                                        ${task.summary ? html`<p className="backlog-summary">${task.summary}</p>` : null}
                                      </div>
                                      <span className=${`status-badge status-${task.status}`}>${statusLabels?.[task.status] ?? task.status}</span>
                                      ${task.estimate ? html`<span className="estimate">${task.estimate}</span>` : null}
                                      <span className=${`priority ${priorityClass(task.priority)}`}>${task.priority}</span>
                                      <div className="action-row">
                                        <button className="button button-ghost btn-sm" onClick=${() => onAction("edit-task", task.id)}>Edit</button>
                                        <button className="button button-danger btn-sm" onClick=${() => onAction("delete-task", task.id)}>Delete</button>
                                      </div>
                                    </div>
                                  `)
                                : html`<p className="empty-minor">No tasks.</p>`}
                            <//>
                          `)
                        : html`<p className="empty-minor">No stories.</p>`}
                    <//>
                  `)}
                <//>
              `)}
            </div>
          `
        : html`<p className="empty-major">No epics yet. Create one and build the backlog properly.</p>`}
    </section>
  `;
}
