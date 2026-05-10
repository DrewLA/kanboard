import React, { useEffect, useState } from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { MarkdownCanvas } from "./MarkdownCanvas.js";
import { formatDate } from "./utils.js";

const html = htm.bind(React.createElement);

function buildMarkdown(brief) {
  const b = brief || {};
  return [
    `# ${b.productName || "Product"}`,
    "",
    "## Objective",
    b.objective || "",
    "",
    "## Scope Definition",
    b.scopeDefinition || "",
    "",
    "## Non-Goals",
    b.nonGoals || "",
    "",
    "## Success Criteria",
    b.successCriteria || "",
    "",
    "## Current Focus",
    b.currentFocus || "",
    "",
    "## Implementation Notes",
    b.implementationNotes || ""
  ].join("\n");
}

export function parseMarkdown(markdown, previous) {
  const fields = {
    productName: previous?.productName || "",
    objective: "",
    scopeDefinition: "",
    nonGoals: "",
    successCriteria: "",
    currentFocus: "",
    implementationNotes: ""
  };

  const sectionMap = {
    "## objective": "objective",
    "## scope definition": "scopeDefinition",
    "## non-goals": "nonGoals",
    "## success criteria": "successCriteria",
    "## current focus": "currentFocus",
    "## implementation notes": "implementationNotes"
  };

  const lines = String(markdown || "").split("\n");
  let active = "objective";

  if (lines[0]?.startsWith("# ")) {
    fields.productName = lines[0].slice(2).trim();
  }

  for (const line of lines.slice(1)) {
    const key = sectionMap[line.trim().toLowerCase()];
    if (key) { active = key; continue; }
    fields[active] = `${fields[active]}${fields[active] ? "\n" : ""}${line}`;
  }

  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
  );
}

export function BoardBriefView({ boardBrief, onSave }) {
  const [draft, setDraft] = useState(() => buildMarkdown(boardBrief));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(parseMarkdown(draft, boardBrief || {}));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    setDraft(buildMarkdown(boardBrief));
    setDirty(false);
  }, [boardBrief?.updatedAt]);

  return html`
    <section className="view-shell brief-view">
      <div className="brief-header glass-panel">
        <div>
          <h2>Board Brief</h2>
          ${boardBrief?.updatedAt
            ? html`<p className="inline-note">Last saved ${formatDate(boardBrief.updatedAt)}</p>`
            : html`<p className="inline-note">Not yet saved</p>`}
        </div>
        <div className="brief-actions">
          <button
            className="button button-ghost"
            onClick=${() => { setDraft(buildMarkdown(boardBrief)); setDirty(false); }}
          >Reset</button>
          <button
            className=${`button button-solid${saving ? " button--loading" : ""}`}
            disabled=${!dirty || saving}
            onClick=${handleSave}
          >${saving ? "Saving" : "Save"}</button>
        </div>
      </div>

      <${MarkdownCanvas}
        label="Board Brief"
        value=${draft}
        onChange=${(value) => { setDraft(value); setDirty(true); }}
        placeholder="# Product\n\n## Objective\n..."
      />
    </section>
  `;
}
