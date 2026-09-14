import { escapeHtml as esc } from "./workspace.js";

const paths = {
  home: '<path d="M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10"/>',
  projects: '<path d="M3 7h6l2 2h10l-2 11H3z"/><path d="M3 9V5h6l2 2h8v2"/>',
  runs: '<rect x="4" y="3" width="13" height="17" rx="2"/><path d="M9 3v3h4V3"/><circle cx="17" cy="17" r="5"/><path d="M17 14v3l2 1"/>',
  models: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9M8 5l8 5"/>',
  lab: '<path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10"/>',
  datasets: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
  docs: '<path d="M12 5v16M12 5C9 3 5 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 1"/>',
  evaluations: '<path d="M4 20V4m0 16h17M8 16l4-5 4 2 5-7"/>',
  settings: '<path d="M4 7h16M4 17h16M9 4v6M15 14v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m20 20-5-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-5 1 2-12"/>',
  spark: '<path d="m12 3 2 6 6 3-6 2-2 7-2-7-6-2 6-3z"/>',
  external: '<path d="M14 4h6v6M10 14 20 4M20 14v6H4V4h6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  local: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
}

export function button(label, action, iconName = "", className = "", attrs = "") {
  return `<button type="button" class="button ${className}" data-action="${action}" ${attrs}>${iconName ? icon(iconName) : ""}${label}</button>`;
}

export function link(label, href, iconName = "", className = "") {
  return `<a class="button ${className}" href="${esc(href)}">${iconName ? icon(iconName) : ""}${label}</a>`;
}

export function field(label, name, value = "", options = {}) {
  const { type = "text", hint = "", required = true, attrs = "", textarea = false } = options;
  const control = textarea
    ? `<textarea id="field-${name}" name="${name}" ${required ? "required" : ""} ${attrs}>${esc(value)}</textarea>`
    : `<input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} ${attrs}>`;
  return `<div class="field"><label for="field-${name}">${label}</label>${control}${hint ? `<small>${hint}</small>` : ""}</div>`;
}

export function select(label, name, value, options, attrs = "") {
  return `<div class="field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}" ${attrs}>${options.map(([id, title]) => `<option value="${esc(id)}" ${String(value) === String(id) ? "selected" : ""}>${esc(title)}</option>`).join("")}</select></div>`;
}

export function badge(status) {
  return `<span class="badge status-${esc(status)}"><span class="status-dot"></span>${esc(status)}</span>`;
}

export function empty(title, description, action = "", iconName = "spark", compact = false) {
  return `<div class="empty-state ${compact ? "compact" : ""}"><div class="empty-icon">${icon(iconName)}</div><h2>${title}</h2><p>${description}</p>${action}</div>`;
}

export function table(headers, rows, label) {
  return `<div class="table-scroll" role="region" aria-label="${esc(label)}" tabindex="0"><table><thead><tr>${headers.map((heading) => `<th scope="col">${heading}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function formatDate(source) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(source));
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function progress(run) {
  const percent = Math.floor(run.step / run.totalSteps * 100);
  return `<div class="progress-cell"><progress max="${run.totalSteps}" value="${run.step}" aria-label="${esc(run.name)} progress"></progress><span>${percent}%</span></div>`;
}

export function sigil() {
  return `<svg class="coven-mark" viewBox="0 0 590 440" role="img" aria-label="An ink-black familiar with indigo, sage and clay companions">
    <path fill="#191917" d="M104 45C42 45 29 69 29 132v91c0 68 19 103 72 116 53 13 85-31 105-79 11-26 22-51 49-51 28 0 27 22 20 46-12 39 12 54 41 83 30 29 45 68 70 65 29-3 46-47 45-83-2-49-5-70 8-108 16-48 24-125-18-151-24-15-55-16-94-16Z"/>
    <path fill="#4658b8" d="M417 77c57-26 118-6 129 29 14 44-31 83-57 102-29 23-55 17-85 0-49-28-42-81 13-131Z"/>
    <ellipse fill="#669b7d" cx="237" cy="366" rx="40" ry="48" transform="rotate(28 237 366)"/>
    <ellipse fill="#c75e3d" cx="492" cy="351" rx="43" ry="50" transform="rotate(-5 492 351)"/>
  </svg>`;
}
