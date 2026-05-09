export const allowedStatuses = ["pending", "ready", "in-progress", "review", "blocked", "done"];
export const allowedPriorities = ["low", "medium", "high", "critical"];

export const statusLabels = {
  pending: "To Do",
  ready: "Ready",
  "in-progress": "In Progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done"
};

export const viewLabels = {
  board: "Board",
  backlog: "Backlog",
  brief: "Board Brief"
};

export function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

export function parseHashView() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return "board";
  return viewLabels[hash] ? hash : "board";
}

export function runStateLabel(health) {
  if (!health) return "Disconnected";
  const labels = { private: "Private", "private-backup": "Private + Backup", team: "Team" };
  return labels[health.mode] || health.mode || "Private";
}

export function runStateTitle(health) {
  if (!health) return "The UI could not reach the local taskboard server.";
  if (health.mode === "team") return "Team mode: shared DB is authoritative and local state is mirrored.";
  if (health.mode === "private-backup") return "Private backup mode: local state is authoritative with scheduled remote backups.";
  return health.stateDir || "Private local state package";
}

export function getTaskContexts(taskboard) {
  return (taskboard?.epics || []).flatMap((epic) =>
    epic.features.flatMap((feature) =>
      feature.userStories.flatMap((story) =>
        story.tasks.map((task) => ({ epic, feature, story, task }))
      )
    )
  );
}

export function priorityClass(priority) {
  return allowedPriorities.includes(priority) ? priority : "low";
}

export function parseLineList(value) {
  return String(value || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

export function parseCommaList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function makeOptions(collection, selectedId) {
  return collection.map((item) => ({ value: item.id, label: item.title, selected: item.id === selectedId }));
}
