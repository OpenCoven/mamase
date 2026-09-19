import { escapeHtml as esc, assert } from "./workspace.js";
import { icon, link } from "./ui.js";
import { PlaygroundClient } from "./playground-client.js";

const suggestions = [
  ["Explain a concept", "Explain why the sky looks blue in three short sentences."],
  ["Follow a format", 'Return only a JSON object with the keys "name" and "purpose", describing a local model lab.'],
  ["Try a small task", "Write a Python function that returns the largest number in a list."],
];
const action = (label, name, glyph = "", classes = "", attrs = "") =>
  `<button type="button" class="button ${classes}" data-pg-action="${name}" ${attrs}>${glyph ? icon(glyph) : ""}${label}</button>`;
const variantName = (variant) => variant === "adapter" ? "Trained adapter" : "Base model";
const shortName = (path) => path.split(/[/\\]/).filter(Boolean).at(-1) || path;

export class ModelPlayground {
  constructor({ hosted = false, notify, download }) {
    this.client = new PlaygroundClient({ hosted });
    this.notify = notify;
    this.download = download;
    this.phase = hosted ? "hosted" : "loading";
    this.models = [];
    this.selected = "";
    this.variant = "adapter";
    this.settings = { system: "", temperature: "0.7", maxTokens: "128", seed: "42" };
    this.prompt = "";
    this.turns = [];
    this.conversationModel = null;
    this.notice = "";
    this.status = "";
    this.busy = false;
    this.settingsOpen = window.matchMedia("(min-width: 1101px)").matches;
  }

  get model() { return this.models.find((model) => model.jobId === this.selected); }
  get usable() { return this.phase === "ready" && this.model?.available && !this.data?.busy; }

