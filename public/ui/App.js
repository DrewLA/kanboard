import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { request, getErrorMessage } from "./api.js";
import { parseHashView, parseLineList, parseCommaList, getTaskContexts } from "./utils.js";

import { Header } from "./Header.js";
import { BoardView } from "./BoardView.js";
import { BacklogView } from "./BacklogView.js";
import { BoardBriefView } from "./BoardBriefView.js";
import { FormModal } from "./Modal.js";
import { AgentsPane } from "./AgentsPane.js";

const html = htm.bind(React.createElement);

// --- Skeleton Components ---
function SkeletonBoard() {
  return html`
    <section className="view-shell">
      <div
        className="panel-toolbar glass-panel skeleton skeleton-bar"
        style=${{ height: "38px", width: "100%", maxWidth: "600px", marginBottom: "10px" }}
      ></div>
      <div className="kanban-grid">
        ${Array.from({ length: 6 }).map((_, i) => html`
          <section key=${i} className="kanban-col glass-panel">
            <header
              className="kanban-col-header skeleton skeleton-bar"
              style=${{ height: "32px", width: "90%", margin: "10px auto" }}
            ></header>
            <div className="kanban-cards">
              ${Array.from({ length: 3 }).map((_, j) => html`
                <div key=${j} className="task-card skeleton skeleton-card" style=${{ height: "72px" }}></div>
              `)}
            </div>
          </section>
        `)}
      </div>
    </section>
  `;
}

function SkeletonBacklog() {
  return html`
    <section className="view-shell">
      <div
        className="panel-toolbar glass-panel skeleton skeleton-bar"
        style=${{ height: "38px", width: "180px", marginBottom: "10px" }}
      ></div>
      <div className="backlog-wrap">
        ${Array.from({ length: 3 }).map((_, i) => html`
          <section key=${i} className="backlog-node glass-panel">
            <header
              className="backlog-node-header skeleton skeleton-bar"
              style=${{ height: "32px", width: "98%", margin: "8px auto" }}
            ></header>
            <div className="backlog-children">
              ${Array.from({ length: 2 }).map((_, j) => html`
                <section key=${j} className="backlog-node feature glass-panel">
                  <header
                    className="backlog-node-header skeleton skeleton-bar"
                    style=${{ height: "28px", width: "95%", margin: "6px auto" }}
                  ></header>
                  <div className="backlog-children">
                    ${Array.from({ length: 1 }).map((_, k) => html`
                      <section key=${k} className="backlog-node story glass-panel">
                        <header
                          className="backlog-node-header skeleton skeleton-bar"
                          style=${{ height: "24px", width: "92%", margin: "4px auto" }}
                        ></header>
                      </section>
                    `)}
                  </div>
                </section>
              `)}
            </div>
          </section>
        `)}
      </div>
    </section>
  `;
}

function SkeletonBrief() {
  return html`
    <section className="view-shell brief-view">
      <div
        className="brief-header glass-panel skeleton skeleton-bar"
        style=${{ height: "48px", width: "98%", margin: "10px auto" }}
      ></div>
      <div className="markdown-canvas glass-panel">
        <div
          className="markdown-canvas-header skeleton skeleton-bar"
          style=${{ height: "32px", width: "90%", margin: "10px auto" }}
        ></div>
        <div
          className="skeleton skeleton-block"
          style=${{ height: "220px", width: "96%", margin: "12px auto 0 auto", borderRadius: "12px" }}
        ></div>
      </div>
    </section>
  `;
}

function SkeletonAgentsPane({ open }) {
  return html`
    <aside className=${`agents-pane glass-panel${open ? " agents-pane--open" : ""}`} aria-label="Agents" aria-hidden=${!open}>
      <div className="agents-header skeleton skeleton-bar" style=${{ height: "32px", width: "98%", margin: "10px auto" }}></div>
      <div className="agents-mcp-bar skeleton skeleton-bar" style=${{ height: "22px", width: "90%", margin: "8px auto" }}></div>
      <div className="agents-body">
        <div className="agents-section-label skeleton skeleton-bar" style=${{ height: "18px", width: "60%", margin: "10px auto" }}></div>
        <div className="agent-card skeleton skeleton-card" style=${{ height: "54px", width: "96%", margin: "10px auto" }}></div>
        <div className="agent-card skeleton skeleton-card" style=${{ height: "54px", width: "96%", margin: "10px auto" }}></div>
      </div>
    </aside>
  `;
}

