export class AuthClient {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.state = { phase: "loading", user: null, approved: false, message: "" };
    this.busy = false;
    this.pending = null;
  }

  async request(path, options = {}) {
    const response = await fetch(`/api/auth/${path}`, {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000), ...options,
    });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Account service unavailable. Restart or redeploy Mamase, then try again.");
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Account request failed. Try again.");
    return value;
  }

  refresh() {
    if (this.pending) return this.pending;
    if (this.busy) return Promise.resolve();
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    try {
      const session = await this.request("session");
      if (typeof session.configured !== "boolean" || typeof session.authenticated !== "boolean" || (!session.configured && session.authenticated)) throw new Error("Invalid account response. Try again.");
      let user = null;
      if (session.authenticated) {
        if (!session.user || typeof session.user.id !== "string" || typeof session.user.email !== "string") throw new Error("Invalid account profile. Try again.");
        user = {
          id: session.user.id, email: session.user.email,
          firstName: typeof session.user.firstName === "string" ? session.user.firstName : "",
          lastName: typeof session.user.lastName === "string" ? session.user.lastName : "",
        };
      }
      this.state = {
        phase: !session.configured ? "unconfigured" : user ? "signed-in" : "signed-out",
        user, approved: session.approved === true,
        message: typeof session.message === "string" ? session.message : "",
      };
    } catch (error) {
      this.state = { phase: "error", user: null, approved: false, message: error.message };
    }
    this.onChange();
  }

  async logout() {
    this.busy = true;
    this.onChange();
    try {
      if (this.pending) await this.pending;
      const { logoutUrl } = await this.request("logout", { method: "POST", headers: { "X-Mamase-Auth": "1" } });
      const destination = new URL(logoutUrl);
      if (destination.protocol !== "https:" && destination.origin !== location.origin) throw new Error("Invalid sign-out destination. Retry account connection.");
      this.state = { phase: "signed-out", user: null, approved: false, message: "" };
      return destination.href;
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
}
