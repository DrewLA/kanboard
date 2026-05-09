const allowedStatuses = ["pending", "ready", "in-progress", "review", "blocked", "done"];
const allowedPriorities = ["low", "medium", "high", "critical"];

const statusLabels = {
  pending: "To Do",
  ready: "Ready",
  "in-progress": "In Progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done"
};

const state = {
  activeView: "board",
  taskboard: null,
  filters: {
    epicId: "",
    featureId: ""
  },
  expanded: new Set(),
  dragTaskId: null
};

const productNameHeading = document.getElementById("product-name-heading");
const runState = document.getElementById("run-state");
const viewBoard = document.getElementById("view-board");
const viewBacklog = document.getElementById("view-backlog");
const kanbanBoard = document.getElementById("kanban-board");
const backlogRoot = document.getElementById("backlog-root");
const filterEpic = document.getElementById("filter-epic");
const filterFeature = document.getElementById("filter-feature");
const btnAddTask = document.getElementById("btn-add-task");
const btnAddEpic = document.getElementById("btn-add-epic");
const btnBrief = document.getElementById("btn-brief");
const btnRefresh = document.getElementById("btn-refresh");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");
const tabButtons = Array.from(document.querySelectorAll(".tab"));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Request failed.";
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: "Request failed." }));
    throw new Error(payload.message || "Request failed.");
  }

  return response.json();
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString();
}

function setRunState(health) {
  if (!health) {
    runState.textContent = "Disconnected";
    runState.title = "The UI could not reach the local taskboard server.";
    return;
  }

  const labels = {
    private: "Private",
    "private-backup": "Private + Backup",
    team: "Team"
  };
  runState.textContent = labels[health.mode] || health.mode || "Private";
  runState.title = health.mode === "team"
    ? "Team mode: shared DB is authoritative and local state is mirrored."
    : health.mode === "private-backup"
      ? "Private backup mode: local state is authoritative with scheduled remote backups."
      : health.stateDir || "Private local state package";
}

function priorityClass(priority) {
  return allowedPriorities.includes(priority) ? priority : "low";
}

function getTaskContexts(taskboard) {
  return taskboard.epics.flatMap((epic) =>
    epic.features.flatMap((feature) =>
      feature.userStories.flatMap((story) =>
        story.tasks.map((task) => ({
          epic,
          feature,
          story,
          task
        }))
      )
    )
  );
}

function allTaskContexts() {
  if (!state.taskboard) {
    return [];
  }

  return getTaskContexts(state.taskboard);
}

function getFilteredTaskContexts() {
  return allTaskContexts().filter(({ epic, feature }) => {
    if (state.filters.epicId && epic.id !== state.filters.epicId) {
      return false;
    }

    if (state.filters.featureId && feature.id !== state.filters.featureId) {
      return false;
    }

    return true;
  });
}

function findEpic(epicId) {
  return state.taskboard?.epics.find((epic) => epic.id === epicId) || null;
}

function findFeature(featureId) {
  for (const epic of state.taskboard?.epics || []) {
    const feature = epic.features.find((item) => item.id === featureId);
    if (feature) {
      return feature;
    }
  }

  return null;
}

function findStory(storyId) {
  for (const epic of state.taskboard?.epics || []) {
    for (const feature of epic.features) {
      const story = feature.userStories.find((item) => item.id === storyId);
      if (story) {
        return story;
      }
    }
  }

  return null;
}

function findTask(taskId) {
  return allTaskContexts().map((entry) => entry.task).find((task) => task.id === taskId) || null;
}

function getTaskContext(taskId) {
  return allTaskContexts().find((entry) => entry.task.id === taskId) || null;
}

function isExpanded(id) {
  return state.expanded.has(id);
}

function setView(view) {
  state.activeView = view;
  viewBoard.classList.toggle("hidden", view !== "board");
  viewBacklog.classList.toggle("hidden", view !== "backlog");

  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.view === view);
  }
}

