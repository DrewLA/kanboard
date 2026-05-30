import React, { useRef, useState, useEffect } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { allowedStatuses, allowedPriorities, statusLabels, formatDate, makeOptions, formatRelativeTime } from "./utils.js";
import { CustomSelect } from "./CustomSelect.js";
import { MetaChip } from "./BoardView.js";
import { request } from "./api.js";

const html = htm.bind(React.createElement);

// ---- @mention system ----

function makeFieldMentionChecker(userName) {
  if (!userName) return () => false;
  const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}(?=\\s|$|[^\\w])`, "i");
  return (value) => typeof value === "string" && re.test(value);
}

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

// ---- Expandable textarea ----

function ExpandableTextarea({ name, rows, defaultValue, inputRef, markdownPreview = false, previewPlaceholder = "" }) {
  const taRef = useRef(null);
  const previewRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(!markdownPreview);
  const [previewValue, setPreviewValue] = useState(defaultValue || "");

  useEffect(() => {
    setPreviewValue(defaultValue || "");
    setEditing(!markdownPreview);
    if (taRef.current) {
      taRef.current.value = defaultValue || "";
      taRef.current.style.height = "";
      taRef.current.style.overflowY = "";
    }
    setExpanded(false);
  }, [name, defaultValue, markdownPreview]);

  function setRefs(node) {
    taRef.current = node;
    if (!inputRef) return;
    if (typeof inputRef === "function") inputRef(node);
    else inputRef.current = node;
  }

  function getPreviewHeight() {
    const ta = taRef.current;
    const preview = previewRef.current;
    if (!preview || !ta) return ta?.scrollHeight || 0;
    // The preview is anchored top+bottom, so it stretches to the textarea's
    // current height — reading scrollHeight directly would just echo that box.
    // Release the bottom anchor (preview is absolute, so this doesn't change
    // the textarea's height or the overlay's scroll position) to read the
    // markdown's intrinsic height, then restore.
    const saved = preview.style.bottom;
    preview.style.bottom = "auto";
    const height = preview.scrollHeight + 2;
    preview.style.bottom = saved;
    return height;
  }

  useEffect(() => {
    const ta = taRef.current;
    if (!markdownPreview || !ta || !expanded) return;

    if (editing) {
      ta.style.height = ta.scrollHeight + "px";
      ta.style.overflowY = "hidden";
      return;
    }

    ta.style.height = getPreviewHeight() + "px";
    ta.style.overflowY = "hidden";
  }, [markdownPreview, editing, expanded, previewValue]);

  function toggle(e) {
    e.preventDefault();
    const ta = taRef.current;
    if (!ta) return;

    if (!expanded) {
      // Pin current height as start point so browser can interpolate
      const fromH = ta.offsetHeight;
      ta.dataset.collapsedH = String(fromH);
      ta.style.height = fromH + "px";
      void ta.offsetHeight; // force reflow before transition
      ta.style.transition = "height 280ms cubic-bezier(0.4, 0, 0.2, 1)";
      ta.style.height = ((markdownPreview && !editing) ? getPreviewHeight() : ta.scrollHeight) + "px";
      ta.style.overflowY = "hidden"; // lock internal scroll; outer overlay scrolls
      setExpanded(true);
      setTimeout(() => { if (ta) ta.style.transition = ""; }, 290);
    } else {
      const toH = parseInt(ta.dataset.collapsedH || "0", 10);
      ta.style.transition = "height 280ms cubic-bezier(0.4, 0, 0.2, 1)";
      ta.style.height = toH > 0 ? toH + "px" : "";
      ta.style.overflowY = "";
      setExpanded(false);
      // After animation completes, clear explicit height so rows attr takes over
      setTimeout(() => {
        if (ta) { ta.style.transition = ""; ta.style.height = ""; }
      }, 290);
    }
  }

  return html`
    <div className=${`textarea-wrap${markdownPreview ? ` markdown-textarea-wrap ${editing ? "markdown-textarea-wrap--editing" : "markdown-textarea-wrap--preview"}` : ""}`}>
      ${markdownPreview
        ? html`
          <div className="markdown-textarea-preview" aria-hidden="true" ref=${previewRef}>
            <${MarkdownPreview} value=${previewValue} placeholder=${previewPlaceholder} />
          </div>
        `
        : null}
      <textarea
        ref=${setRefs}
        name=${name}
        rows=${rows}
        defaultValue=${defaultValue}
        readOnly=${markdownPreview && !editing}
        className=${markdownPreview ? `markdown-textarea-input ${editing ? "markdown-textarea-input--editing" : "markdown-textarea-input--preview"}` : undefined}
        onFocus=${markdownPreview ? () => setEditing(true) : undefined}
        onBlur=${markdownPreview ? () => setEditing(false) : undefined}
        onInput=${markdownPreview ? (event) => setPreviewValue(event.currentTarget.value) : undefined}
        onClick=${markdownPreview ? (editing ? openLinkAtCaret : undefined) : openLinkAtCaret}
        title=${markdownPreview ? (editing ? "⌘+click a link to open it" : undefined) : "⌘+click a link to open it"}
      ></textarea>
      <button
        type="button"
        className="textarea-expand-btn"
        onClick=${toggle}
        title=${expanded ? "Collapse" : "Expand to fit content"}
      >
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          ${expanded
            ? html`<path d="M1 5L5 1L9 5" />`
            : html`<path d="M1 1L5 5L9 1" />`
          }
        </svg>
      </button>
    </div>
  `;
}

function renderInlineMarkdown(text, keyPrefix = "md") {
  if (typeof text !== "string" || !text) return text || "";

  const parts = [];
  const tokenRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|(https?:\/\/[^\s<>"']+)/g;
  let lastIdx = 0;
  let key = 0;
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));

    if (match[1] && match[2]) {
      parts.push(html`<a key=${`${keyPrefix}-${key++}`} href=${match[2]} target="_blank" rel="noopener noreferrer" className="linkified-link">${match[1]}</a>`);
    } else if (match[3]) {
      parts.push(html`<code key=${`${keyPrefix}-${key++}`}>${match[3]}</code>`);
    } else if (match[4]) {
      parts.push(html`<strong key=${`${keyPrefix}-${key++}`}>${match[4]}</strong>`);
    } else if (match[5]) {
      parts.push(html`<em key=${`${keyPrefix}-${key++}`}>${match[5]}</em>`);
    } else if (match[6]) {
      const url = stripTrailingPunct(match[6]);
      const trailing = match[6].slice(url.length);
      parts.push(html`<a key=${`${keyPrefix}-${key++}`} href=${url} target="_blank" rel="noopener noreferrer" className="linkified-link">${url}</a>`);
      if (trailing) parts.push(trailing);
    }

    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length === 0 ? text : parts;
}

function isMarkdownBlockStart(line) {
  return /^(#{1,3}\s+|[-*+]\s+|\d+\.\s+|>\s?)/.test(line);
}

function renderMarkdownBlocks(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const Tag = `h${heading[1].length}`;
      const blockKey = `block-${blocks.length}`;
      blocks.push(html`<${Tag} key=${blockKey}>${renderInlineMarkdown(heading[2], blockKey)}</${Tag}>`);
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const itemMatch = itemLine.match(/^[-*+]\s+(.*)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      const blockKey = `block-${blocks.length}`;
      blocks.push(html`
        <ul key=${blockKey}>
          ${items.map((item, itemIndex) => html`<li key=${`${blockKey}-${itemIndex}`}>${renderInlineMarkdown(item, `${blockKey}-${itemIndex}`)}</li>`)}
        </ul>
      `);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const itemMatch = itemLine.match(/^\d+\.\s+(.*)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      const blockKey = `block-${blocks.length}`;
      blocks.push(html`
        <ol key=${blockKey}>
          ${items.map((item, itemIndex) => html`<li key=${`${blockKey}-${itemIndex}`}>${renderInlineMarkdown(item, `${blockKey}-${itemIndex}`)}</li>`)}
        </ol>
      `);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const itemMatch = itemLine.match(/^>\s?(.*)$/);
        if (!itemMatch) break;
        quoteLines.push(itemMatch[1]);
        index += 1;
      }
      const quoteText = quoteLines.join(" ").trim();
      const blockKey = `block-${blocks.length}`;
      blocks.push(html`<blockquote key=${blockKey}>${renderInlineMarkdown(quoteText, blockKey)}</blockquote>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line || isMarkdownBlockStart(line)) break;
      paragraph.push(line);
      index += 1;
    }

    if (paragraph.length > 0) {
      const blockKey = `block-${blocks.length}`;
      blocks.push(html`<p key=${blockKey}>${renderInlineMarkdown(paragraph.join(" "), blockKey)}</p>`);
      continue;
    }

    index += 1;
  }

  return blocks;
}

