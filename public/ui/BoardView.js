import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, statusLabels, getTaskContexts, priorityClass, formatDate, formatRelativeTime } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";
import { request, getErrorMessage } from "./api.js";
import {
  attachmentKindLabel,
  buildAttachmentContentUrl,
  formatBytes,
  isVisualAttachment,
  uploadFileToPresignedUrl,
  validateUploadSelection,
  workItemCollection as sourceApiPath,
} from "./attachments.js";

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
    ...(task.attachments || []).flatMap((attachment) => [
      attachment.name,
      attachment.kind,
      attachment.contentType,
      attachment.uploadedBy,
    ]),
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

function matchesTerms(value, terms) {
  const haystack = String(value || "").toLowerCase();
  return !terms.length || terms.every((term) => haystack.includes(term));
}

function buildFeatureHaystack(epic, feature) {
  return [
    feature.title,
    feature.summary,
    feature.alias,
    feature.priority,
    feature.status,
    statusLabels[feature.status],
    ...(feature.attachments || []).flatMap((attachment) => [
      attachment.name,
      attachment.kind,
      attachment.contentType,
      attachment.uploadedBy,
    ]),
    epic.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sourceTypeLabel(sourceType) {
  if (sourceType === "epic") return "Epic";
  if (sourceType === "feature") return "Feature";
  return "Task";
}

function canRenderAsImage(attachment) {
  return attachment?.kind === "image" || attachment?.contentType === "image/png" || attachment?.contentType === "image/svg+xml";
}

function uploadedByLabel(attachment, usersMap) {
  const uploadedBy = attachment?.uploadedBy;
  if (!uploadedBy) return "";
  return usersMap?.[uploadedBy]?.name || uploadedBy;
}

function BoardAttachmentGlyph({ kind, size = 16 }) {
  if (kind === "mockup") {
    return html`
      <svg width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <rect x="2" y="2.5" width="12" height="11" rx="2.5" stroke="currentColor" stroke-width="1.3"></rect>
        <path d="M5 5.5h6M5 8h4M5 10.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>
      </svg>
    `;
  }

  if (kind === "image") {
    return html`
      <svg width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <rect x="2" y="2.5" width="12" height="11" rx="2.5" stroke="currentColor" stroke-width="1.3"></rect>
        <circle cx="6" cy="6" r="1.2" fill="currentColor"></circle>
        <path d="M4 11l2.4-2.6a1 1 0 0 1 1.46 0L9.6 10l1.05-1.16a1 1 0 0 1 1.47.02L13 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  return html`
    <svg width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M5 2.5h4.8L13 5.7V12a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 12V4a1.5 1.5 0 0 1 1-1.42Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>
      <path d="M9.5 2.5V5.5H12.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>
    </svg>
  `;
}

function BoardAttachmentViewer({ record, onClose }) {
  const attachment = record?.attachment;
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const contentUrl = record
    ? buildAttachmentContentUrl(record.sourceType, record.sourceId, attachment.id)
    : "";
  const renderAsImage = attachment ? canRenderAsImage(attachment) : false;

  useEffect(() => {
    if (!record) return undefined;
    function onKey(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [record, onClose]);

  useEffect(() => {
    setPreviewLoaded(false);
  }, [contentUrl]);

  if (!record || !attachment) return null;

  return html`
    <div className="board-viewer-backdrop" role="presentation" onClick=${onClose}>
      <div className="board-viewer-shell glass-panel" role="dialog" aria-modal="true" aria-label=${attachment.name} onClick=${(e) => e.stopPropagation()}>
        <div className="board-viewer-toolbar">
          <div className="board-viewer-copy">
            <span className="board-viewer-kicker">${sourceTypeLabel(record.sourceType)} / ${record.sourceTitle}</span>
            <h3>${attachment.name}</h3>
            <p>
              ${attachmentKindLabel(attachment.kind)}
              ${formatBytes(attachment.size) ? ` • ${formatBytes(attachment.size)}` : ""}
            </p>
          </div>
          <div className="board-viewer-actions">
            <button
              className="button button-solid"
              type="button"
              onClick=${() => window.open(buildAttachmentContentUrl(record.sourceType, record.sourceId, attachment.id, attachment.kind === "file"), "_blank", "noopener,noreferrer")}
            >Open in tab</button>
            <button className="button button-ghost" type="button" onClick=${onClose} aria-label="Close viewer">✕</button>
          </div>
        </div>
        ${renderAsImage
          ? html`
              <div className="board-viewer-stage board-viewer-stage--image">
                <img
                  className=${`board-viewer-media${previewLoaded ? " is-ready" : ""}`}
                  src=${contentUrl}
                  alt=${attachment.name}
                  onLoad=${() => setPreviewLoaded(true)}
                  onError=${() => setPreviewLoaded(true)}
                />
                ${!previewLoaded ? html`
                  <div className="board-viewer-skeleton board-viewer-skeleton--image" aria-hidden="true">
                    <div className="bvs-frame">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                        <rect x="4" y="8" width="40" height="32" rx="5" stroke="currentColor" stroke-width="2"/>
                        <circle cx="16" cy="20" r="4" stroke="currentColor" stroke-width="2"/>
                        <path d="M4 34l10-10a3 3 0 0 1 4.2 0L26 32l6-6a3 3 0 0 1 4.2 0L44 34" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </div>
                  </div>
                ` : null}
              </div>
            `
          : html`
              <div className="board-viewer-stage board-viewer-stage--mockup">
                <iframe
                  className=${`board-viewer-media${previewLoaded ? " is-ready" : ""}`}
                  title=${attachment.name}
                  src=${contentUrl}
                  sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
                  onLoad=${() => setPreviewLoaded(true)}
                  onError=${() => setPreviewLoaded(true)}
                ></iframe>
                ${!previewLoaded ? html`
                  <div className="board-viewer-skeleton board-viewer-skeleton--mockup" aria-hidden="true">
                    <div className="bvs-browser">
                      <div className="bvs-chrome">
                        <div className="bvs-dots">
                          <div className="bvs-dot"></div>
                          <div className="bvs-dot"></div>
                          <div className="bvs-dot"></div>
                        </div>
                        <div className="bvs-bar"></div>
                      </div>
                      <div className="bvs-body">
                        <div className="bvs-block"></div>
                        <div className="bvs-line" style=${{ width: "72%" }}></div>
                        <div class="bvs-line" style=${{ width: "55%" }}></div>
                        <div class="bvs-line" style=${{ width: "88%" }}></div>
                        <div class="bvs-line" style=${{ width: "40%" }}></div>
                      </div>
                    </div>
                  </div>
                ` : null}
              </div>
            `}
      </div>
    </div>
  `;
}

function BoardAttachmentPanel({
  records,
  targets,
  selectedTarget,
  onTargetChange,
  uploadBusy,
  uploadState,
  uploadError,
  clearUploadError,
  getButtonState,
  openPicker,
  inputProps,
  onOpenViewer,
  onOpenSource,
  onDelete,
  removingKey,
  confirmingDeleteKey,
  onCancelDelete,
  usersMap,
}) {
  const uploadItems = [
    { kind: "mockup", label: "Attach mockup" },
    { kind: "image", label: "Attach image" },
    { kind: "file", label: "Attach file" },
  ];

  return html`
    <section className="board-attachments-panel glass-panel">
      <div className="board-attach-controls">
        <label className="board-attach-target">
          <span>Attach to</span>
          <${CustomSelect}
            value=${selectedTarget}
            onChange=${onTargetChange}
            options=${targets}
            placeholder="Select epic, feature, or task..."
          />
        </label>
        <div className="task-attach-toolbar" role="group" aria-label="Add attachment">
          ${uploadItems.map((item) => {
            const state = getButtonState(item.kind);
            return html`
              <div key=${item.kind} className="task-attach-tip" data-tooltip=${item.label}>
                <button
                  className=${`task-attach-icon${state ? ` task-attach-icon--${state}` : ""}`}
                  type="button"
                  aria-label=${item.label}
                  disabled=${uploadBusy || !selectedTarget}
                  onClick=${() => openPicker(item.kind)}
                >
                  <${BoardAttachmentGlyph} kind=${item.kind} size=${16} />
                  <svg className="task-attach-border" viewBox="0 0 34 34" aria-hidden="true">
                    <rect className="task-attach-border-segment" x="1.5" y="1.5" width="31" height="31" rx="10.5" pathLength="100"></rect>
                  </svg>
                </button>
              </div>
            `;
          })}
        </div>
      </div>

      <input ...${inputProps("image")} />
      <input ...${inputProps("mockup")} />
      <input ...${inputProps("file")} />

      ${uploadState ? html`
        <div className="task-attachment-progress" role="status" aria-live="polite">
          <div className="task-attachment-progress-copy">
            <strong>${uploadState.stage}</strong>
            <span>${uploadState.fileName}</span>
          </div>
          <span className="task-attachment-progress-value">${uploadState.progress}%</span>
          <div className="task-attachment-progress-track">
            <span style=${{ width: `${uploadState.progress}%` }}></span>
          </div>
        </div>
      ` : null}

      ${uploadError ? html`
        <div className="form-error task-attachment-error" role="alert">
          <span className="task-attachment-error-text">${uploadError}</span>
          <button className="task-attachment-error-dismiss" type="button" aria-label="Dismiss attachment error" onClick=${clearUploadError}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
              <path d="M2 2 10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
              <path d="M10 2 2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
            </svg>
          </button>
        </div>
      ` : null}

      ${records.length
        ? html`
            <div className="board-attachments-grid">
              ${records.map((record) => {
                const attachment = record.attachment;
                const uploadedBy = uploadedByLabel(attachment, usersMap);
                const removing = removingKey === record.key;
                const confirming = confirmingDeleteKey === record.key;
                return html`
                  <article key=${record.key} className="board-attachment-card">
                    <div className="board-attachment-badge"><${BoardAttachmentGlyph} kind=${attachment.kind} size=${18} /></div>
                    <div className="board-attachment-copy">
                      <strong>${attachment.name}</strong>
                      <span>
                        ${attachmentKindLabel(attachment.kind)}
                        ${formatBytes(attachment.size) ? ` • ${formatBytes(attachment.size)}` : ""}
                        ${" • "}${formatRelativeTime(attachment.createdAt) || formatDate(attachment.createdAt) || "just now"}
                      </span>
                      <button className="board-attachment-origin" type="button" onClick=${() => onOpenSource(record)} title="Open source">
                        ${sourceTypeLabel(record.sourceType)} / ${record.sourceTitle}${uploadedBy ? ` • ${uploadedBy}` : ""}
                      </button>
                    </div>
                    <div className="board-attachment-actions">
                      ${isVisualAttachment(attachment)
                        ? html`<button className="button button-ghost btn-sm" type="button" onClick=${() => onOpenViewer(record)}>View</button>`
                        : null}
                      <button
                        className="button button-ghost btn-sm"
                        type="button"
                        onClick=${() => window.open(buildAttachmentContentUrl(record.sourceType, record.sourceId, attachment.id, attachment.kind === "file"), "_blank", "noopener,noreferrer")}
                      >${attachment.kind === "file" ? "Download" : "Open"}</button>
                      <button
                        className=${`button button-ghost btn-sm board-attachment-delete${confirming ? " board-attachment-delete--confirming" : ""}${removing ? " button--loading" : ""}`}
                        type="button"
                        disabled=${Boolean(removingKey)}
                        title=${confirming ? "Click again to confirm delete" : "Delete attachment"}
                        onClick=${() => onDelete(record)}
                        onBlur=${() => { if (confirming) onCancelDelete(); }}
                      >${removing ? "Removing" : confirming ? "Sure?" : "Delete"}</button>
                    </div>
                  </article>
                `;
              })}
            </div>
          `
        : html`<div className="board-attachment-empty">No attachments in the current board filter.</div>`}
    </section>
  `;
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

export function BoardView({ taskboard, filters, onFilterChange, onAddTask, onTaskClick, onMoveTask, onAddEpic, onAddFeature, onFeatureClick, onEpicClick, onReload, usersMap, notifications, currentUserId }) {
  const epics = taskboard?.epics || [];
  const allContexts = useMemo(() => getTaskContexts(taskboard), [taskboard]);
  const imageInputRef = useRef(null);
  const mockupInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [viewerKey, setViewerKey] = useState("");
  const [removingKey, setRemovingKey] = useState("");
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [pendingKind, setPendingKind] = useState("");
  const [uploadState, setUploadState] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [buttonState, setButtonState] = useState(null);

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

  const contextFeatureIds = new Set(contexts.map((ctx) => ctx.feature.id));
  const filteredFeatures = epics.flatMap((epic) =>
    epic.features
      .filter((feature) => {
        if (filters.epicId && epic.id !== filters.epicId) return false;
        if (filters.featureId && feature.id !== filters.featureId) return false;
        if (!terms.length) return true;
        return contextFeatureIds.has(feature.id) || matchesTerms(buildFeatureHaystack(epic, feature), terms);
      })
      .map((feature) => ({ epic, feature }))
  );

  const filteredEpics = epics.filter((epic) => {
    if (filters.epicId && epic.id !== filters.epicId) return false;
    if (!terms.length) return true;
    return matchesTerms([epic.title, epic.summary, epic.alias].filter(Boolean).join(" "), terms);
  });

  // Target picker lists every place an upload can land, grouped Epic → Feature → Task.
  const attachmentTargets = [
    ...filteredEpics.map((epic) => ({
      value: `epic:${epic.id}`,
      label: `Epic / ${epic.title}`,
    })),
    ...filteredFeatures.map(({ epic, feature }) => ({
      value: `feature:${feature.id}`,
      label: `Feature / ${epic.title} / ${feature.title}`,
    })),
    ...contexts.map(({ epic, feature, story, task }) => ({
      value: `task:${task.id}`,
      label: `Task / ${feature.title} / ${task.title}`,
    })),
  ];

  const attachmentRecords = [
    ...filteredEpics.flatMap((epic) =>
      (epic.attachments || []).map((attachment) => ({
        key: `epic:${epic.id}:${attachment.id}`,
        sourceType: "epic",
        sourceId: epic.id,
        sourceTitle: epic.title,
        attachment,
      }))
    ),
    ...filteredFeatures.flatMap(({ epic, feature }) =>
      (feature.attachments || []).map((attachment) => ({
        key: `feature:${feature.id}:${attachment.id}`,
        sourceType: "feature",
        sourceId: feature.id,
        sourceTitle: `${epic.title} / ${feature.title}`,
        attachment,
      }))
    ),
    ...contexts.flatMap(({ feature, task }) =>
      (task.attachments || []).map((attachment) => ({
        key: `task:${task.id}:${attachment.id}`,
        sourceType: "task",
        sourceId: task.id,
        sourceTitle: `${feature.title} / ${task.title}`,
        attachment,
      }))
    ),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.attachment.createdAt || "");
    const rightTime = Date.parse(right.attachment.createdAt || "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  const viewerRecord = attachmentRecords.find((record) => record.key === viewerKey) || null;
  const uploadBusy = Boolean(pendingKind);

  // Drop a stale target selection (e.g. its entity was filtered out), but never
  // auto-pick one — the user must choose explicitly so uploads can't land on a
  // surprise target.
  useEffect(() => {
    if (selectedTarget && !attachmentTargets.some((target) => target.value === selectedTarget)) {
      setSelectedTarget("");
    }
  }, [attachmentTargets, selectedTarget]);

  useEffect(() => {
    if (buttonState?.status !== "success") return undefined;

    const timer = setTimeout(() => {
      setButtonState((current) => current?.status === "success" ? null : current);
      setUploadState((current) => current?.stage === "Done" ? null : current);
    }, 900);

    return () => clearTimeout(timer);
  }, [buttonState]);

  function resetAttachmentInputs() {
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (mockupInputRef.current) mockupInputRef.current.value = "";
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearUploadError() {
    setUploadError("");
    setButtonState((current) => current?.status === "error" ? null : current);
  }

  function parseSelectedTarget() {
    const [sourceType, sourceId] = String(selectedTarget || "").split(":");
    if (!["epic", "feature", "task"].includes(sourceType) || !sourceId) return null;
    return { sourceType, sourceId };
  }

  async function uploadBoardAttachment(kind, file) {
    const target = parseSelectedTarget();
    if (!target) {
      setUploadError("Choose an epic, feature, or task first.");
      setButtonState({ kind, status: "error" });
      resetAttachmentInputs();
      return;
    }

    if (uploadBusy) return;

    const validationMessage = validateUploadSelection(kind, file);
    if (validationMessage) {
      setUploadError(validationMessage);
      setButtonState({ kind, status: "error" });
      setUploadState(null);
      resetAttachmentInputs();
      return;
    }

    const attachmentId = crypto.randomUUID();
    const contentType = file.type || (kind === "image" ? "image/jpeg" : kind === "mockup" ? "text/html" : "application/octet-stream");
    const endpointPath = sourceApiPath(target.sourceType);

    setAttachmentsOpen(true);
    setPendingKind(kind);
    setUploadError("");
    setButtonState({ kind, status: "uploading" });
    setUploadState({ kind, fileName: file.name, stage: "Preparing", progress: 8 });

    try {
      const presigned = await request(`/api/${endpointPath}/${target.sourceId}/upload-url`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          attachmentId,
          fileName: file.name,
          contentType,
          size: file.size,
        }),
      });

      setUploadState({ kind, fileName: file.name, stage: "Uploading", progress: 12 });
      await uploadFileToPresignedUrl(presigned.uploadUrl, file, contentType, (loaded, total) => {
        const nextProgress = total
          ? Math.max(12, Math.min(92, Math.round((loaded / total) * 100)))
          : 60;

        setUploadState((current) => {
          if (!current || current.kind !== kind) return current;
          return { ...current, stage: "Uploading", progress: nextProgress };
        });
      });

      setUploadState({ kind, fileName: file.name, stage: "Finishing", progress: 96 });

      const freshSource = await request(`/api/${endpointPath}/${target.sourceId}`);
      await request(`/api/${endpointPath}/${target.sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          attachments: [
            ...(freshSource.attachments || []),
            {
              id: attachmentId,
              kind,
              name: file.name,
              key: presigned.key,
              contentType,
              size: file.size,
              createdAt: new Date().toISOString(),
              uploadedBy: currentUserId || undefined,
            },
          ],
        }),
      });

      await onReload?.();
      setUploadState({ kind, fileName: file.name, stage: "Done", progress: 100 });
      setButtonState({ kind, status: "success" });
    } catch (uploadErr) {
      setUploadError(getErrorMessage(uploadErr));
      setButtonState({ kind, status: "error" });
      setUploadState(null);
    } finally {
      setPendingKind("");
      resetAttachmentInputs();
    }
  }

  function openPicker(kind) {
    if (uploadBusy) return;
    if (kind === "image") imageInputRef.current?.click();
    else if (kind === "mockup") mockupInputRef.current?.click();
    else if (kind === "file") fileInputRef.current?.click();
  }

  function inputProps(kind) {
    if (kind === "image") {
      return {
        ref: imageInputRef,
        type: "file",
        accept: "image/jpeg,image/png,image/gif,image/webp,image/avif,.jpg,.jpeg,.png,.gif,.webp,.avif",
        hidden: true,
        onChange: (event) => uploadBoardAttachment("image", event.currentTarget.files?.[0]),
      };
    }

    if (kind === "mockup") {
      return {
        ref: mockupInputRef,
        type: "file",
        accept: "text/html,image/svg+xml,image/png,.html,.svg,.png",
        hidden: true,
        onChange: (event) => uploadBoardAttachment("mockup", event.currentTarget.files?.[0]),
      };
    }

    return {
      ref: fileInputRef,
      type: "file",
      hidden: true,
      onChange: (event) => uploadBoardAttachment("file", event.currentTarget.files?.[0]),
    };
  }

  function getButtonState(kind) {
    if (pendingKind === kind) return "uploading";
    return buttonState?.kind === kind ? buttonState.status : "";
  }

  function openAttachmentSource(record) {
    if (!record) return;
    if (record.sourceType === "epic") {
      onEpicClick?.(record.sourceId);
      return;
    }
    if (record.sourceType === "feature") {
      onFeatureClick?.(record.sourceId);
      return;
    }

    onTaskClick(record.sourceId);
  }

  async function deleteAttachment(record) {
    if (!record || removingKey) return;
    // First click arms confirmation; second click within the same armed state deletes.
    if (confirmingDeleteKey !== record.key) {
      setConfirmingDeleteKey(record.key);
      return;
    }
    setConfirmingDeleteKey("");

    const { sourceType, sourceId, attachment } = record;
    const endpointPath = sourceApiPath(sourceType);

    setRemovingKey(record.key);
    setUploadError("");
    try {
      const freshSource = await request(`/api/${endpointPath}/${sourceId}`);
      await request(`/api/${endpointPath}/${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          attachments: (freshSource.attachments || []).filter((entry) => entry.id !== attachment.id),
        }),
      });
      if (viewerKey === record.key) setViewerKey("");
      await onReload?.();
    } catch (deleteErr) {
      setUploadError(getErrorMessage(deleteErr));
    } finally {
      setRemovingKey("");
    }
  }

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
            placeholder="Search tasks and attachments..."
            aria-label="Search tasks and attachments"
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
        <button
          className=${`button button-ghost board-attachments-toggle${attachmentsOpen ? " active" : ""}`}
          type="button"
          aria-expanded=${attachmentsOpen}
          onClick=${() => setAttachmentsOpen((open) => !open)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
            <path d="M6.2 9.8 10.5 5.5a2.1 2.1 0 0 1 3 3l-5.4 5.4a3.5 3.5 0 0 1-5-5L8.4 3.6a2.7 2.7 0 0 1 3.8 0" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
          <span>Attachments</span>
          <span className="pill-count">${attachmentRecords.length}</span>
        </button>
        <button className="button button-solid" onClick=${onAddTask}>+ Task</button>
      </div>

      <div className=${`board-attachments-animate${attachmentsOpen ? " board-attachments-animate--open" : ""}`}>
        <div className="board-attachments-animate-inner">
          <${BoardAttachmentPanel}
            records=${attachmentRecords}
            targets=${attachmentTargets}
            selectedTarget=${selectedTarget}
            onTargetChange=${setSelectedTarget}
            uploadBusy=${uploadBusy}
            uploadState=${uploadState}
            uploadError=${uploadError}
            clearUploadError=${clearUploadError}
            getButtonState=${getButtonState}
            openPicker=${openPicker}
            inputProps=${inputProps}
            onOpenViewer=${(record) => setViewerKey(record.key)}
            onOpenSource=${openAttachmentSource}
            onDelete=${deleteAttachment}
            removingKey=${removingKey}
            confirmingDeleteKey=${confirmingDeleteKey}
            onCancelDelete=${() => setConfirmingDeleteKey("")}
            usersMap=${usersMap}
          />
        </div>
      </div>

      <${BoardAttachmentViewer} record=${viewerRecord} onClose=${() => setViewerKey("")} />

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
