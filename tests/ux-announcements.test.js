import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installAnnouncementRecorder, drainAnnouncements, waitForAnnouncement } from "../scripts/ux-announcements.mjs";

// The gate asserts on this recorder's verdicts. A verdict is only worth asserting on if the rule
// behind it is proved on pages built to contain each shape of live-region change, so each case
// here is one shape, and the expected verdict is the one a screen reader gives it.

let browser;
let page;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installAnnouncementRecorder(context);
  page = await context.newPage();
});
test.after(async () => { await browser?.close(); });

const load = async (html) => {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  await drainAnnouncements(page);
};
const act = async (script) => {
  await page.evaluate(script);
  return drainAnnouncements(page);
};

test("a change to a region that was already present and exposed is spoken at its politeness", async () => {
  await load('<p id="s" role="status"></p><p id="a" aria-live="assertive"></p>');
  const entries = await act(() => { document.getElementById("s").textContent = "Saved."; document.getElementById("a").textContent = "Failed."; });
  assert.deepEqual(entries.map(({ id, text, spoken, politeness, reason }) => ({ id, text, spoken, politeness, reason })), [
    { id: "s", text: "Saved.", spoken: true, politeness: "polite", reason: "changed" },
    { id: "a", text: "Failed.", spoken: true, politeness: "assertive", reason: "changed" },
  ]);
});

test("a status region inserted with its content is silent, and the tree cannot tell", async () => {
  await load("<main></main>");
  const [entry] = await act(() => { document.querySelector("main").innerHTML = '<p role="status">3 new · 0 duplicates</p>'; });
  assert.equal(entry.spoken, false);
  assert.equal(entry.reason, "inserted with its content");
  // The same shape a renderer produces when it rebuilds a panel and then fills the region in it.
  const [rebuilt] = await act(() => {
    document.querySelector("main").innerHTML = '<span id="live" role="status"></span>';
    document.getElementById("live").textContent = "running, 10%";
  });
  assert.equal(rebuilt.spoken, false, "filled in the same tick as it was inserted");
});

test("a hidden region unhidden with its content is silent, even when made assertive at the same time", async () => {
  await load('<div id="toast" role="status" aria-live="polite" hidden></div>');
  const [entry] = await act(() => {
    const toast = document.getElementById("toast");
    toast.textContent = "Workspace name saved.";
    toast.setAttribute("aria-live", "assertive");
    toast.hidden = false;
  });
  assert.equal(entry.spoken, false);
  assert.equal(entry.reason, "shown with its content");
});

test("a change made in the same tick a region is switched assertive is queued at the politeness it had", async () => {
  await load('<div id="toast" role="status" aria-live="polite"></div>');
  const [entry] = await act(() => {
    const toast = document.getElementById("toast");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("role", "alert");
    toast.textContent = "Could not save.";
  });
  assert.equal(entry.spoken, true);
  assert.equal(entry.politeness, "polite", "the interruption the code asked for is not the one assistive technology queued");
});

test("role=alert is the exception: it is announced on appearance", async () => {
  await load('<form><p class="form-error" role="alert" hidden></p></form>');
  const [shown] = await act(() => { const error = document.querySelector(".form-error"); error.textContent = "Add a run name."; error.hidden = false; });
  assert.equal(shown.spoken, true);
  assert.equal(shown.politeness, "assertive");
  const [inserted] = await act(() => { document.querySelector("form").insertAdjacentHTML("beforeend", '<p role="alert">Blocked.</p>'); });
  assert.equal(inserted.spoken, true);
});

test("an exposed region set to the same text again, and an emptied region, are not announcements", async () => {
  await load('<p id="s" role="status">Saved.</p>');
  assert.deepEqual(await act(() => { document.getElementById("s").textContent = "Saved."; }), []);
  assert.deepEqual(await act(() => { document.getElementById("s").textContent = ""; }), []);
  // Clearing and refilling across frames is how a repeat is made audible.
  await act(() => { document.getElementById("s").textContent = ""; });
  const [again] = await act(() => { document.getElementById("s").textContent = "Saved."; });
  assert.equal(again?.spoken, true);
});

test("a region outside an open modal dialog is inert, and so silent, until the dialog closes", async () => {
  await load('<p id="s" role="status"></p><dialog id="d"><p id="in" role="status"></p><button>Close</button></dialog>');
  await page.evaluate(() => document.getElementById("d").showModal());
  await drainAnnouncements(page);
  const entries = await act(() => {
    document.getElementById("s").textContent = "starting, 0%";
    document.getElementById("in").textContent = "Loading evidence.";
  });
  // A region that is not exposed is not even a silent entry: nothing reached assistive technology.
  assert.deepEqual(entries.map(({ id, spoken }) => ({ id, spoken })), [{ id: "in", spoken: true }], "the page behind a modal dialog is inert");
  await page.evaluate(() => document.getElementById("d").close());
  await drainAnnouncements(page);
  // What the region already said while it was inert is not news when it becomes exposed again.
  assert.deepEqual(await act(() => {}), []);
  const [after] = await act(() => { document.getElementById("s").textContent = "running, 25%"; });
  assert.equal(after.spoken, true);
});

test("a region removed and recreated is a new region, not a change", async () => {
  await load('<main><p id="s" role="status">running, 40%</p></main>');
  const [entry] = await act(() => { document.querySelector("main").innerHTML = '<p id="s" role="status">cancelled, 40%</p>'; });
  assert.equal(entry.spoken, false, "same id, same place, same role -- and a screen reader hears nothing");
});

test("waitForAnnouncement reports what was logged instead when nothing would be spoken", async () => {
  await load("<main></main>");
  await page.evaluate(() => { document.querySelector("main").innerHTML = '<p role="status">Workspace name saved.</p>'; });
  await assert.rejects(waitForAnnouncement(page, /saved/, { timeout: 300 }), (error) => {
    assert.match(error.message, /Nothing matching \/saved\/ would have been spoken/);
    assert.match(error.message, /silent polite <p> inserted with its content: "Workspace name saved\."/);
    return true;
  });
  await page.evaluate(() => { document.querySelector("main").innerHTML = '<p id="s" role="status"></p>'; });
  await drainAnnouncements(page);
  setTimeout(() => page.evaluate(() => { document.getElementById("s").textContent = "Workspace name saved."; }), 100);
  assert.equal((await waitForAnnouncement(page, /saved/)).politeness, "polite");
});
