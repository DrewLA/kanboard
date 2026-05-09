import React, { useEffect, useRef, useState } from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

export function CustomSelect({ name, defaultValue, value: controlledValue, onChange, options, placeholder = "Select...", actionItem }) {
  const isControlled = onChange !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue || "");
  const value = isControlled ? (controlledValue ?? "") : internalValue;
  const [openPos, setOpenPos] = useState(null);
  const [query, setQuery] = useState("");
  const triggerRef = useRef(null);
  const searchRef = useRef(null);

  const selected = options.find((o) => o.value === value);
  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  function pick(v) {
    if (isControlled) onChange(v);
    else setInternalValue(v);
    setOpenPos(null);
    setQuery("");
  }

  function openList() {
    const rect = triggerRef.current.getBoundingClientRect();
    setOpenPos({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    setQuery("");
  }

  // Auto-focus search input after list mounts
  useEffect(() => {
    if (openPos && searchRef.current) {
      searchRef.current.focus();
    }
  }, [openPos]);

  useEffect(() => {
    if (!openPos) return;

    function onMouseDown(e) {
      if (triggerRef.current?.contains(e.target)) return;
      if (!e.target.closest(".cselect-list")) setOpenPos(null);
    }
    function onScroll(e) {
      if (e.target.nodeType === Node.ELEMENT_NODE && e.target.closest(".cselect-list")) return;
      setOpenPos(null);
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [openPos]);

  const list = openPos ? ReactDOM.createPortal(
    html`
      <div
        className="cselect-list"
        style=${{
          position: "fixed",
          top: openPos.top + "px",
          left: openPos.left + "px",
          minWidth: openPos.width + "px"
        }}
        role="listbox"
      >
        <div className="cselect-search-wrap">
          <svg className="cselect-search-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.4" fill="none" />
            <path d="M8 8l2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <input
            ref=${searchRef}
            className="cselect-search"
            type="text"
            placeholder="Filter..."
            value=${query}
            onInput=${(e) => setQuery(e.target.value)}
            onKeyDown=${(e) => e.key === "Escape" && setOpenPos(null)}
          />
        </div>

        ${actionItem ? html`
          <div className="cselect-sep"></div>
          <button
            type="button"
            className="cselect-action"
            onClick=${() => { setOpenPos(null); setQuery(""); actionItem.onAction(); }}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" style=${{ marginRight: "6px", verticalAlign: "middle" }}>
              <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            ${actionItem.label}
          </button>
          <div className="cselect-sep"></div>
        ` : null}

        <div className="cselect-items">
          ${filtered.length
            ? filtered.map((o) => html`
                <button
                  key=${o.value}
                  type="button"
                  className=${`cselect-item${o.value === value ? " selected" : ""}`}
                  aria-selected=${o.value === value}
                  onClick=${() => pick(o.value)}
                >
                  ${o.label}
                </button>
              `)
            : html`<span className="cselect-empty">No matches</span>`}
        </div>
      </div>
    `,
    document.body
  ) : null;

  return html`
    <div className="cselect">
      ${!isControlled ? html`<input type="hidden" name=${name} value=${value} />` : null}
      <button
        type="button"
        ref=${triggerRef}
        className=${`cselect-trigger${openPos ? " open" : ""}`}
        onClick=${() => openPos ? setOpenPos(null) : openList()}
      >
        <span className=${selected ? "" : "cselect-placeholder"}>${selected?.label || placeholder}</span>
        <svg className="cselect-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M0 0l5 6 5-6z" fill="currentColor" />
        </svg>
      </button>
      ${list}
    </div>
  `;
}