function MarkdownPreview({ value, placeholder = "Click to edit" }) {
  const blocks = renderMarkdownBlocks(value);
  if (blocks.length === 0) {
    return html`<p className="markdown-field-placeholder">${placeholder}</p>`;
  }
  return html`${blocks}`;
}

// ---- Link recognition ----

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunct(url) {
  const m = url.match(TRAILING_PUNCT);
  return m ? url.slice(0, url.length - m[0].length) : url;
}

function linkifyText(text) {
  if (typeof text !== "string" || !text) return text || "";
  const out = [];
  let lastIdx = 0;
  let key = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const raw = m[0];
    const url = stripTrailingPunct(raw);
    if (url.length < raw.length) URL_RE.lastIndex -= raw.length - url.length;
    out.push(html`<a key=${`u${key++}`} href=${url} target="_blank" rel="noopener noreferrer" className="linkified-link" onClick=${(e) => e.stopPropagation()}>${url}</a>`);
    lastIdx = m.index + url.length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out.length === 0 ? text : out;
}

function openLinkAtCaret(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const el = e.currentTarget;
  const text = el.value;
  const pos = el.selectionStart;
  if (typeof pos !== "number" || !text) return;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = stripTrailingPunct(m[0]);
    const start = m.index;
    const end = start + url.length;
    if (pos >= start && pos <= end) {
      e.preventDefault();
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
  }
}