  mount(root, { artifactId, workspace }) {
    this.events?.abort();
    this.events = new AbortController();
    this.root = root;
    this.active = true;
    this.workspace = workspace;
    const currentArtifact = this.conversationModel?.artifactId || this.model?.artifactId;
    if (artifactId && artifactId !== currentArtifact && this.turns.length) {
      this.stop();
      this.pendingTarget = artifactId;
      this.confirmClear = true;
      this.notice = "A different model was opened. Keep this conversation, or clear it to switch models.";
      this.requested = currentArtifact;
      history.replaceState(null, "", `#/testing/${encodeURIComponent(currentArtifact)}`);
    } else if (artifactId) {
      if (artifactId !== currentArtifact && this.phase !== "hosted") this.phase = "loading";
      this.requested = artifactId;
    }
    const options = { signal: this.events.signal };
    root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-pg-action]");
      if (target) void this.handleAction(target).catch((error) => {
        this.notice = error.message;
        this.notify(error.message, true);
        this.render();
      });
    }, options);
    root.addEventListener("input", (event) => {
      const element = event.target;
      if (element.name === "pgPrompt") this.prompt = element.value;
      if (element.dataset.pgSetting) this.settings[element.dataset.pgSetting] = element.value;
      element.removeAttribute("aria-invalid");
    }, options);
    root.addEventListener("change", (event) => {
      if (event.target.id === "pg-model" && !this.busy && !this.turns.length) {
        this.selected = event.target.value;
        this.requested = this.resolvedRequest = this.model?.artifactId || "";
        this.notice = "";
        this.status = "";
        this.applyModelDefaults();
        if (this.model) history.replaceState(null, "", `#/testing/${encodeURIComponent(this.model.artifactId)}`);
        this.render("#pg-model");
      }
    }, options);
    root.addEventListener("submit", (event) => {
      if (event.target.id !== "pg-composer") return;
      event.preventDefault();
      event.stopPropagation();
      void this.send();
    }, options);
    root.addEventListener("keydown", (event) => {
      if (event.target.name === "pgPrompt" && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        root.querySelector("#pg-composer").requestSubmit();
      }
    }, options);
    root.addEventListener("toggle", (event) => {
      if (event.target.id === "pg-settings") this.settingsOpen = event.target.open;
    }, { ...options, capture: true });
    this.render();
    void this.load();
  }

  deactivate() {
    this.active = false;
    this.stop();
    this.events?.abort();
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = this.refresh();
    try { await this.loading; } finally { this.loading = null; }
  }

  async refresh() {
    try {
      this.data = await this.client.load();
      this.models = this.data.models;
      this.phase = this.data.hosted ? "hosted" : !this.data.capability.enabled || !this.data.capability.available ? "unavailable" : "ready";
      if (this.requested && (this.requested !== this.resolvedRequest || !this.selected)) {
        const model = this.models.find((item) => item.artifactId === this.requested);
        if (model?.jobId !== this.selected) {
          this.stop();
          this.turns = [];
          this.conversationModel = null;
          this.selected = model?.jobId || "";
          this.applyModelDefaults();
        }
        this.resolvedRequest = this.requested;
        if (!model && this.phase === "ready") this.notice = "This artifact is not a completed local MLX output on this server. Choose an available model below; no substitute has been selected.";
      } else if (!this.selected && !this.requested) {
        this.selected = this.models.find((model) => model.available)?.jobId || "";
        this.applyModelDefaults();
      }
    } catch (error) {
      this.phase = "error";
      this.notice = error.message;
    }
    this.render();
  }

  applyModelDefaults() {
    this.settings.maxTokens = String(this.model?.contextWindow ? Math.min(128, Math.max(1, Math.floor(this.model.contextWindow / 4))) : 128);
  }

  banner() {
    if (this.phase === "hosted") return `<div class="notice">${icon("local")}<div><strong>Model testing runs on your Mac.</strong><p>Open local Mamas&eacute; with <code>npm run dev</code>. The trained adapter and its original base model must be on that Mac. This hosted site cannot generate replies or reach your local files.</p>${link("Workspace transfer & settings", "#/settings", "arrow", "small")}</div></div>`;
    if (this.phase === "loading") return `<p class="notice" role="status">${icon("clock")} Checking the local model runtime...</p>`;
    if (["unavailable", "error"].includes(this.phase)) return `<div class="notice"><div><strong>Local model runtime needs attention.</strong><p>${esc(this.notice || this.data?.capability.message || "Start the local app and install its MLX training requirements.")}</p>${action("Refresh local models", "refresh", "arrow", "small")}</div></div>`;
    if (!this.models.length) return `<div class="notice">${icon("models")}<div><strong>No completed local models yet.</strong><p>Finish a managed MLX training run first. Its finalized adapter will appear here automatically. External PEFT, GGUF, and manual file references are not supported by this local runtime.</p>${link("Open distillation lab", "#/playground", "lab", "small")}</div></div>`;
    if (this.data.busy && !this.busy) return `<div class="notice">${icon("clock")}<div>The local runtime is in use. Training and generation share one slot. Refresh after the current operation finishes. ${action("Refresh", "refresh", "", "small quiet")}</div></div>`;
    if (this.model && !this.model.available) return `<div class="notice"><div><strong>This model is unavailable.</strong><p>${esc(this.model.message)}</p></div></div>`;
    return "";
  }

  settingsMarkup() {
    const locked = this.busy || this.turns.length > 0;
    const model = this.model;
    return `<details class="pg-settings" id="pg-settings" ${this.settingsOpen ? "open" : ""}><summary>${icon("settings")} Model &amp; generation settings</summary><div class="pg-inspector">
      <section><span class="eyebrow">Test target</span><div class="theme-picker" role="group" aria-label="Model variant">
        ${["adapter", "base"].map((variant) => `<button type="button" data-pg-action="variant" data-variant="${variant}" aria-pressed="${this.variant === variant}" ${locked ? "disabled" : ""}>${variantName(variant)}</button>`).join("")}</div>
        <div class="field"><label for="pg-model">Local trained model</label><select id="pg-model" ${locked || !this.models.length ? "disabled" : ""}><option value="">Choose a completed model</option>${this.models.map((item) => `<option value="${esc(item.jobId)}" ${this.selected === item.jobId ? "selected" : ""} ${!item.available ? "disabled" : ""}>${esc(item.name)}${item.available ? "" : " (unavailable)"}</option>`).join("")}</select></div>
        ${action("Refresh local models", "refresh", "arrow", "small quiet", this.busy || this.phase === "hosted" ? "disabled" : "")}
        ${model ? `<dl class="facts"><dt>Base model</dt><dd title="${esc(model.baseModel)}">${esc(shortName(model.baseModel))}</dd><dt>Context</dt><dd>${model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : "Not reported"}</dd><dt>Runtime</dt><dd>Local MLX &middot; text only</dd><dt>Weights</dt><dd>${this.variant === "adapter" ? "Base + trained LoRA adapter" : "Original base, without adapter"}</dd></dl><details><summary>Model provenance</summary><p class="help">Completed job <code>${esc(model.jobId)}</code>. ${this.workspace?.runs.some((run) => run.id === model.runId) ? link("Source training run", `#/sessions/${model.runId}`, "runs", "small quiet") : "Its training record is not in this browser workspace, but the model is still available on this server."}</p></details>` : `<p class="help">Choose a completed MLX output. Base mode uses that run's original model without the adapter.</p>`}
        <p class="help">${locked ? "Start a new conversation to change the model, variant, or system prompt." : "A conversation keeps one model and variant so its replies are not mixed."}</p>
      </section><section><span class="eyebrow">Generation</span>
        ${this.numberSetting("Temperature", "temperature", 0, 2, "0.1", "0 is greedy. Higher values allow more variation.")}
        ${this.numberSetting("Max new tokens", "maxTokens", 1, 2048, "1", "Caps the reply, not the prompt. Input and output must fit the model's context.")}
        ${this.numberSetting("Seed", "seed", 0, 4294967295, "1", "A reproducibility aid, not a promise of identical replies across hardware.")}
        <p class="help">These settings apply to the next reply. Inputs are never silently truncated.</p>
      </section><section><div class="field"><label for="pg-system">System prompt</label><textarea id="pg-system" form="pg-composer" data-pg-setting="system" rows="5" maxlength="4000" placeholder="Optional instructions for this conversation..." ${locked ? "disabled" : ""}>${esc(this.settings.system)}</textarea><small>No hidden familiar identity or tool permissions are added.</small></div>
        <p class="help">The model loads for each reply and releases its memory afterward. A first response may take time.</p>
      </section></div></details>`;
  }

  numberSetting(label, key, min, max, step, hint) {
    return `<div class="field"><label for="pg-${key}">${label}</label><input id="pg-${key}" form="pg-composer" data-pg-setting="${key}" type="number" value="${esc(this.settings[key])}" min="${min}" max="${max}" step="${step}" required aria-describedby="pg-${key}-hint" ${this.busy ? "disabled" : ""}><small id="pg-${key}-hint">${hint}</small></div>`;
  }

  transcriptMarkup() {
    if (!this.turns.length) return `<div class="pg-empty"><div class="pg-sigil" aria-hidden="true">${icon("spark")}</div><span class="eyebrow">The coven / model playground</span><h2>Put your model to the test.</h2><p>Try fresh examples. Inspect what the trained adapter changes, then start a new conversation to test the base model.</p><div class="pg-suggestions">${suggestions.map(([label], index) => action(label, "suggest", "spark", "small", `data-index="${index}"`)).join("")}</div></div>`;
    return this.turns.map((turn, index) => `<article class="pg-turn"><section class="pg-user"><h3>You</h3><p class="pg-message">${esc(turn.prompt)}</p></section>
      <section class="pg-assistant"><div class="pg-reply-heading"><h3>${icon("spark")} ${esc(turn.modelName)} <span class="tag">${variantName(turn.variant)}</span></h3>${action("Copy reply", "copy", "copy", "small quiet", `data-index="${index}" ${!turn.reply ? "disabled" : ""}`)}</div><p class="pg-message" data-pg-reply="${index}">${esc(turn.reply)}</p>
      <p class="pg-reply-meta">${turn.completion ? `${turn.completion.generatedTokens} generated tokens &middot; ${turn.completion.promptTokens} prompt tokens &middot; ${(turn.completion.elapsedMs / 1000).toFixed(1)}s &middot; ${turn.completion.finishReason === "length" ? "Token limit reached" : "Model finished"}${!turn.reply ? " &middot; No text produced" : ""}` : turn.state === "generating" ? "Waiting for the local model..." : turn.state === "stopped" ? "Stopped. This partial reply is not used as conversation context." : `Reply failed: ${esc(turn.error)}`}</p>
      ${["error", "stopped"].includes(turn.state) ? action("Restore prompt", "restore", "", "small quiet", `data-index="${index}"`) : ""}
      </section></article>`).join("");
  }

  render(focus = "") {
    if (!this.active || !this.root?.isConnected) return;
    const oldLog = this.root.querySelector("#pg-log");
    const active = this.root.contains(document.activeElement) ? document.activeElement : null;
    const activeId = active?.id;
    const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const scrollTop = oldLog?.scrollTop || 0;
    const atBottom = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 80;
    const model = this.model;
    this.root.innerHTML = `<header class="page-header"><div><h1>Model playground</h1><p>Real local replies. No web access, tools, or evaluation scores.</p></div><div class="actions">${action("New conversation", "new", "plus", "quiet", this.busy || !this.turns.length ? "disabled" : "")}${action("Export transcript", "export", "download", "quiet", !this.turns.length || this.busy ? "disabled" : "")}</div></header>
      ${this.banner()}${this.notice && !["error", "unavailable"].includes(this.phase) ? `<p class="notice" role="status">${esc(this.notice)}</p>` : ""}
      ${this.confirmClear ? `<div class="notice"><div><strong>${this.pendingTarget ? "Switch to another model?" : "Start a fresh conversation?"}</strong><p>This clears the current replies from the playground. Export them first if you need a copy. Your model files and training records are not changed.</p><div class="actions">${action("Keep conversation", "keep", "", "quiet")}${action("Clear & start new", "clear", "", "primary", this.busy ? "disabled" : "")}</div></div></div>` : ""}
      <div class="playground-layout">${this.settingsMarkup()}<section class="pg-conversation" aria-label="Model conversation">
        <div class="pg-target"><span class="eyebrow">Target</span>${action(model ? esc(model.name) : "Choose a local model", "settings", "models", "small quiet")}<span class="tag">${variantName(this.variant)}</span><span class="pg-local">${icon("local")} Local MLX</span></div>
        <div class="pg-log" id="pg-log" role="log" aria-label="Conversation transcript" aria-live="off" tabindex="0">${this.transcriptMarkup()}</div>
        <form class="pg-composer" id="pg-composer" novalidate><label class="sr-only" for="pg-prompt">Message to the model</label><textarea id="pg-prompt" name="pgPrompt" rows="3" maxlength="8000" required placeholder="Ask a question or try a fresh example..." ${this.busy ? "disabled" : ""}>${esc(this.prompt)}</textarea>
          <div class="pg-composer-footer"><p id="pg-status" role="status" aria-live="polite">${esc(this.status || (this.usable ? "Ready for your next example" : this.phase === "hosted" ? "Open local Mamas\u00e9 to generate" : "Choose an available local model"))}</p>${this.busy ? action("Stop generation", "stop", "stop", "danger") : `<button type="submit" class="button primary" ${!this.usable ? "disabled" : ""}>${icon("arrow")} Send message <kbd aria-hidden="true">Ctrl Enter</kbd></button>`}</div>
        </form><p class="pg-boundary">Conversation stays in memory in this tab, not in workspace backups. Leaving stops generation; reloading clears the conversation. Check replies before relying on them.</p>
      </section></div>`;
    const log = this.root.querySelector("#pg-log");
    log.scrollTop = atBottom ? log.scrollHeight : scrollTop;
    const target = focus ? this.root.querySelector(focus) : activeId ? this.root.querySelector(`#${CSS.escape(activeId)}`) : null;
    target?.focus({ preventScroll: true });
    if (!focus && selection && target) target.setSelectionRange(...selection);
  }

  updateReply(index) {
    if (!this.active || !this.root?.isConnected || !this.turns[index]) return;
    const log = this.root.querySelector("#pg-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const reply = this.root.querySelector(`[data-pg-reply="${index}"]`);
    if (reply) reply.textContent = this.turns[index].reply;
    const status = this.root.querySelector("#pg-status");
    if (status) status.textContent = this.status;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async send() {
    if (this.busy) { this.notify("A reply is already being generated.", true); return; }
    const form = this.root.querySelector("#pg-composer");
    if (!form.checkValidity()) { this.root.querySelector("#pg-settings").open = true; form.reportValidity(); return; }
    if (!this.usable) { this.notice = "Choose an available local model, or refresh the local runtime."; this.render(); return; }
    const prompt = this.prompt.trim();
    if (!prompt) { this.notice = "Enter a message before sending."; this.render("#pg-prompt"); return; }
    const messages = this.settings.system.trim() ? [{ role: "system", content: this.settings.system }] : [];
    for (const turn of this.turns.filter((turn) => turn.state === "complete" && turn.reply)) messages.push({ role: "user", content: turn.prompt }, { role: "assistant", content: turn.reply });
    messages.push({ role: "user", content: prompt });
    if (messages.length > 32 || messages.reduce((total, message) => total + message.content.length, 0) > 32000) {
      this.notice = "This conversation has reached the playground input limit. Start a new conversation; no context has been discarded.";
      this.render();
      return;
    }
    const request = { jobId: this.model.jobId, variant: this.variant, messages, temperature: Number(this.settings.temperature), maxTokens: Number(this.settings.maxTokens), seed: Number(this.settings.seed) };
    if (!this.turns.length) this.conversationModel = { ...this.model };
    const turn = { prompt, reply: "", state: "generating", jobId: this.model.jobId, artifactId: this.model.artifactId, baseModel: this.model.baseModel, modelName: this.model.name, variant: this.variant, settings: { temperature: request.temperature, maxTokens: request.maxTokens, seed: request.seed } };
    const index = this.turns.push(turn) - 1;
    this.prompt = "";
    this.notice = "";
    this.status = "Loading the local model...";
    this.busy = true;
    this.controller = new AbortController();
    const controller = this.controller;
    this.render();
    try {
      turn.completion = await this.client.generate(request, { signal: controller.signal, onEvent: (event) => {
        if (controller.signal.aborted || this.turns[index] !== turn) return;
        if (event.type === "status") this.status = event.message === "loading" ? "Loading the local model..." : event.message === "generating" ? "Generating a local reply..." : event.message;
        else if (event.type === "token") { turn.reply += event.text; this.status = "Generating a local reply..."; }
        this.updateReply(index);
      } });
      turn.state = "complete";
      this.status = `Reply complete. ${turn.completion.generatedTokens} tokens generated.`;
    } catch (error) {
      turn.state = controller.signal.aborted ? "stopped" : "error";
      turn.error = error.message;
      this.status = controller.signal.aborted ? "Generation stopped." : `Generation failed: ${error.message}`;
      if (!controller.signal.aborted) this.notice = error.message;
    } finally {
      this.busy = false;
      this.controller = null;
      // Say the outcome into the status region that exists, and give assistive technology a task to
      // see the change before the panel is rebuilt: a region rebuilt with its text is new to it, not
      // changed, and is not spoken -- and a change made in the same tick as the rebuild is gone before
      // it is processed. "Generating..." reached the reader through updateReply; "Reply complete",
      // "Generation stopped." and "Generation failed" arrive here.
      if (this.turns[index] === turn) this.updateReply(index);
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.render();
      if (this.active) await this.load();
    }
  }

  stop() {
    if (this.controller) {
      this.status = "Stopping the local generation...";
      const status = this.root?.querySelector("#pg-status");
      if (status) status.textContent = this.status;
      this.controller.abort();
    }
  }

  async handleAction(element) {
    const name = element.dataset.pgAction;
    if (name === "refresh") { this.notice = ""; await this.load(); }
    else if (name === "stop") this.stop();
    else if (name === "settings") {
      this.settingsOpen = true;
      const settings = this.root.querySelector("#pg-settings");
      settings.open = true;
      settings.scrollIntoView({ block: "nearest" });
      settings.querySelector("#pg-model").focus({ preventScroll: true });
    } else if (name === "variant") {
      assert(!this.busy && !this.turns.length, "Start a new conversation before changing the variant.");
      assert(["adapter", "base"].includes(element.dataset.variant), "Choose an adapter or its base model.");
      this.variant = element.dataset.variant;
      this.render(`[data-variant="${this.variant}"]`);
    } else if (name === "suggest" || name === "restore") {
      const index = Number(element.dataset.index);
      const prompt = name === "suggest" ? suggestions[index]?.[1] : this.turns[index]?.prompt;
      assert(typeof prompt === "string", "This example is no longer available.");
      this.prompt = prompt;
      this.render("#pg-prompt");
    } else if (name === "new") { this.confirmClear = true; this.render('[data-pg-action="keep"]'); }
    else if (name === "keep") {
      this.confirmClear = false;
      if (this.pendingTarget) { this.pendingTarget = ""; this.notice = ""; }
      this.render('[data-pg-action="new"]');
    }
    else if (name === "clear") {
      assert(!this.busy, "Stop generation before clearing the conversation.");
      this.turns = [];
      this.conversationModel = null;
      this.confirmClear = false;
      this.notice = "";
      this.status = "";
      if (this.pendingTarget) {
        this.requested = this.pendingTarget;
        this.pendingTarget = "";
        this.selected = "";
        this.phase = "loading";
        history.replaceState(null, "", `#/testing/${encodeURIComponent(this.requested)}`);
      }
      this.render("#pg-prompt");
      if (this.phase === "loading") await this.load();
    } else if (name === "copy") {
      const turn = this.turns[Number(element.dataset.index)];
      assert(turn?.reply, "There is no reply to copy yet.");
      await navigator.clipboard.writeText(turn.reply);
      this.notify("Reply copied.");
    } else if (name === "export") {
      assert(this.turns.length && !this.busy, "Finish the reply before exporting.");
      this.download("mamase-playground-transcript.json", { schema: "mamase.playground-transcript.v1", exportedAt: new Date().toISOString(), model: this.conversationModel, variant: this.variant, systemPrompt: this.settings.system, turns: this.turns });
      this.notify("Transcript exported. Workspace backups do not include it.");
    } else throw new Error("Unknown playground action.");
  }
}
