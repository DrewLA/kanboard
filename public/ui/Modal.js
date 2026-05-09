import React, { useRef } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, allowedPriorities, statusLabels, formatDate, makeOptions } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";

const html = htm.bind(React.createElement);

function buildModalBody(modal, taskboard, activeFilters, lookup, onSwitchModal) {
  const epics = taskboard?.epics || [];
  const allFeatures = epics.flatMap((epic) => epic.features);
  const allStories = allFeatures.flatMap((feature) => feature.userStories);

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
      ${b.updatedAt ? html`<div className="inline-note">Updated ${formatDate(b.updatedAt)}</div>` : null}
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

export function FormModal({ modal, stackDepth = 1, onClose, onCloseAll, onSubmit, taskboard, activeFilters, lookup, onSwitchModal, onSaveValues }) {
  const formRef = useRef(null);

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

  const body = buildModalBody(modal, taskboard, activeFilters, lookup, handleSwitchModal);

  return html`
    <div className="modal-backdrop" role="presentation" onClick=${onCloseAll}>
      <div className="modal-shell" role="dialog" aria-modal="true" onClick=${(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>${modal.title}</h2>
          <button className="button button-ghost" onClick=${onCloseAll} aria-label="Close" type="button">✕</button>
        </div>
        <form
          ref=${formRef}
          className="form-grid"
          onSubmit=${(e) => {
            e.preventDefault();
            onSubmit(modal.type, new FormData(e.currentTarget));
          }}
        >
          ${body}
          <div className="form-footer">
            <button className="button button-ghost" type="button" onClick=${onClose}>${stackDepth > 1 ? "← Back" : "Cancel"}</button>
            <button className="button button-solid" type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>
  `;
}