export function App() {
  const [activeView, setActiveView] = useState(parseHashView());
  const [health, setHealth] = useState(null);
  const [taskboard, setTaskboard] = useState(null);
  const [filters, setFilters] = useState({ epicId: "", featureId: "" });
  const [expanded, setExpanded] = useState(new Set());
  const [modalStack, setModalStack] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockRefreshing, setUnlockRefreshing] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [pendingOp, setPendingOp] = useState(false);
  const [flashError, setFlashError] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [agentCount, setAgentCount] = useState(0);
  const [agents, setAgents] = useState({ sessions: [], counts: { connected: 0, recent: 0 } });
  const [refreshing, setRefreshing] = useState(false);
  const taskboardRef = useRef(null);
  const reloadInFlightRef = useRef(null);

  useEffect(() => {
    taskboardRef.current = taskboard;
  }, [taskboard]);

  useEffect(() => {
    if (!health?.ok) return;
    const es = new EventSource("/api/agents/events");
    const handle = (e) => {
      const data = JSON.parse(e.data);
      setAgents(data);
      setAgentCount(data?.counts?.connected ?? 0);
    };
    es.addEventListener("agents-ready", handle);
    es.addEventListener("agents-changed", handle);
    return () => es.close();
  }, [health?.ok]);

  useEffect(() => {
    if (!flashError) return;
    const t = setTimeout(() => setFlashError(null), 7000);
    return () => clearTimeout(t);
  }, [flashError]);

  const usersMap = useMemo(() => {
    const m = {};
    for (const u of users) if (u.id) m[u.id] = u;
    return m;
  }, [users]);

  const lookup = useMemo(() => {
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

  async function reload(options = {}) {
    if (reloadInFlightRef.current) return reloadInFlightRef.current;

    const showSpinner = Boolean(options.showSpinner);
    if (showSpinner) setRefreshing(true);

    const run = (async () => {
      const nextHealth = await request("/api/health");
      setHealth(nextHealth);

      if (nextHealth?.identity?.required && !nextHealth.identity.unlocked) {
        setCurrentUser(null);
        setUsers([]);
        return;
      }

      const [nextTaskboard, nextUser, nextUsers] = await Promise.all([
        request("/api/taskboard"),
        request("/api/users/me").catch(() => null),
        request("/api/users").catch(() => [])
      ]);
      setTaskboard(nextTaskboard);
      setCurrentUser(nextUser);
      setUsers(nextUsers || []);
      setExpanded((prev) => {
        if (prev.size) return prev;
        const seed = new Set();
        for (const epic of nextTaskboard.epics) {
          seed.add(epic.id);
          for (const feature of epic.features) seed.add(feature.id);
        }
        return seed;
      });
    })();

    reloadInFlightRef.current = run;

    try {
      await run;
    } finally {
      reloadInFlightRef.current = null;
      if (showSpinner) setRefreshing(false);
    }
  }

  useEffect(() => {
    reload().catch((err) => { setHealth(null); setFlashError(getErrorMessage(err)); });
  }, []);

  useEffect(() => {
    if (!health?.ok) return;

    const events = new EventSource("/api/board-events");
    const onBoardChanged = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const nextRevision = Number(payload?.revision);
        const currentRevision = taskboardRef.current?.revision;
        if (!Number.isFinite(nextRevision) || nextRevision === currentRevision) return;

        reload({ showSpinner: true }).catch((err) => setFlashError(getErrorMessage(err)));
      } catch (error) {
        setFlashError(getErrorMessage(error));
      }
    };

    events.addEventListener("board-changed", onBoardChanged);
    return () => events.close();
  }, [health?.ok]);

  useEffect(() => {
    const onHashChange = () => setActiveView(parseHashView());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const identityStatus = health?.identity || null;
  const needsUnlock = Boolean(identityStatus?.required && !identityStatus?.unlocked && !unlockRefreshing);

  function childSelectionField(formType) {
    if (formType === "create-epic") return "epicId";
    if (formType === "create-feature") return "featureId";
    if (formType === "create-story") return "storyId";
    return null;
  }

  async function submitModal(formType, formData) {
    setPendingOp(true);
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
            assignedTo: formData.get("assignedTo") || null,
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
            assignedTo: formData.get("assignedTo") || null,
            status: formData.get("status"),
            priority: formData.get("priority")
          })});
          break;
        default:
          break;
      }
      await reload();
      setPendingOp(false);
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
      setPendingOp(false);
      setModalError(getErrorMessage(err));
    }
  }

  async function moveTask(taskId, status) {
    const task = lookup.findTask(taskId);
    if (!task || task.status === status) return;
    setPendingOp(true);
    try {
      await request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await reload();
    } catch (err) {
      setFlashError(getErrorMessage(err));
    } finally {
      setPendingOp(false);
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
    setPendingOp(true);
    try {
      await request(path, { method: "DELETE", body: JSON.stringify({}) });
      await reload();
    } catch (err) {
      setFlashError(getErrorMessage(err));
    } finally {
      setPendingOp(false);
    }
  }

  function openModal(type, title, entity = null, parentId = "") {
    setModalError(null);
    setModalStack([{ type, title, entity, parentId, savedValues: null }]);
  }

  function pushModal(type, title, entity = null, parentId = "") {
    setModalError(null);
    setModalStack((prev) => [...prev, { type, title, entity, parentId, savedValues: null }]);
  }

  function popModal() {
    setModalError(null);
    setModalStack((prev) => prev.slice(0, -1));
  }

  function clearModals() {
    setModalError(null);
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
    setPendingOp(true);
    try {
      await request("/api/board-brief", { method: "PUT", body: JSON.stringify(payload) });
      await reload();
    } catch (err) {
      setFlashError(getErrorMessage(err));
    } finally {
      setPendingOp(false);
    }
  }

  function navigateTo(view) {
    setActiveView(view);
    window.location.hash = `/${view}`;
  }


  async function unlockIdentity(password) {
    setUnlocking(true);
    setUnlockError("");

    try {
      const result = await request("/api/identity/unlock", {
        method: "POST",
        body: JSON.stringify({ password })
      });

      setUnlockPassword("");

      // Close the unlock modal immediately on a successful response and let the
      // app refresh behind the normal loading skeleton.
      setHealth((prev) => prev ? {
        ...prev,
        identity: prev.identity ? { ...prev.identity, unlocked: true } : prev.identity
      } : prev);
      setCurrentUser(result?.currentUser ?? null);
      setUnlockRefreshing(true);
      setUnlocking(false);

      try {
        await reload();
      } finally {
        setUnlockRefreshing(false);
      }
    } catch (err) {
      setUnlockError(getErrorMessage(err));
      setUnlocking(false);
    }
  }

  const refreshSafe = () => reload({ showSpinner: true }).catch((err) => setFlashError(getErrorMessage(err)));
  const boardBrief = taskboard?.boardBrief || {};
  const showLoadingShell = (!taskboard && !needsUnlock) || unlockRefreshing;


  // --- Skeleton loading logic ---
  if (showLoadingShell) {
    return html`
      <main className="app-shell">
        <${Header}
          productName="Kanboard"
          health=${health}
          activeView=${activeView}
          onViewChange=${navigateTo}
          onRefresh=${refreshSafe}
          refreshing=${refreshing}
          onToggleAgents=${() => setAgentsOpen((v) => !v)}
          agentsOpen=${agentsOpen}
          agentCount=${agentCount}
          currentUser=${currentUser}
        />
        ${activeView === "board" ? html`<${SkeletonBoard} />` : null}
        ${activeView === "backlog" ? html`<${SkeletonBacklog} />` : null}
        ${activeView === "brief" ? html`<${SkeletonBrief} />` : null}
        <${SkeletonAgentsPane} open=${agentsOpen} />
      </main>
    `;
  }

  return html`
    <main className="app-shell">
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      ${flashError ? html`
        <div className="flash-error" role="alert">
          <span className="flash-error-text">${flashError}</span>
          <button className="flash-error-close" type="button" aria-label="Dismiss" onClick=${() => setFlashError(null)}>✕</button>
        </div>
      ` : null}

      <${Header}
        productName=${boardBrief.productName || "Kanboard"}
        health=${health}
        activeView=${activeView}
        onViewChange=${navigateTo}
        onRefresh=${refreshSafe}
        refreshing=${refreshing}
        onToggleAgents=${() => setAgentsOpen((v) => !v)}
        agentsOpen=${agentsOpen}
        agentCount=${agentCount}
        currentUser=${currentUser}
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
          usersMap=${usersMap}
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
          submitting=${pendingOp}
          submitError=${modalError}
          taskboard=${taskboard}
          activeFilters=${filters}
          lookup=${lookup}
          onSwitchModal=${pushModal}
          onSaveValues=${saveFrameValues}
          usersMap=${usersMap}
        />
      ` : null}

      ${confirmState ? html`
        <div className="modal-backdrop" role="presentation" onClick=${() => !pendingOp && dismissConfirm(false)}>
          <div className="modal-shell modal-shell--sm" role="alertdialog" aria-modal="true" onClick=${(e) => e.stopPropagation()}>
            <p className="confirm-message">${confirmState.message}</p>
            <div className="form-footer">
              <button className="button button-ghost" type="button" disabled=${pendingOp} onClick=${() => dismissConfirm(false)}>Cancel</button>
              <button className=${`button button-danger${pendingOp ? " button--loading" : ""}`} type="button" disabled=${pendingOp} onClick=${() => dismissConfirm(true)}>${pendingOp ? "Deleting" : "Delete"}</button>
            </div>
          </div>
        </div>
      ` : null}


      ${needsUnlock ? html`
        <div className="modal-backdrop" role="presentation">
          <div className="modal-shell modal-shell--sm unlock-shell" role="dialog" aria-modal="true" aria-label="Unlock identity">
            <div className="modal-header">
              <h2>Unlock Identity</h2>
            </div>
            <form
              className="form-grid"
              onSubmit=${(e) => {
                e.preventDefault();
                if (!unlocking) unlockIdentity(unlockPassword);
              }}
              autoComplete="off"
            >
              <label>
                Password
                <input
                  type="password"
                  value=${unlockPassword}
                  onInput=${(e) => setUnlockPassword(e.currentTarget.value)}
                  autoFocus
                  required
                  disabled=${unlocking}
                />
              </label>
              ${unlockError ? html`<div className="unlock-error">${unlockError}</div>` : null}
              <div className="form-footer">
                <button className=${`button button-solid${unlocking ? " button--loading" : ""}`} type="submit" disabled=${unlocking}>
                  ${unlocking ? "Unlocking" : "Unlock"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ` : null}

      <${AgentsPane}
        open=${agentsOpen}
        onClose=${() => setAgentsOpen(false)}
        health=${health}
        agents=${agents}
      />
    </main>
  `;
}