function renderFilters() {
  const epics = state.taskboard?.epics || [];
  filterEpic.innerHTML = [
    '<option value="">All Epics</option>',
    ...epics.map((epic) => `<option value="${epic.id}">${escapeHtml(epic.title)}</option>`)
  ].join("");
  filterEpic.value = state.filters.epicId;

  const visibleFeatures = state.filters.epicId
    ? findEpic(state.filters.epicId)?.features || []
    : epics.flatMap((epic) => epic.features);

  filterFeature.innerHTML = [
    '<option value="">All Features</option>',
    ...visibleFeatures.map((feature) => `<option value="${feature.id}">${escapeHtml(feature.title)}</option>`)
  ].join("");

  if (!visibleFeatures.some((feature) => feature.id === state.filters.featureId)) {
    state.filters.featureId = "";
  }

  filterFeature.value = state.filters.featureId;
}

function renderTaskCard({ epic, feature, story, task }) {
  const tags = (task.tags || []).slice(0, 3).map((tag) => `<span class="card-tag">${escapeHtml(tag)}</span>`).join("");

  return `
    <article
      class="task-card${task.isBlockedByLinks ? " blocked" : ""}"
      draggable="true"
      data-task-id="${task.id}"
      title="${escapeHtml(story.title)}"
    >
      <h3 class="card-title">${escapeHtml(task.title)}</h3>
      <div class="card-meta">
        <span class="card-priority ${priorityClass(task.priority)}">${escapeHtml(task.priority)}</span>
        ${task.estimate ? `<span class="card-estimate">${escapeHtml(task.estimate)}</span>` : ""}
      </div>
      <div class="card-epic">${escapeHtml(epic.title)} / ${escapeHtml(feature.title)}</div>
      ${tags ? `<div class="card-tags">${tags}</div>` : ""}
    </article>
  `;
}

function renderKanban() {
  const contexts = getFilteredTaskContexts();

  if (!contexts.length) {
    kanbanBoard.innerHTML = '<p class="empty-state">No tasks match the current filter.</p>';
    return;
  }

  kanbanBoard.innerHTML = allowedStatuses
    .map((status) => {
      const items = contexts.filter((entry) => entry.task.status === status);

      return `
        <section class="k-col" data-status="${status}">
          <header class="k-col-header">
            <span>${escapeHtml(statusLabels[status] || status)}</span>
            <span class="col-count">${items.length}</span>
          </header>
          <div class="k-cards" data-drop-status="${status}">
            ${items.length ? items.map(renderTaskCard).join("") : '<div class="k-empty">No tasks</div>'}
          </div>
        </section>
      `;
    })
    .join("");
}

function backlogBadge(label, className = "") {
  return `<span class="bl-badge ${className}">${escapeHtml(label)}</span>`;
}

