import React, { useRef, useState, useEffect } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, allowedPriorities, statusLabels, formatDate, makeOptions, formatRelativeTime } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";
import { MetaChip } from "./BoardView.js";
import { request } from "./api.js";

const html = htm.bind(React.createElement);

// ---- @mention system ----

function useMentions(users) {
  const [state, setState] = useState(null);
  // state: { query, rect, el, mentionStart, setControlled }

  function detect(el, setControlled) {
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");

    if (atIdx === -1) { setState(null); return; }

    const afterAt = before.slice(atIdx + 1);
    if (afterAt.includes(" ") || afterAt.includes("\n")) { setState(null); return; }

    setState({ query: afterAt, rect: el.getBoundingClientRect(), el, mentionStart: atIdx, setControlled: setControlled ?? null });
  }

  function handleInput(e, setControlled) {
    const el = e.target;
    if (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") return;
    detect(el, setControlled ?? null);
  }

  function selectUser(user) {
    if (!state) return;
    const { el, mentionStart, setControlled } = state;
    const cursor = el.selectionStart ?? el.value.length;
    const newVal = el.value.slice(0, mentionStart) + "@" + user.name + " " + el.value.slice(cursor);

    if (setControlled) {
      setControlled(newVal);
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, newVal);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const newCursor = mentionStart + user.name.length + 2;
    requestAnimationFrame(() => { el.setSelectionRange(newCursor, newCursor); el.focus(); });
    setState(null);
  }

  const filtered = state
    ? users.filter((u) => !state.query || u.name.toLowerCase().startsWith(state.query.toLowerCase())).slice(0, 7)
    : [];

  return { mentionState: state, filtered, handleInput, selectUser, closeMention: () => setState(null) };
}

function MentionMenu({ mentionState, filtered, onSelect, onClose }) {
  if (!mentionState || filtered.length === 0) return null;

  const { rect } = mentionState;
  const style = { top: rect.bottom + 6, left: rect.left };

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`
    <div className="mention-menu" style=${style} role="listbox" aria-label="Mention a team member">
      ${filtered.map((u) => html`
        <button
          key=${u.id}
          className="mention-menu-item"
          type="button"
          role="option"
          onMouseDown=${(e) => { e.preventDefault(); onSelect(u); }}
        >
          <span className="mention-menu-avatar" style=${{ background: u.avatarColor || "var(--accent)" }}>${u.name[0].toUpperCase()}</span>
          <span className="mention-menu-name">${u.name}</span>
          ${u.role ? html`<span className="mention-menu-role">${u.role}</span>` : null}
        </button>
      `)}
    </div>
  `;
}

// ---- Form body builder ----

function buildModalBody(modal, taskboard, activeFilters, lookup, onSwitchModal, usersMap) {
  const epics = taskboard?.epics || [];
  const allFeatures = epics.flatMap((epic) => epic.features);
  const allStories = allFeatures.flatMap((feature) => feature.userStories);
  const userOptions = Object.values(usersMap || {})
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((user) => ({ value: user.id, label: user.name }));

  if (modal.type === "board-brief") {
    const b = modal.entity || {};
    return html`
      <label>Product name<input name="productName" defaultValue=${b.productName || ""} required /></label>
      <label>Objective<textarea name="objective" rows="4" defaultValue=${b.objective || ""}></textarea></label>
      <label>Scope definition<textarea name="scopeDefinition" rows="4" defaultValue=${b.scopeDefinition || ""}></textarea></label>
      <label>Non-goals<textarea name="nonGoals" rows="3" defaultValue=${b.nonGoals || ""}></textarea></label>
      <label>Success criteria<textarea name="successCriteria" rows="3" defaultValue=${b.successCriteria || ""}></textarea></label>
      <label>Current focus<textarea name="currentFocus" rows="3" defaultValue=${b.currentFocus || ""}></textarea></label>
      <label>Implementation notes<textarea name="implementationNotes" rows="6" defaultValue=${b.implementationNotes || ""}></textarea></label>
    `;
  }

  if (modal.type === "create-epic" || modal.type === "edit-epic") {
    const e = modal.entity || {};
    const sv = modal.savedValues || {};
    return html`
      ${e.id ? html`<input type="hidden" name="id" value=${e.id} />` : null}
      <label>Title<input name="title" defaultValue=${sv.title ?? e.title ?? ""} required /></label>
      <label>Summary<textarea name="summary" rows="4" defaultValue=${sv.summary ?? e.summary ?? ""}></textarea></label>
      <div className="form-row">
        <label>Status
          <select name="status" defaultValue=${sv.status || e.status || "pending"}>
            ${allowedStatuses.map((s) => html`<option key=${s} value=${s}>${statusLabels[s]}</option>`)}
          </select>
        </label>
        <label>Priority
          <select name="priority" defaultValue=${sv.priority || e.priority || "medium"}>
            ${allowedPriorities.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </label>
      </div>
    `;
  }

  if (modal.type === "create-feature" || modal.type === "edit-feature") {
    const f = modal.entity || {};
    const sv = modal.savedValues || {};
    const preselectEpic = sv.epicId ?? f.epicId ?? modal.parentId ?? "";
    return html`
      ${f.id ? html`<input type="hidden" name="id" value=${f.id} />` : null}
      <label>Epic
        <${CustomSelect}
          name="epicId"
          defaultValue=${preselectEpic}
          options=${makeOptions(epics, preselectEpic)}
          placeholder="Select epic..."
          actionItem=${{ label: "New Epic", onAction: () => onSwitchModal("create-epic", "Create Epic") }}
        />
      </label>
      <label>Title<input name="title" defaultValue=${sv.title ?? f.title ?? ""} required /></label>
      <label>Summary<textarea name="summary" rows="4" defaultValue=${sv.summary ?? f.summary ?? ""}></textarea></label>
      <div className="form-row">
        <label>Status
          <select name="status" defaultValue=${sv.status || f.status || "pending"}>
            ${allowedStatuses.map((s) => html`<option key=${s} value=${s}>${statusLabels[s]}</option>`)}
          </select>
        </label>
        <label>Priority
          <select name="priority" defaultValue=${sv.priority || f.priority || "medium"}>
            ${allowedPriorities.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </label>
      </div>
    `;
  }

  if (modal.type === "create-story" || modal.type === "edit-story") {
    const s = modal.entity || {};
    const sv = modal.savedValues || {};
    const selectedFeature = sv.featureId ?? s.featureId ?? modal.parentId ?? "";
    return html`
      ${s.id ? html`<input type="hidden" name="id" value=${s.id} />` : null}
      <label>Feature
        <${CustomSelect}
          name="featureId"
          defaultValue=${selectedFeature}
          options=${makeOptions(allFeatures, selectedFeature)}
          placeholder="Select feature..."
          actionItem=${{ label: "New Feature", onAction: () => onSwitchModal("create-feature", "Create Feature") }}
        />
      </label>
      <label>Title<input name="title" defaultValue=${sv.title ?? s.title ?? ""} required /></label>
      <label>Summary<textarea name="summary" rows="4" defaultValue=${sv.summary ?? s.summary ?? ""}></textarea></label>
      <label>Acceptance criteria (one per line)
        <textarea name="acceptanceCriteria" rows="5" defaultValue=${sv.acceptanceCriteria ?? (s.acceptanceCriteria || []).join("\n")}></textarea>
      </label>
      <div className="form-row">
        <label>Status
          <select name="status" defaultValue=${sv.status || s.status || "pending"}>
            ${allowedStatuses.map((st) => html`<option key=${st} value=${st}>${statusLabels[st]}</option>`)}
          </select>
        </label>
        <label>Priority
          <select name="priority" defaultValue=${sv.priority || s.priority || "medium"}>
            ${allowedPriorities.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </label>
      </div>
    `;
  }

  if (modal.type === "create-task" || modal.type === "edit-task") {
    const t = modal.entity || {};
    const sv = modal.savedValues || {};
    const selectedStory = sv.storyId ?? t.storyId ?? modal.parentId ?? "";
    const context = t.id ? lookup.getTaskContext(t.id) : null;
    return html`
      ${t.id ? html`<input type="hidden" name="id" value=${t.id} />` : null}
      <label>Story
        <${CustomSelect}
          name="storyId"
          defaultValue=${selectedStory}
          options=${makeOptions(allStories, selectedStory)}
          placeholder="Select story..."
          actionItem=${{ label: "New Story", onAction: () => onSwitchModal("create-story", "Create Story") }}
        />
      </label>
      <label>Title<input name="title" defaultValue=${sv.title ?? t.title ?? ""} required /></label>
      <label>Summary<textarea name="summary" rows="4" defaultValue=${sv.summary ?? t.summary ?? ""}></textarea></label>
      <label>Implementation notes<textarea name="implementationNotes" rows="4" defaultValue=${sv.implementationNotes ?? t.implementationNotes ?? ""}></textarea></label>
      <div className="form-row">
        <label>Estimate<input name="estimate" defaultValue=${sv.estimate ?? t.estimate ?? ""} /></label>
        <label>Tags (comma-separated)<input name="tags" defaultValue=${sv.tags ?? (t.tags || []).join(", ")} /></label>
      </div>
      <label>Assigned to
        <${CustomSelect}
          name="assignedTo"
          defaultValue=${sv.assignedTo ?? t.assignedTo ?? ""}
          options=${[{ value: "", label: "Unassigned" }, ...userOptions]}
          placeholder="Unassigned"
        />
      </label>
      <div className="form-row">
        <label>Status
          <select name="status" defaultValue=${sv.status || t.status || "pending"}>
            ${allowedStatuses.map((st) => html`<option key=${st} value=${st}>${statusLabels[st]}</option>`)}
          </select>
        </label>
        <label>Priority
          <select name="priority" defaultValue=${sv.priority || t.priority || "medium"}>
            ${allowedPriorities.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </label>
      </div>
      ${context
        ? html`<div className="inline-note">${context.epic.title} / ${context.feature.title} / ${context.story.title}</div>`
        : null}
    `;
  }

  return html`<div className="inline-note">No form available.</div>`;
}

// ---- Comments pane ----

function resolveAuthor(author, usersMap) {
  if (!author) return "Unknown";
  // author may be a user ID — look it up first
  if (usersMap?.[author]) return usersMap[author].name;
  return author;
}

function commentInitial(displayName) {
  return (displayName || "?")[0].toUpperCase();
}

function CommentsPane({ taskId, comments, currentUser, usersMap, onMentionInput, onCommentDeleted, onClose }) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [pending, setPending] = useState([]);
  const [deletingIds, setDeletingIds] = useState(new Set());
  const [removedIds, setRemovedIds] = useState(new Set());
  const [confirmingId, setConfirmingId] = useState(null);
  const listEndRef = useRef(null);

  const confirmedIds = new Set((comments || []).map((c) => c.id));
  const merged = [...(comments || []), ...pending.filter((p) => !confirmedIds.has(p.id))]
    .filter((c) => !removedIds.has(c.id));

  async function deleteComment(commentId) {
    if (!commentId || commentId.startsWith("temp_")) return;
    if (confirmingId !== commentId) {
      setConfirmingId(commentId);
      return;
    }
    setConfirmingId(null);
    setDeletingIds((s) => new Set([...s, commentId]));
    try {
      await request(`/api/comments/${commentId}`, { method: "DELETE", body: JSON.stringify({}) });
      setRemovedIds((s) => new Set([...s, commentId]));
      onCommentDeleted?.();
    } catch {
      setDeletingIds((s) => {
        const next = new Set(s);
        next.delete(commentId);
        return next;
      });
    }
  }

  function scrollToEnd() {
    setTimeout(() => listEndRef.current?.scrollIntoView({ behavior: "smooth" }), 40);
  }

  async function submit(e) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || !taskId || posting) return;
    setPosting(true);

    const tempId = "temp_" + Date.now();
    setPending((p) => [...p, {
      id: tempId,
      author: currentUser?.name || "You",
      kind: "note",
      body: trimmed,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);
    setBody("");
    scrollToEnd();

    try {
      const result = await request("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          nodeType: "task",
          nodeId: taskId,
          author: currentUser?.name || "Unknown",
          kind: "note",
          body: trimmed
        })
      });
      setPending((p) => p.map((c) => (c.id === tempId ? result : c)));
    } catch {
      setPending((p) => p.filter((c) => c.id !== tempId));
    } finally {
      setPosting(false);
    }
  }

  return html`
    <div className="comments-pane" onClick=${(e) => e.stopPropagation()}>
      <div className="comments-pane-header">
        <span className="comments-pane-title">Comments</span>
        ${merged.length > 0 ? html`<span className="comments-count-pill">${merged.length}</span>` : null}
        ${onClose ? html`<button className="comment-pane-close" type="button" aria-label="Close comments" onClick=${onClose}>✕</button>` : null}
      </div>
      <div className="comments-list">
        ${merged.length === 0
          ? html`<p className="comments-empty">No comments yet.</p>`
          : merged.map((c) => {
              const displayName = resolveAuthor(c.author, usersMap);
              const isPending = c.id?.startsWith?.("temp_");
              const isDeleting = deletingIds.has(c.id);
              const isConfirming = confirmingId === c.id;
              return html`
                <div key=${c.id} className=${`comment-bubble${isDeleting ? " comment-bubble--deleting" : ""}`}>
                  <div className="comment-bubble-meta">
                    <span className="comment-avatar">${commentInitial(displayName)}</span>
                    <span className="comment-author">${displayName}</span>
                    ${c.kind && c.kind !== "note" ? html`<span className=${`comment-kind comment-kind--${c.kind}`}>${c.kind}</span>` : null}
                    ${!isPending ? html`
                      <button
                        className=${`comment-delete-btn${isConfirming ? " comment-delete-btn--confirming" : ""}`}
                        type="button"
                        title=${isConfirming ? "Click again to confirm delete" : "Delete comment"}
                        aria-label="Delete comment"
                        disabled=${isDeleting}
                        onClick=${() => deleteComment(c.id)}
                        onBlur=${() => { if (confirmingId === c.id) setConfirmingId(null); }}
                      >${isConfirming ? "Sure?" : "✕"}</button>
                    ` : null}
                  </div>
                  <p className="comment-body">${c.body}</p>
                  <div className="comment-bubble-foot">
                    <span className="comment-time">${formatRelativeTime(c.createdAt) || "just now"}</span>
                  </div>
                </div>
              `;
            })}
        <div ref=${listEndRef} />
      </div>
      <form className="comments-composer" onSubmit=${submit}>
        <textarea
          className="comments-textarea"
          rows="3"
          placeholder="Add a comment… (⌘↵ to post)"
          value=${body}
          onInput=${(e) => { setBody(e.currentTarget.value); onMentionInput(e, setBody); }}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        ></textarea>
        <button
          className=${`button button-solid${posting ? " button--loading" : ""}`}
          type="submit"
          disabled=${!body.trim() || posting}
        >${posting ? "Posting…" : "Post"}</button>
      </form>
    </div>
  `;
}

