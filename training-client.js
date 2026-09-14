import { recordProgress } from "./workspace.js";
import { trainingIdentity } from "./training-state.js";

export const localJobActive = (job) => job && ["starting", "running", "cancelling"].includes(job.status);

export class TrainingClient {
  constructor({ onJob, onStatus }) {
    this.onJob = onJob;
    this.onStatus = onStatus;
    this.jobs = new Map();
    this.checked = new Set();
    this.errors = new Map();
    this.streams = new Map();
    this.loading = new Set();
  }

  async request(path, options = {}) {
    const response = await fetch(`/api/training/${path}`, { cache: "no-store", signal: AbortSignal.timeout(35000), ...options });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Local training API unavailable. Restart Mamase with npm run dev.");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Local training request failed (${response.status}).`);
    return value;
  }

  async capability(refresh = false) {
    if (refresh) this.capabilityPromise = null;
    if (!this.capabilityPromise) this.capabilityPromise = this.request("capabilities").then((value) => {
      this.available = value;
      return value;
    }).catch((error) => { this.capabilityPromise = null; throw error; });
    return this.capabilityPromise;
  }

  async watch(run, refresh = false) {
    if (!run) { this.currentRunId = null; return; }
    const sameView = this.currentRunId === run.id;
    this.currentRunId = run.id;
    if (this.checked.has(run.id) && sameView && !refresh) { this.onStatus(run.id); return; }
    this.checked.add(run.id);
    this.loading.add(run.id);
    this.onStatus(run.id);
    try {
      const capability = await this.capability(refresh);
      this.errors.delete(run.id);
      if (!capability.enabled) {
        if (capability.hosted !== true) this.errors.set(run.id, capability.message);
      } else {
        const result = await this.request(`runs/${encodeURIComponent(run.id)}`);
        if (result.job) this.accept(result.job);
        else if (run.localJobId) this.errors.set(run.id, "This run's managed job is not available on this server. Keep its recorded history; restore the original training directory or duplicate the recipe for a new attempt.");
        if (!capability.available && !result.job) this.errors.set(run.id, capability.message);
      }
    } catch (error) {
      this.errors.set(run.id, error.message);
    }
    this.loading.delete(run.id);
    this.onStatus(run.id);
  }

  accept(job) {
    const current = this.jobs.get(job.run.id);
    if (current && current.id === job.id && current.sequence > job.sequence) return;
    this.jobs.set(job.run.id, job);
    this.onJob(job);
    if (localJobActive(job)) this.subscribe(job);
    else {
      this.streams.get(job.id)?.close();
      this.streams.delete(job.id);
      this.capabilityPromise = null;
    }
    this.onStatus(job.run.id);
  }

  subscribe(job) {
    if (this.streams.has(job.id)) return;
    const stream = new EventSource(`/api/training/jobs/${job.id}/events`);
    this.streams.set(job.id, stream);
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        this.errors.delete(job.run.id);
        if (event.type === "snapshot") this.accept(event.job);
        else if (event.type === "progress") {
          const current = this.jobs.get(job.run.id);
          if (event.sequence <= current.sequence) return;
          if (event.sequence !== current.sequence + 1) {
            this.request(`jobs/${job.id}`).then((result) => this.accept(result.job)).catch((error) => { this.errors.set(job.run.id, error.message); this.onStatus(job.run.id); });
            return;
          }
          this.accept({ ...current, status: event.status, sequence: event.sequence, run: recordProgress(current.run, event.update) });
        } else if (event.type === "logs") {
          this.jobs.get(job.run.id).logs = event.logs;
          this.onStatus(job.run.id);
        } else if (event.type === "fatal") throw new Error(event.message);
        else throw new Error("Unrecognized local trainer update.");
      } catch (error) {
        this.errors.set(job.run.id, error.message);
        this.onStatus(job.run.id);
      }
    };
    stream.onerror = () => {
      this.errors.set(job.run.id, "Live connection lost; reconnecting. The job continues while the Mamase server is running.");
      this.onStatus(job.run.id);
    };
  }

  async command(path, value) {
    const capability = await this.capability();
    if (!capability.enabled) throw new Error(capability.message || "Local training is unavailable on this server.");
    return this.request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Mamase-Token": capability.token }, body: JSON.stringify(value) });
  }

  async launch(payload) {
    const capability = await this.capability();
    if (!capability.enabled || !capability.available) throw new Error(capability.message || "The local trainer is not ready.");
    let job;
    try { ({ job } = await this.command("jobs", payload)); } catch (error) {
      // A lost response must not turn a retry into a second training process.
      const result = await this.request(`runs/${payload.workspace.runs[0].id}`);
      if (!result.job || result.job.identity !== trainingIdentity(payload.workspace.runs[0], payload.workspace.datasets[0])) throw error;
      job = result.job;
    }
    this.accept(job);
    return job;
  }

  async cancel(id) {
    const { job } = await this.command(`jobs/${id}/cancel`, {});
    this.accept(job);
    return job;
  }

  forget() {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.jobs.clear();
    this.checked.clear();
    this.errors.clear();
    this.currentRunId = null;
  }
}

export function encodeDataset(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