function renderTaskRow(task) {
  return `
    <div class="bl-task-row">
      <div class="bl-task-header">
        <span class="bl-title">${escapeHtml(task.title)}</span>
        ${backlogBadge(task.status, `status-${task.status}`)}
        ${backlogBadge(task.priority)}
        <div class="bl-actions">
          <button class="secondary" data-action="edit-task" data-id="${task.id}">Edit</button>
          <button class="destructive" data-action="delete-task" data-id="${task.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function renderStory(story) {
  const expanded = isExpanded(story.id);
  return `
    <div class="bl-story">
      <div class="bl-story-header">
        <button class="bl-expand" data-action="toggle-expand" data-id="${story.id}">${expanded ? "▾" : "▸"}</button>
        <span class="bl-title">${escapeHtml(story.title)}</span>
        ${backlogBadge(story.status, `status-${story.status}`)}
        <div class="bl-actions">
          <button class="secondary" data-action="add-task" data-id="${story.id}">+ Task</button>
          <button class="secondary" data-action="edit-story" data-id="${story.id}">Edit</button>
          <button class="destructive" data-action="delete-story" data-id="${story.id}">Delete</button>
        </div>
      </div>
      <div class="bl-children${expanded ? "" : " hidden"}">
        ${story.tasks.length ? story.tasks.map(renderTaskRow).join("") : '<p class="empty-state">No tasks.</p>'}
      </div>
    </div>
  `;
}

function renderFeature(feature) {
  const expanded = isExpanded(feature.id);
  return `
    <div class="bl-feature">
      <div class="bl-feature-header">
        <button class="bl-expand" data-action="toggle-expand" data-id="${feature.id}">${expanded ? "▾" : "▸"}</button>
        <span class="bl-title">${escapeHtml(feature.title)}</span>
        ${backlogBadge(feature.status, `status-${feature.status}`)}
        <div class="bl-actions">
          <button class="secondary" data-action="add-story" data-id="${feature.id}">+ Story</button>
          <button class="secondary" data-action="edit-feature" data-id="${feature.id}">Edit</button>
          <button class="destructive" data-action="delete-feature" data-id="${feature.id}">Delete</button>
        </div>
      </div>
      <div class="bl-children${expanded ? "" : " hidden"}">
        ${feature.userStories.length ? feature.userStories.map(renderStory).join("") : '<p class="empty-state">No stories.</p>'}
      </div>
    </div>
  `;
}

function renderBacklog() {
  const epics = state.taskboard?.epics || [];

  if (!epics.length) {
    backlogRoot.innerHTML = '<p class="empty-state">No epics yet. Create one and build the backlog properly.</p>';
    return;
  }

  backlogRoot.innerHTML = epics
    .map((epic) => {
      const expanded = isExpanded(epic.id);
      return `
        <section class="bl-epic">
          <div class="bl-epic-header">
            <button class="bl-expand" data-action="toggle-expand" data-id="${epic.id}">${expanded ? "▾" : "▸"}</button>
            <span class="bl-title">${escapeHtml(epic.title)}</span>
            ${backlogBadge(epic.status, `status-${epic.status}`)}
            ${backlogBadge(epic.priority)}
            <div class="bl-actions">
              <button class="secondary" data-action="add-feature" data-id="${epic.id}">+ Feature</button>
              <button class="secondary" data-action="edit-epic" data-id="${epic.id}">Edit</button>
              <button class="destructive" data-action="delete-epic" data-id="${epic.id}">Delete</button>
            </div>
          </div>
          <div class="bl-children${expanded ? "" : " hidden"}">
            ${epic.features.length ? epic.features.map(renderFeature).join("") : '<p class="empty-state">No features.</p>'}
          </div>
        </section>
      `;
    })
    .join("");
}

function render() {
  if (!state.taskboard) {
    kanbanBoard.innerHTML = '<p class="empty-state">Taskboard is unavailable.</p>';
    backlogRoot.innerHTML = "";
    return;
  }

  const boardBrief = state.taskboard.boardBrief || {};
  productNameHeading.textContent = boardBrief.productName || "Kanboard";
  renderFilters();
  renderKanban();
  renderBacklog();
}

async function reload() {
  const [health, taskboard] = await Promise.all([request("/api/health"), request("/api/taskboard")]);
  setRunState(health);
  state.taskboard = taskboard;

  if (!state.expanded.size) {
    for (const epic of taskboard.epics) {
      state.expanded.add(epic.id);
      for (const feature of epic.features) {
        state.expanded.add(feature.id);
      }
    }
  }

  render();
}

function openModal(title, bodyHtml) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modal.showModal();
}

function closeModal() {
  modal.close();
  modalBody.innerHTML = "";
}

function optionsForEpics(selectedId = "") {
  return (state.taskboard?.epics || [])
    .map((epic) => `<option value="${epic.id}"${epic.id === selectedId ? " selected" : ""}>${escapeHtml(epic.title)}</option>`)
    .join("");
}

function optionsForFeatures(selectedId = "", epicId = "") {
  const features = epicId ? findEpic(epicId)?.features || [] : (state.taskboard?.epics || []).flatMap((epic) => epic.features);
  return features
    .map((feature) => `<option value="${feature.id}"${feature.id === selectedId ? " selected" : ""}>${escapeHtml(feature.title)}</option>`)
    .join("");
}

function optionsForStories(selectedId = "", featureId = "") {
  const stories = featureId
    ? findFeature(featureId)?.userStories || []
    : (state.taskboard?.epics || []).flatMap((epic) => epic.features.flatMap((feature) => feature.userStories));
  return stories
    .map((story) => `<option value="${story.id}"${story.id === selectedId ? " selected" : ""}>${escapeHtml(story.title)}</option>`)
    .join("");
}

function statusOptions(selected = "pending") {
  return allowedStatuses
    .map((status) => `<option value="${status}"${status === selected ? " selected" : ""}>${escapeHtml(statusLabels[status])}</option>`)
    .join("");
}

function priorityOptions(selected = "medium") {
  return allowedPriorities
    .map((priority) => `<option value="${priority}"${priority === selected ? " selected" : ""}>${escapeHtml(priority)}</option>`)
    .join("");
}

function textInput(name, label, value = "", required = false) {
  return `
    <label>
      ${escapeHtml(label)}
      <input name="${name}" value="${escapeHtml(value)}"${required ? " required" : ""} />
    </label>
  `;
}

function textareaInput(name, label, value = "", rows = 4) {
  return `
    <label>
      ${escapeHtml(label)}
      <textarea name="${name}" rows="${rows}">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function selectInput(name, label, options) {
  return `
    <label>
      ${escapeHtml(label)}
      <select name="${name}">${options}</select>
    </label>
  `;
}

function buildEntityForm(config) {
  return `
    <form class="form-grid" data-form-type="${config.type}">
      ${config.body}
      <div class="form-footer">
        <button type="button" class="secondary" data-action="close-modal">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  `;
}

function openBoardBriefModal() {
  const boardBrief = state.taskboard?.boardBrief || {};
  openModal(
    "Board Brief",
    buildEntityForm({
      type: "board-brief",
      body: [
        textInput("productName", "Product name", boardBrief.productName || "", true),
        textareaInput("objective", "Objective", boardBrief.objective || "", 4),
        textareaInput("scopeDefinition", "Scope definition", boardBrief.scopeDefinition || "", 4),
        textareaInput("nonGoals", "Non-goals", boardBrief.nonGoals || "", 3),
        textareaInput("successCriteria", "Success criteria", boardBrief.successCriteria || "", 3),
        textareaInput("currentFocus", "Current focus", boardBrief.currentFocus || "", 3),
        textareaInput("implementationNotes", "Implementation notes", boardBrief.implementationNotes || "", 6),
        boardBrief.updatedAt ? `<div class="empty-state">Updated ${escapeHtml(formatDate(boardBrief.updatedAt))}</div>` : ""
      ].join("")
    })
  );
}

function openEpicModal(epic) {
  openModal(
    epic ? "Edit Epic" : "Create Epic",
    buildEntityForm({
      type: epic ? "edit-epic" : "create-epic",
      body: [
        epic ? `<input type="hidden" name="id" value="${epic.id}" />` : "",
        textInput("title", "Title", epic?.title || "", true),
        textareaInput("summary", "Summary", epic?.summary || "", 4),
        '<div class="form-row">',
        selectInput("status", "Status", statusOptions(epic?.status || "pending")),
        selectInput("priority", "Priority", priorityOptions(epic?.priority || "medium")),
        "</div>"
      ].join("")
    })
  );
}

function openFeatureModal(feature, epicId = "") {
  openModal(
    feature ? "Edit Feature" : "Create Feature",
    buildEntityForm({
      type: feature ? "edit-feature" : "create-feature",
      body: [
        feature ? `<input type="hidden" name="id" value="${feature.id}" />` : "",
        selectInput("epicId", "Epic", optionsForEpics(feature?.epicId || epicId)),
        textInput("title", "Title", feature?.title || "", true),
        textareaInput("summary", "Summary", feature?.summary || "", 4),
        '<div class="form-row">',
        selectInput("status", "Status", statusOptions(feature?.status || "pending")),
        selectInput("priority", "Priority", priorityOptions(feature?.priority || "medium")),
        "</div>"
      ].join("")
    })
  );
}

function openStoryModal(story, featureId = "") {
  openModal(
    story ? "Edit Story" : "Create Story",
    buildEntityForm({
      type: story ? "edit-story" : "create-story",
      body: [
        story ? `<input type="hidden" name="id" value="${story.id}" />` : "",
        selectInput("featureId", "Feature", optionsForFeatures(story?.featureId || featureId, state.filters.epicId)),
        textInput("title", "Title", story?.title || "", true),
        textareaInput("summary", "Summary", story?.summary || "", 4),
        textareaInput("acceptanceCriteria", "Acceptance criteria (one per line)", (story?.acceptanceCriteria || []).join("\n"), 5),
        '<div class="form-row">',
        selectInput("status", "Status", statusOptions(story?.status || "pending")),
        selectInput("priority", "Priority", priorityOptions(story?.priority || "medium")),
        "</div>"
      ].join("")
    })
  );
}

function openTaskModal(task, storyId = "") {
  const context = task ? getTaskContext(task.id) : null;
  openModal(
    task ? "Edit Task" : "Create Task",
    buildEntityForm({
      type: task ? "edit-task" : "create-task",
      body: [
        task ? `<input type="hidden" name="id" value="${task.id}" />` : "",
        selectInput("storyId", "Story", optionsForStories(task?.storyId || storyId, state.filters.featureId)),
        textInput("title", "Title", task?.title || "", true),
        textareaInput("summary", "Summary", task?.summary || "", 4),
        textareaInput("implementationNotes", "Implementation notes", task?.implementationNotes || "", 4),
        '<div class="form-row">',
        textInput("estimate", "Estimate", task?.estimate || ""),
        textInput("tags", "Tags (comma-separated)", (task?.tags || []).join(", ")),
        "</div>",
        '<div class="form-row">',
        selectInput("status", "Status", statusOptions(task?.status || "pending")),
        selectInput("priority", "Priority", priorityOptions(task?.priority || "medium")),
        "</div>",
        context ? `<div class="empty-state">${escapeHtml(context.epic.title)} / ${escapeHtml(context.feature.title)} / ${escapeHtml(context.story.title)}</div>` : ""
      ].join("")
    })
  );
}

function parseLineList(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCommaList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function submitBoardBrief(formData) {
  await request("/api/board-brief", {
    method: "PUT",
    body: JSON.stringify({
      productName: formData.get("productName")?.trim() || "",
      objective: formData.get("objective")?.trim() || "",
      scopeDefinition: formData.get("scopeDefinition")?.trim() || "",
      nonGoals: formData.get("nonGoals")?.trim() || "",
      successCriteria: formData.get("successCriteria")?.trim() || "",
      currentFocus: formData.get("currentFocus")?.trim() || "",
      implementationNotes: formData.get("implementationNotes")?.trim() || ""
    })
  });
}

async function submitCreateEpic(formData) {
  await request("/api/epics", {
    method: "POST",
    body: JSON.stringify({
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitEditEpic(formData) {
  const id = formData.get("id");
  await request(`/api/epics/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitCreateFeature(formData) {
  await request("/api/features", {
    method: "POST",
    body: JSON.stringify({
      epicId: formData.get("epicId"),
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitEditFeature(formData) {
  const id = formData.get("id");
  await request(`/api/features/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitCreateStory(formData) {
  await request("/api/stories", {
    method: "POST",
    body: JSON.stringify({
      featureId: formData.get("featureId"),
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      acceptanceCriteria: parseLineList(formData.get("acceptanceCriteria") || ""),
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitEditStory(formData) {
  const id = formData.get("id");
  await request(`/api/stories/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      acceptanceCriteria: parseLineList(formData.get("acceptanceCriteria") || ""),
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitCreateTask(formData) {
  await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      storyId: formData.get("storyId"),
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      implementationNotes: formData.get("implementationNotes")?.trim() || "",
      estimate: formData.get("estimate")?.trim() || "",
      tags: parseCommaList(formData.get("tags") || ""),
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function submitEditTask(formData) {
  const id = formData.get("id");
  await request(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: formData.get("title")?.trim(),
      summary: formData.get("summary")?.trim() || "",
      implementationNotes: formData.get("implementationNotes")?.trim() || "",
      estimate: formData.get("estimate")?.trim() || "",
      tags: parseCommaList(formData.get("tags") || ""),
      status: formData.get("status"),
      priority: formData.get("priority")
    })
  });
}

async function deletePath(path, message) {
  if (!window.confirm(message)) {
    return;
  }

  await request(path, {
    method: "DELETE",
    body: JSON.stringify({})
  });
}

async function moveTask(taskId, status) {
  const task = findTask(taskId);
  if (!task || task.status === status) {
    return;
  }

  await request(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });

  await reload();
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

filterEpic.addEventListener("change", () => {
  state.filters.epicId = filterEpic.value;
  state.filters.featureId = "";
  render();
});

filterFeature.addEventListener("change", () => {
  state.filters.featureId = filterFeature.value;
  render();
});

btnRefresh.addEventListener("click", async () => {
  try {
    await reload();
  } catch (error) {
    window.alert(getErrorMessage(error));
  }
});

btnBrief.addEventListener("click", () => openBoardBriefModal());
btnAddEpic.addEventListener("click", () => openEpicModal(null));
btnAddTask.addEventListener("click", () => openTaskModal(null));
modalClose.addEventListener("click", closeModal);
modal.addEventListener("close", () => {
  modalBody.innerHTML = "";
});

modalBody.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  if (target.dataset.action === "close-modal") {
    closeModal();
  }
});

modalBody.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form-type]");
  if (!form) {
    return;
  }

  event.preventDefault();
  const formData = new FormData(form);
  const formType = form.dataset.formType;

  try {
    switch (formType) {
      case "board-brief":
        await submitBoardBrief(formData);
        break;
      case "create-epic":
        await submitCreateEpic(formData);
        break;
      case "edit-epic":
        await submitEditEpic(formData);
        break;
      case "create-feature":
        await submitCreateFeature(formData);
        break;
      case "edit-feature":
        await submitEditFeature(formData);
        break;
      case "create-story":
        await submitCreateStory(formData);
        break;
      case "edit-story":
        await submitEditStory(formData);
        break;
      case "create-task":
        await submitCreateTask(formData);
        break;
      case "edit-task":
        await submitEditTask(formData);
        break;
      default:
        return;
    }

    closeModal();
    await reload();
  } catch (error) {
    window.alert(getErrorMessage(error));
  }
});

function toggleExpand(id) {
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
  } else {
    state.expanded.add(id);
  }
  renderBacklog();
}

backlogRoot.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const { action, id } = target.dataset;

  try {
    switch (action) {
      case "toggle-expand":
        toggleExpand(id);
        break;
      case "add-feature":
        openFeatureModal(null, id);
        break;
      case "edit-epic":
        openEpicModal(findEpic(id));
        break;
      case "delete-epic":
        await deletePath(`/api/epics/${id}`, "Delete this epic and everything under it?");
        await reload();
        break;
      case "add-story":
        openStoryModal(null, id);
        break;
      case "edit-feature":
        openFeatureModal(findFeature(id));
        break;
      case "delete-feature":
        await deletePath(`/api/features/${id}`, "Delete this feature and its descendants?");
        await reload();
        break;
      case "add-task":
        openTaskModal(null, id);
        break;
      case "edit-story":
        openStoryModal(findStory(id));
        break;
      case "delete-story":
        await deletePath(`/api/stories/${id}`, "Delete this story and all nested tasks?");
        await reload();
        break;
      case "edit-task":
        openTaskModal(findTask(id));
        break;
      case "delete-task":
        await deletePath(`/api/tasks/${id}`, "Delete this task?");
        await reload();
        break;
      default:
        break;
    }
  } catch (error) {
    window.alert(getErrorMessage(error));
  }
});

kanbanBoard.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".task-card");
  if (!card) {
    return;
  }

  state.dragTaskId = card.dataset.taskId;
  card.style.opacity = "0.4";
});

kanbanBoard.addEventListener("dragend", (event) => {
  const card = event.target.closest(".task-card");
  if (card) {
    card.style.opacity = "1";
  }
  state.dragTaskId = null;
});

kanbanBoard.addEventListener("dragover", (event) => {
  const column = event.target.closest("[data-drop-status]");
  if (!column) {
    return;
  }

  event.preventDefault();
});

kanbanBoard.addEventListener("drop", async (event) => {
  const column = event.target.closest("[data-drop-status]");
  if (!column || !state.dragTaskId) {
    return;
  }

  event.preventDefault();

  try {
    await moveTask(state.dragTaskId, column.dataset.dropStatus);
  } catch (error) {
    window.alert(getErrorMessage(error));
  }
});

kanbanBoard.addEventListener("click", (event) => {
  const card = event.target.closest(".task-card");
  if (!card) {
    return;
  }

  openTaskModal(findTask(card.dataset.taskId));
});

reload().catch((error) => {
  setRunState(null);
  kanbanBoard.innerHTML = `<p class="empty-state">${escapeHtml(getErrorMessage(error))}</p>`;
});