// ---- FormModal ----

export function FormModal({ modal, stackDepth = 1, onClose, onCloseAll, onSubmit, submitting = false, submitError = null, taskboard, activeFilters, lookup, onSwitchModal, onSaveValues, usersMap, currentUser, onReadNode, onReload }) {
  const formRef = useRef(null);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const isEditTaskModal = Boolean(modal?.type === "edit-task" && modal?.entity?.id);
  const taskModalId = isEditTaskModal ? modal.entity.id : undefined;

  useEffect(() => {
    if (commentsOpen && taskModalId && onReadNode) onReadNode(taskModalId);
  }, [commentsOpen, taskModalId]);

  const users = Object.values(usersMap || {}).sort((a, b) => a.name.localeCompare(b.name));
  const { mentionState, filtered, handleInput, selectUser, closeMention } = useMentions(users);

  if (!modal) return null;

  function handleSwitchModal(type, title) {
    let values = null;

    if (onSaveValues && formRef.current) {
      const fd = new FormData(formRef.current);
      values = {};
      for (const [k, v] of fd.entries()) values[k] = v;
      onSaveValues(values);
    }

    let parentId = "";

    if (type === "create-feature") {
      const selectedFeatureId = values?.featureId;
      parentId = selectedFeatureId ? (lookup.findFeature(selectedFeatureId)?.epicId || "") : "";
    }

    if (type === "create-story") {
      const selectedStoryId = values?.storyId;
      parentId = selectedStoryId ? (lookup.findStory(selectedStoryId)?.featureId || "") : "";
    }

    onSwitchModal(type, title, null, parentId);
  }

  const body = buildModalBody(modal, taskboard, activeFilters, lookup, handleSwitchModal, usersMap);
  const modalEntity = modal.entity || null;
  const showEditMeta = Boolean(
    modalEntity?.updatedAt &&
    (modal.type === "board-brief" || modal.type.startsWith("edit-"))
  );

  const isEditTask = modal.type === "edit-task";
  const liveTask = isEditTask && modalEntity?.id ? (lookup.findTask(modalEntity.id) || modalEntity) : modalEntity;
  const commentCount = liveTask?.comments?.length || 0;

  return html`
    <div className="modal-backdrop" role="presentation" onClick=${onCloseAll}>
      <div className="modal-stage">
        <div className="modal-shell" role="dialog" aria-modal="true" onClick=${(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>${modal.title}</h2>
            ${isEditTask ? html`
              <button
                className=${`button button-ghost comments-toggle-btn${commentsOpen ? " comments-toggle-btn--active" : ""}`}
                type="button"
                onClick=${() => setCommentsOpen((o) => !o)}
                title="Toggle comments"
              >
                Comments${commentCount > 0 ? html`<span className="comments-header-badge">${commentCount}</span>` : null}
              </button>
            ` : null}
            <button className="button button-ghost" onClick=${onCloseAll} aria-label="Close" type="button">✕</button>
          </div>
          <form
            ref=${formRef}
            className="form-grid"
            onInput=${(e) => handleInput(e, null)}
            onSubmit=${(e) => {
              e.preventDefault();
              onSubmit(modal.type, new FormData(e.currentTarget));
            }}
          >
            ${body}
            <div className="form-footer">
              ${showEditMeta ? html`<${MetaChip} updatedBy=${modalEntity.updatedBy} updatedAt=${modalEntity.updatedAt} updatedVia=${modalEntity.updatedVia} usersMap=${usersMap} />` : null}
              <button className="button button-ghost" type="button" disabled=${submitting} onClick=${onClose}>${stackDepth > 1 ? "← Back" : "Cancel"}</button>
              <button className=${`button button-solid${submitting ? " button--loading" : ""}`} type="submit" disabled=${submitting}>${submitting ? "Saving" : "Save"}</button>
            </div>
            ${submitError ? html`<div className="form-error" role="alert">${submitError}</div>` : null}
          </form>
        </div>
        ${commentsOpen && liveTask ? html`
          <${CommentsPane}
            taskId=${liveTask.id}
            comments=${liveTask.comments || []}
            currentUser=${currentUser}
            usersMap=${usersMap}
            onMentionInput=${handleInput}
            onCommentDeleted=${onReload}
            onClose=${() => setCommentsOpen(false)}
          />
        ` : null}
      </div>
      <${MentionMenu}
        mentionState=${mentionState}
        filtered=${filtered}
        onSelect=${selectUser}
        onClose=${closeMention}
      />
    </div>
  `;
}