// ---- Form body builder ----

function fieldLabel(text, mentioned) {
  if (!mentioned) return text;
  return html`<span className="form-label-row">${text}<span className="form-field-mention" title="You were mentioned here">@</span></span>`;
}

function buildModalBody(modal, taskboard, activeFilters, lookup, onSwitchModal, usersMap, hasFieldMention) {
  const epics = taskboard?.epics || [];
  const allFeatures = epics.flatMap((epic) => epic.features);
  const allStories = allFeatures.flatMap((feature) => feature.userStories);
  const userOptions = Object.values(usersMap || {})
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((user) => ({ value: user.id, label: user.name }));
  const check = hasFieldMention || (() => false);

  if (modal.type === "board-brief") {
    const b = modal.entity || {};
    return html`
      <label>Product name<input name="productName" defaultValue=${b.productName || ""} required /></label>
      <label>Objective<${ExpandableTextarea} name="objective" rows="4" defaultValue=${b.objective || ""} /></label>
      <label>Scope definition<${ExpandableTextarea} name="scopeDefinition" rows="4" defaultValue=${b.scopeDefinition || ""} /></label>
      <label>Non-goals<${ExpandableTextarea} name="nonGoals" rows="3" defaultValue=${b.nonGoals || ""} /></label>
      <label>Success criteria<${ExpandableTextarea} name="successCriteria" rows="3" defaultValue=${b.successCriteria || ""} /></label>
      <label>Current focus<${ExpandableTextarea} name="currentFocus" rows="3" defaultValue=${b.currentFocus || ""} /></label>
      <label>Implementation notes<${ExpandableTextarea} name="implementationNotes" rows="6" defaultValue=${b.implementationNotes || ""} /></label>
    `;
  }

  if (modal.type === "create-epic" || modal.type === "edit-epic") {
    const e = modal.entity || {};
    const sv = modal.savedValues || {};
    return html`
      ${e.id ? html`<input type="hidden" name="id" value=${e.id} />` : null}
      <label>Title<input name="title" defaultValue=${sv.title ?? e.title ?? ""} required /></label>
      <label>Summary<${ExpandableTextarea} name="summary" rows="4" defaultValue=${sv.summary ?? e.summary ?? ""} /></label>
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
      <label>Summary<${ExpandableTextarea} name="summary" rows="4" defaultValue=${sv.summary ?? f.summary ?? ""} /></label>
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
      <label>Summary<${ExpandableTextarea} name="summary" rows="4" defaultValue=${sv.summary ?? s.summary ?? ""} /></label>
      <label>Acceptance criteria (one per line)
        <${ExpandableTextarea} name="acceptanceCriteria" rows="5" defaultValue=${sv.acceptanceCriteria ?? (s.acceptanceCriteria || []).join("\n")} />
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
      <label>${fieldLabel("Title", check(t.title))}<input name="title" defaultValue=${sv.title ?? t.title ?? ""} required onClick=${openLinkAtCaret} /></label>
      <div className="form-field">
        <span>${fieldLabel("Summary", check(t.summary))}</span>
        <${ExpandableTextarea}
          name="summary"
          rows="4"
          defaultValue=${sv.summary ?? t.summary ?? ""}
          markdownPreview=${modal.type === "edit-task"}
        />
      </div>
      <div className="form-field">
        <span>${fieldLabel("Implementation notes", check(t.implementationNotes))}</span>
        <${ExpandableTextarea}
          name="implementationNotes"
          rows="4"
          defaultValue=${sv.implementationNotes ?? t.implementationNotes ?? ""}
          markdownPreview=${modal.type === "edit-task"}
        />
      </div>
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

function CommentsPane({ taskId, comments, currentUser, usersMap, onMentionInput, onCommentDeleted, onClose, mentionedCommentIds }) {
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
              const isMention = mentionedCommentIds?.has?.(c.id) ?? false;
              return html`
                <div key=${c.id} className=${`comment-bubble${isDeleting ? " comment-bubble--deleting" : ""}${isMention ? " comment-bubble--mention" : ""}`}>
                  ${isMention ? html`<span className="comment-mention-tag" title="You were mentioned here">@</span>` : null}
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
                  <p className="comment-body">${linkifyText(c.body)}</p>
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
          onClick=${openLinkAtCaret}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
          title="⌘+click a link to open it"
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

export function FormModal({ modal, stackDepth = 1, onClose, onCloseAll, onSubmit, submitting = false, submitError = null, taskboard, activeFilters, lookup, onSwitchModal, onSaveValues, usersMap, currentUser, onReadNode, onReload, notifications = [] }) {
  const formRef = useRef(null);
  const shellRef = useRef(null);
  const stageRef = useRef(null);
  const resizingRef = useRef(false);
  const wasDraggingRef = useRef(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shellSize, setShellSize] = useState(null);

  // Layout constants shared between shift calc and resize clamping
  const PANE_W = 340;
  const PANE_GAP = 12;
  const EDGE_PAD = 16;

  const isEditTaskModal = Boolean(modal?.type === "edit-task" && modal?.entity?.id);
  const taskModalId = isEditTaskModal ? modal.entity.id : undefined;

  useEffect(() => { setShellSize(null); }, [modal?.type, modal?.entity?.id]);

  // Dismiss field-type notifications on modal open (user can see field indicators briefly first)
  useEffect(() => {
    if (!taskModalId || !onReadNode) return;
    const t = setTimeout(() => onReadNode(taskModalId, "field"), 2500);
    return () => clearTimeout(t);
  }, [taskModalId]);

  // Dismiss comment-type notifications when comments pane opens
  useEffect(() => {
    if (commentsOpen && taskModalId && onReadNode) onReadNode(taskModalId, "comment");
  }, [commentsOpen, taskModalId]);

  // Shift the stage left when comments pane would clip the viewport edge
  useEffect(() => {
    function applyShift() {
      if (!stageRef.current || !shellRef.current) return;
      if (!commentsOpen) {
        stageRef.current.style.transform = "";
        return;
      }
      const vw = window.innerWidth;
      const shellW = shellRef.current.offsetWidth;
      const shellLeft = (vw - shellW) / 2;
      const paneRight = shellLeft + shellW + PANE_GAP + PANE_W;
      const overflow = paneRight - (vw - EDGE_PAD);
      if (overflow <= 0) {
        stageRef.current.style.transform = "";
        return;
      }
      const maxShift = Math.max(0, shellLeft - EDGE_PAD);
      const shift = Math.min(overflow, maxShift);
      stageRef.current.style.transform = `translateX(-${shift}px)`;
    }
    applyShift();
    window.addEventListener("resize", applyShift);
    return () => window.removeEventListener("resize", applyShift);
  }, [commentsOpen, shellSize]);

  // Scale textarea heights proportionally when modal is resized
  const DEFAULT_H = 560;
  useEffect(() => {
    if (!shellRef.current) return;
    const textareas = Array.from(shellRef.current.querySelectorAll("form textarea"));
    const h = shellSize?.height ?? DEFAULT_H;
    const factor = h / DEFAULT_H;
    textareas.forEach((ta) => {
      if (!ta.dataset.naturalH) ta.dataset.naturalH = String(ta.offsetHeight || 80);
      const base = parseInt(ta.dataset.naturalH, 10) || 80;
      ta.style.minHeight = factor > 1 ? `${Math.round(base * factor)}px` : "";
    });
  }, [shellSize]);

  // Block backdrop close when any drag starting inside the shell releases outside it
  function onShellMouseDown(e) {
    const startX = e.clientX;
    const startY = e.clientY;
    function onMove(ev) {
      if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
        wasDraggingRef.current = true;
      }
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setTimeout(() => { wasDraggingRef.current = false; }, 0);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!shellRef.current) return;
    const rect = shellRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const MIN_W = 600; // 75% of default 800px
    const MIN_H = 420; // 75% of default min-height 560px
    const MAX_W = Math.min(1200, window.innerWidth - PANE_W - PANE_GAP - EDGE_PAD * 2); // never wider than viewport with comments open
    const MAX_H = Math.min(840, window.innerHeight - 64); // 150% of default 560px

    resizingRef.current = true;

    function onMove(ev) {
      setShellSize({
        width: Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX)),
        height: Math.max(MIN_H, Math.min(MAX_H, startH + ev.clientY - startY)),
      });
    }

    function onUp() {
      resizingRef.current = false;
      wasDraggingRef.current = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // clear after the click event fires so backdrop onClick is suppressed
      setTimeout(() => { wasDraggingRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

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

  const modalEntity = modal.entity || null;
  const showEditMeta = Boolean(
    modalEntity?.updatedAt &&
    (modal.type === "board-brief" || modal.type.startsWith("edit-"))
  );

  const isEditTask = modal.type === "edit-task";
  const liveTask = isEditTask && modalEntity?.id ? (lookup.findTask(modalEntity.id) || modalEntity) : modalEntity;
  const commentCount = liveTask?.comments?.length || 0;

  const taskNotifs = isEditTask && liveTask?.id
    ? notifications.filter((n) => n.nodeId === liveTask.id)
    : [];
  const commentNotifs = taskNotifs.filter((n) => n.sourceType === "comment");
  const fieldNotifs = taskNotifs.filter((n) => n.sourceType === "field");
  const commentNotifIds = new Set(commentNotifs.map((n) => (n.sourceId || "").replace(/^comment:/, "")));
  const hasFieldMention = fieldNotifs.length > 0
    ? makeFieldMentionChecker(currentUser?.name)
    : () => false;

  const body = buildModalBody(modal, taskboard, activeFilters, lookup, handleSwitchModal, usersMap, hasFieldMention);

  return html`
    <div className="modal-backdrop" role="presentation" onClick=${(e) => { if (!wasDraggingRef.current) onCloseAll(e); }}>
      <div className="modal-stage" ref=${stageRef}>
        <div
          className="modal-shell"
          ref=${shellRef}
          role="dialog"
          aria-modal="true"
          style=${shellSize ? { width: `${shellSize.width}px`, height: `${shellSize.height}px`, maxHeight: "none" } : {}}
          onClick=${(e) => e.stopPropagation()}
          onMouseDown=${onShellMouseDown}
        >
          <div className="modal-header">
            <h2>${modal.title}</h2>
            ${isEditTask ? html`
              <button
                className=${`button button-ghost comments-toggle-btn${commentsOpen ? " comments-toggle-btn--active" : ""}${commentNotifs.length > 0 ? " comments-toggle-btn--has-notif" : ""}`}
                type="button"
                onClick=${() => setCommentsOpen((o) => !o)}
                title=${commentNotifs.length > 0 ? `${commentNotifs.length} unread mention${commentNotifs.length === 1 ? "" : "s"}` : "Toggle comments"}
              >
                Comments${commentCount > 0 ? html`<span className="comments-header-badge">${commentCount}</span>` : null}
                ${commentNotifs.length > 0 ? html`<span className="comments-header-mention-badge">@${commentNotifs.length}</span>` : null}
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
        <div
          className="modal-resize-handle"
          onMouseDown=${startResize}
          aria-hidden="true"
          title="Drag to resize"
        ></div>
        ${commentsOpen && liveTask ? html`
          <${CommentsPane}
            taskId=${liveTask.id}
            comments=${liveTask.comments || []}
            currentUser=${currentUser}
            usersMap=${usersMap}
            onMentionInput=${handleInput}
            onCommentDeleted=${onReload}
            onClose=${() => setCommentsOpen(false)}
            mentionedCommentIds=${commentNotifIds}
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
