import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { request, getErrorMessage } from "./api.js";
import { parseHashView, parseLineList, parseCommaList, getTaskContexts } from "./utils.js";
import { Header } from "./Header.js";
import { BoardView } from "./BoardView.js";
import { BacklogView } from "./BacklogView.js";
import { BoardBriefView } from "./BoardBriefView.js";
import { FormModal } from "./Modal.js";

const html = htm.bind(React.createElement);

export function App() {
  const [activeView, setActiveView] = useState(parseHashView());
  const [health, setHealth] = useState(null);
  const [taskboard, setTaskboard] = useState(null);
  const [filters, setFilters] = useState({ epicId: "", featureId: "" });
  const [expanded, setExpanded] = useState(new Set());
  const [modalStack, setModalStack] = useState([]);
  const [confirmState, setConfirmState] = useState(null);

  const lookup = useMemo(() => {
    const epics = taskboard?.epics || [];
    const allContexts = getTaskContexts(taskboard);
    return {
      findEpic: (id) => epics.find((e) => e.id === id) || null,
      findFeature: (id) => {
        for (const epic of epics) {
          const f = epic.features.find((f) => f.id === id);
          if (f) return f;
        }
        return null;
      },
      findStory: (id) => {
        for (const epic of epics) {
          for (const feature of epic.features) {
            const s = feature.userStories.find((s) => s.id === id);
            if (s) return s;
          }
        }
        return null;
      },
      findTask: (id) => allContexts.map((c) => c.task).find((t) => t.id === id) || null,
      getTaskContext: (id) => allContexts.find((c) => c.task.id === id) || null
    };
  }, [taskboard]);

  async function reload() {
    const [nextHealth, nextTaskboard] = await Promise.all([
      request("/api/health"),
      request("/api/taskboard")
    ]);
    setHealth(nextHealth);
    setTaskboard(nextTaskboard);
    setExpanded((prev) => {
      if (prev.size) return prev;
      const seed = new Set();
      for (const epic of nextTaskboard.epics) {
        seed.add(epic.id);
        for (const feature of epic.features) seed.add(feature.id);
      }
      return seed;
    });
  }

  useEffect(() => {
    reload().catch((err) => { setHealth(null); window.alert(getErrorMessage(err)); });
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveView(parseHashView());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function childSelectionField(formType) {
    if (formType === "create-epic") return "epicId";
    if (formType === "create-feature") return "featureId";
    if (formType === "create-story") return "storyId";
    return null;
  }

  async function submitModal(formType, formData) {
    try {
      let result = null;
      switch (formType) {
        case "board-brief":
          result = await request("/api/board-brief", { method: "PUT", body: JSON.stringify({
            productName: formData.get("productName")?.trim() || "",
            objective: formData.get("objective")?.trim() || "",
            scopeDefinition: formData.get("scopeDefinition")?.trim() || "",
            nonGoals: formData.get("nonGoals")?.trim() || "",
            successCriteria: formData.get("successCriteria")?.trim() || "",
            currentFocus: formData.get("currentFocus")?.trim() || "",
            implementationNotes: formData.get("implementationNotes")?.trim() || ""
          })});
          break;
        case "create-epic":
          result = await request("/api/epics", { method: "POST", body: JSON.stringify({
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "edit-epic":
          result = await request(`/api/epics/${formData.get("id")}`, { method: "PATCH", body: JSON.stringify({
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "create-feature":
          result = await request("/api/features", { method: "POST", body: JSON.stringify({
            epicId: formData.get("epicId"),
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "edit-feature":
          result = await request(`/api/features/${formData.get("id")}`, { method: "PATCH", body: JSON.stringify({
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "create-story":
          result = await request("/api/stories", { method: "POST", body: JSON.stringify({
            featureId: formData.get("featureId"),
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            acceptanceCriteria: parseLineList(formData.get("acceptanceCriteria") || ""),
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "edit-story":
          result = await request(`/api/stories/${formData.get("id")}`, { method: "PATCH", body: JSON.stringify({
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            acceptanceCriteria: parseLineList(formData.get("acceptanceCriteria") || ""),
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "create-task":
          result = await request("/api/tasks", { method: "POST", body: JSON.stringify({
            storyId: formData.get("storyId"),
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            implementationNotes: formData.get("implementationNotes")?.trim() || "",
            estimate: formData.get("estimate")?.trim() || "",
            tags: parseCommaList(formData.get("tags") || ""),
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        case "edit-task":
          result = await request(`/api/tasks/${formData.get("id")}`, { method: "PATCH", body: JSON.stringify({
            title: formData.get("title")?.trim(),
            summary: formData.get("summary")?.trim() || "",
            implementationNotes: formData.get("implementationNotes")?.trim() || "",
            estimate: formData.get("estimate")?.trim() || "",
            tags: parseCommaList(formData.get("tags") || ""),
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        default:
          break;
      }
      await reload();
      // This relies on synchronous create responses returning the created entity immediately.
      // Revisit if stacked creates move to async background refreshes or optimistic writes.
      setModalStack((prev) => {
        if (prev.length <= 1) {
          return [];
        }

        const next = prev.slice(0, -1);
        const selectionField = childSelectionField(formType);
        const createdId = selectionField && result && typeof result === "object" ? result.id : null;

        if (selectionField && typeof createdId === "string" && createdId) {
          const parentFrame = next[next.length - 1];
          next[next.length - 1] = {
            ...parentFrame,
            savedValues: {
              ...(parentFrame.savedValues || {}),
              [selectionField]: createdId
            }
          };
        }

        return next;
      });
    } catch (err) {
      window.alert(getErrorMessage(err));
    }
  }

  async function moveTask(taskId, status) {
    const task = lookup.findTask(taskId);
    if (!task || task.status === status) return;
    try {
      await request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await reload();
    } catch (err) {
      window.alert(getErrorMessage(err));
    }
  }

  function showConfirm(message) {
    return new Promise((resolve) => setConfirmState({ message, resolve }));
  }

  function dismissConfirm(result) {
    setConfirmState((prev) => {
      prev?.resolve(result);
      return null;
    });
  }

  async function deletePath(path, message) {
    const confirmed = await showConfirm(message);
    if (!confirmed) return;
    try {
      await request(path, { method: "DELETE", body: JSON.stringify({}) });
      await reload();
    } catch (err) {
      window.alert(getErrorMessage(err));
    }
  }

  function openModal(type, title, entity = null, parentId = "") {
    setModalStack([{ type, title, entity, parentId, savedValues: null }]);
  }

  function pushModal(type, title, entity = null, parentId = "") {
    setModalStack((prev) => [...prev, { type, title, entity, parentId, savedValues: null }]);
  }

  function popModal() {
    setModalStack((prev) => prev.slice(0, -1));
  }

  function clearModals() {
    setModalStack([]);
  }

  function saveFrameValues(values) {
    setModalStack((prev) => {
      if (!prev.length) return prev;
      const copy = [...prev];
      copy[copy.length - 1] = { ...copy[copy.length - 1], savedValues: values };
      return copy;
    });
  }

  function handleBacklogAction(action, id) {
    const actionMap = {
      "add-feature": () => openModal("create-feature", "Create Feature", null, id),
      "edit-epic": () => openModal("edit-epic", "Edit Epic", lookup.findEpic(id)),
      "delete-epic": () => deletePath(`/api/epics/${id}`, "Delete this epic and everything under it?"),
      "add-story": () => openModal("create-story", "Create Story", null, id),
      "edit-feature": () => openModal("edit-feature", "Edit Feature", lookup.findFeature(id)),
      "delete-feature": () => deletePath(`/api/features/${id}`, "Delete this feature and its descendants?"),
      "add-task": () => openModal("create-task", "Create Task", null, id),
      "edit-story": () => openModal("edit-story", "Edit Story", lookup.findStory(id)),
      "delete-story": () => deletePath(`/api/stories/${id}`, "Delete this story and all nested tasks?"),
      "edit-task": () => openModal("edit-task", "Edit Task", lookup.findTask(id)),
      "delete-task": () => deletePath(`/api/tasks/${id}`, "Delete this task?")
    };
    actionMap[action]?.();
  }

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function saveBoardBrief(payload) {
    try {
      await request("/api/board-brief", { method: "PUT", body: JSON.stringify(payload) });
      await reload();
    } catch (err) {
      window.alert(getErrorMessage(err));
    }
  }

  function navigateTo(view) {
    setActiveView(view);
    window.location.hash = `/${view}`;
  }

  const refreshSafe = () => reload().catch((err) => window.alert(getErrorMessage(err)));
  const boardBrief = taskboard?.boardBrief || {};

  if (!taskboard) {
    return html`
      <main className="app-shell">
        <${Header}
          productName="Kanboard"
          health=${health}
          activeView=${activeView}
          onViewChange=${navigateTo}
          onRefresh=${refreshSafe}
        />
        <p className="empty-major">Loading taskboard...</p>
      </main>
    `;
  }

  return html`
    <main className="app-shell">
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>

      <${Header}
        productName=${boardBrief.productName || "Kanboard"}
        health=${health}
        activeView=${activeView}
        onViewChange=${navigateTo}
        onRefresh=${refreshSafe}
      />

      ${activeView === "board" ? html`
        <${BoardView}
          taskboard=${taskboard}
          filters=${filters}
          onFilterChange=${setFilters}
          onAddTask=${() => openModal("create-task", "Create Task")}
          onTaskClick=${(id) => openModal("edit-task", "Edit Task", lookup.findTask(id))}
          onMoveTask=${moveTask}
          onAddEpic=${() => openModal("create-epic", "Create Epic")}
          onAddFeature=${() => openModal("create-feature", "Create Feature")}
        />
      ` : null}

      ${activeView === "backlog" ? html`
        <${BacklogView}
          taskboard=${taskboard}
          expanded=${expanded}
          onToggle=${toggleExpanded}
          onAction=${handleBacklogAction}
          onAddEpic=${() => openModal("create-epic", "Create Epic")}
        />
      ` : null}

      ${activeView === "brief" ? html`
        <${BoardBriefView} boardBrief=${boardBrief} onSave=${saveBoardBrief} />
      ` : null}

      ${modalStack.length > 0 ? html`
        <${FormModal}
          key=${"frame-" + (modalStack.length - 1)}
          modal=${modalStack[modalStack.length - 1]}
          stackDepth=${modalStack.length}
          onClose=${popModal}
          onCloseAll=${clearModals}
          onSubmit=${submitModal}
          taskboard=${taskboard}
          activeFilters=${filters}
          lookup=${lookup}
          onSwitchModal=${pushModal}
          onSaveValues=${saveFrameValues}
        />
      ` : null}

      ${confirmState ? html`
        <div className="modal-backdrop" role="presentation" onClick=${() => dismissConfirm(false)}>
          <div className="modal-shell modal-shell--sm" role="alertdialog" aria-modal="true" onClick=${(e) => e.stopPropagation()}>
            <p className="confirm-message">${confirmState.message}</p>
            <div className="form-footer">
              <button className="button button-ghost" type="button" onClick=${() => dismissConfirm(false)}>Cancel</button>
              <button className="button button-danger" type="button" onClick=${() => dismissConfirm(true)}>Delete</button>
            </div>
          </div>
        </div>
      ` : null}
    </main>
  `;
}
