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
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  dark: '<path d="M20.5 13.5A8.5 8.5 0 0 1 10.5 3a8.5 8.5 0 1 0 10 10.5Z"/>',
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

export function distillationArt() {
  return `<svg class="distillation-art" viewBox="0 0 590 460" role="img" aria-labelledby="distillation-art-title distillation-art-description">
    <title id="distillation-art-title">Knowledge, distilled for the coven</title>
    <desc id="distillation-art-description">An alchemical glass flask holds a constellation of knowledge. A curved condenser carries it into a smaller, lavender-colored vessel containing a bright local-model familiar.</desc>
    <circle class="art-halo" cx="295" cy="229" r="181"/>
    <circle class="art-orbit" cx="295" cy="229" r="203" stroke-dasharray="2 9"/>
    <path class="art-orbit" d="M75 367C177 423 402 430 520 354M96 118C189 47 388 39 495 133"/>
    <g class="art-ticks"><path d="M88 219h18m-9-9v18M493 219h18m-9-9v18M295 12v12M295 434v12"/></g>
    <path class="art-pipe" d="M242 145h35c24 0 30 20 43 37l38 51c9 12 21 16 36 16h22v19"/>
    <path class="art-pipe-inner" d="M242 145h35c24 0 30 20 43 37l38 51c9 12 21 16 36 16h22v19"/>
    <path class="art-condensation" d="m299 167 9-7m-2 18 10-7m-2 18 10-7m-2 18 10-7m-2 18 10-7"/>
    <path class="art-glass" d="M181 98h56v72c33 21 53 48 53 84 0 51-38 90-81 90s-84-39-84-90c0-36 23-63 56-84Z"/>
    <path class="art-liquid" d="M139 250c26-22 49 16 77 2 23-12 44-17 60-8 8 47-24 86-67 86-40 0-74-36-70-80Z"/>
    <path class="art-liquid-line" d="M139 250c26-22 49 16 77 2 23-12 44-17 60-8"/>
    <path class="art-glass-shine" d="M192 119v58c-30 20-53 41-54 72"/>
    <rect class="art-rim" x="173" y="87" width="72" height="15" rx="7.5"/>
    <g class="art-constellation"><path d="m166 224 38-34 43 27-43 18-38-11m38-34v45l28 42"/>
      <circle cx="166" cy="224" r="5"/><circle cx="204" cy="190" r="6"/><circle cx="247" cy="217" r="4"/><circle cx="204" cy="235" r="4"/><circle cx="232" cy="277" r="4"/>
    </g>
    <g class="art-bubbles"><circle cx="179" cy="287" r="5"/><circle cx="198" cy="306" r="3"/><circle cx="248" cy="298" r="3"/></g>
    <path class="art-stand" d="M148 351h122m-99 0-13 30m89-30 13 30M140 383h139"/>
    <path class="art-spark" d="m210 356 7 11-7 12-7-12Z"/>
    <path class="art-glass" d="M394 299h44v16c14 10 24 24 24 41 0 26-20 45-46 45s-46-19-46-45c0-17 10-31 24-41Z"/>
    <path class="art-student" d="M381 352c15-10 20 5 36 0 13-5 26-6 34-1 4 24-10 38-35 38-23 0-38-13-35-37Z"/>
    <rect class="art-rim" x="386" y="291" width="60" height="12" rx="6"/>
    <path class="art-drop" d="M416 267c-4 6-8 10-8 14a8 8 0 0 0 16 0c0-4-4-8-8-14Z"/>
    <path class="art-familiar" d="m416 325 7 20 17 7-17 7-7 21-7-21-17-7 17-7Z"/>
    <path class="art-eyes" d="M410 349v4m12-4v4"/>
    <g class="art-ticks"><path d="M371 407h90M427 89h20m-10-10v20M110 305h12m-6-6v12"/></g>
    <circle class="art-moon" cx="432" cy="113" r="21"/>
    <path class="art-moon-cutout" d="M440 92a21 21 0 0 0 13 35 21 21 0 0 1-13-35Z"/>
    <circle class="art-spark" cx="128" cy="142" r="5"/>
    <text class="art-label" x="209" y="68" text-anchor="middle">THE TEACHER</text>
    <text class="art-label" x="416" y="428" text-anchor="middle">OUR LOCAL MODEL</text>
    <text class="art-annotation" x="364" y="156" transform="rotate(53 364 156)">knowledge, refined</text>
  </svg>`;
}
