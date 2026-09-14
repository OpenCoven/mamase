import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../theme.js", import.meta.url), "utf8");
const key = "mamase.appearance.v1";

function boot({ stored = null, dark = false, readError = false, writeError = false } = {}) {
  const values = new Map(stored === null ? [] : [[key, stored]]);
  const windowListeners = new Map();
  let mediaListener;
  const media = {
    matches: dark,
    addEventListener(name, listener) { assert.equal(name, "change"); mediaListener = listener; },
  };
  const root = { dataset: {} };
  let notifications = 0;
  const storage = {
    getItem(name) {
      if (readError) throw new DOMException("Blocked", "SecurityError");
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (writeError) throw new DOMException("Full", "QuotaExceededError");
      values.set(name, value);
    },
  };
  const window = {
    localStorage: storage,
    matchMedia(query) { assert.equal(query, "(prefers-color-scheme: dark)"); return media; },
    addEventListener(name, listener) { windowListeners.set(name, listener); },
  };
  const document = {
    documentElement: root,
    dispatchEvent(event) { assert.equal(event.type, "mamase:themechange"); notifications++; },
  };
  runInNewContext(source, { window, document, DOMException, Event });
  return {
    theme: window.mamaseTheme,
    root, values,
    get notifications() { return notifications; },
    system(isDark) { media.matches = isDark; mediaListener(); },
    storage(value, name = key) {
      if (value === null) values.delete(key); else values.set(key, value);
      windowListeners.get("storage")({ key: name, storageArea: storage });
    },
  };
}

test("system is the default and resolves before first paint", () => {
  for (const dark of [false, true]) {
    const app = boot({ dark });
    assert.equal(app.theme.preference, "system");
    assert.equal(app.root.dataset.themePreference, "system");
    assert.equal(app.root.dataset.theme, dark ? "dark" : "light");
    assert.equal(app.values.has(key), false);
    assert.equal(app.notifications, 1);
  }
});

test("system tracks OS changes live, explicit modes do not", () => {
  const app = boot();
  app.system(true);
  assert.equal(app.root.dataset.theme, "dark");
  app.theme.setPreference("light");
  app.system(true);
  assert.equal(app.root.dataset.theme, "light");
  app.theme.setPreference("dark");
  app.system(false);
  assert.equal(app.root.dataset.theme, "dark");
  app.theme.setPreference("system");
  assert.equal(app.root.dataset.theme, "light");
  app.system(true);
  assert.equal(app.root.dataset.theme, "dark");
});

test("explicit preference survives reload and overrides the opposite OS setting", () => {
  const app = boot();
  app.theme.setPreference("dark");
  assert.equal(app.values.get(key), "dark");
  const reloaded = boot({ stored: app.values.get(key), dark: false });
  assert.equal(reloaded.root.dataset.theme, "dark");
  assert.equal(boot({ stored: "light", dark: true }).root.dataset.theme, "light");
});

test("cross-tab changes and removal synchronize the selected preference", () => {
  const app = boot({ stored: "light", dark: true });
  app.storage("dark");
  assert.equal(app.theme.preference, "dark");
  app.storage(null);
  assert.equal(app.theme.preference, "system");
  assert.equal(app.root.dataset.theme, "dark");
  app.storage("light");
  app.storage(null, null);
  assert.equal(app.theme.preference, "system");
});

test("invalid or unavailable stored preferences surface errors without overwriting data", () => {
  const invalid = boot({ stored: "invalid", dark: true });
  assert.equal(invalid.root.dataset.theme, "dark");
  assert.match(invalid.theme.error, /invalid/);
  assert.equal(invalid.values.get(key), "invalid");
  invalid.theme.setPreference("light");
  assert.equal(invalid.theme.error, "");
  assert.equal(invalid.values.get(key), "light");
  const denied = boot({ readError: true });
  assert.match(denied.theme.error, /could not be read/);
  assert.equal(denied.theme.preference, "system");
});

test("failed saves and invalid choices never pretend to change the saved preference", () => {
  const app = boot({ stored: "light", writeError: true });
  assert.throws(() => app.theme.setPreference("dark"), /could not be saved/);
  assert.equal(app.theme.preference, "light");
  assert.equal(app.root.dataset.theme, "light");
  assert.equal(app.values.get(key), "light");
  assert.throws(() => app.theme.setPreference("sepia"), /Choose System/);
});

test("theme bootstrap is loaded synchronously before styles under the existing CSP", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap = '<script src="./theme.js"></script>';
  assert.ok(html.includes(bootstrap));
  assert.ok(html.indexOf(bootstrap) < html.indexOf('<link rel="stylesheet"'));
});
