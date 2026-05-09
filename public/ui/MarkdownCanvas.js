import React from "https://esm.sh/react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

export function MarkdownCanvas({ label, value, onChange, placeholder = "" }) {
  return html`
    <section className="markdown-canvas glass-panel">
      <header className="markdown-canvas-header">
        <h3>${label}</h3>
        <div className="canvas-hints">
          <span>Use # and ## headings</span>
          <span>Keep sections lightweight</span>
        </div>
      </header>
      <textarea
        className="markdown-input"
        value=${value}
        placeholder=${placeholder}
        onInput=${(event) => onChange(event.target.value)}
      ></textarea>
    </section>
  `;
}
