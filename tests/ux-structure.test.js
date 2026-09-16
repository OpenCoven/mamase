import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { auditStructure, assertStructure } from "../scripts/ux-structure.mjs";

// scripts/verify-ux.mjs runs this sweep over every route of the real application, where it passes.
// A passing gate is not evidence that a check works: an app-wide mutation trips an earlier
// assertion in that script long before the sweep runs. So each check is proved here instead,
// against a page built to contain exactly one defect.

// A minimal page that satisfies every check. Each case below breaks one thing in it.
const SOUND = `
  <style>
    :focus-visible { outline: 2px solid #b36; }
    button, a, input { box-shadow: 0 1px 0 #ccc; }
  </style>
  <nav aria-label="Workspace"><a href="#a">Runs</a></nav>
  <main>
    <h1>Training runs</h1>
    <h2>Recorded</h2>
    <button>Export CSV</button>
    <label for="q">Search runs</label><input id="q">
  </main>`;

let browser;
let page;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
test.after(async () => { await browser?.close(); });

const audit = async (html) => {
  await page.setContent(html);
  return auditStructure(page);
};
// The message is the finding a maintainer reads, so assert on it rather than on the bare throw.
const rejects = async (html, expected) => {
  const report = await audit(html);
  assert.throws(() => assertStructure(report, "#/fixture"), (error) => {
    assert.match(error.message, expected);
    return true;
  }, `expected ${expected} to be reported`);
  return report;
};

test("a page with sound structure raises nothing", async () => {
  const report = await audit(SOUND);
  assert.equal(report.controls, 3);
  assertStructure(report, "#/fixture");
});

test("an icon-only control with no label is reported", async () => {
  const report = await rejects(SOUND.replace("<button>Export CSV</button>", '<button class="icon-button"></button>'),
    /every Tab stop needs an accessible name/);
  assert.deepEqual(report.unnamed, ['<button class="icon-button">']);
});

test("aria-label, aria-labelledby, title and a associated label all count as a name", async () => {
  for (const control of ['<button aria-label="Export CSV"></button>', '<button title="Export CSV"></button>',
    '<span id="n">Export CSV</span><button aria-labelledby="n"></button>']) {
    const report = await audit(SOUND.replace("<button>Export CSV</button>", control));
    assert.deepEqual(report.unnamed, [], control);
  }
});

test("a control that looks identical focused and unfocused is reported", async () => {
  // `outline: none` with nothing put back is the real regression: the classic tidy-up that removes
  // the author ring and the browser's default one together. The resting box-shadow stays, so a
  // check that accepted "has an outline or a shadow while focused" would pass this page.
  const report = await rejects(SOUND.replace(":focus-visible { outline: 2px solid #b36; }", ":focus, :focus-visible { outline: none; }"),
    /every Tab stop needs a visible focus indicator/);
  assert.equal(report.unfocusable.length, 3);
  assert.match(report.unfocusable[0], /looks identical focused and unfocused/);
});

test("removing only the author ring still passes, because the browser draws its own", async () => {
  // Worth pinning: it is why the check is written as a resting-to-focused difference and not as
  // "some author rule matched". A page that never styled focus at all is not a failure.
  const report = await audit(SOUND.replace(":focus-visible { outline: 2px solid #b36; }", ""));
  assert.deepEqual(report.unfocusable, []);
});

test("a focus indicator that only moves the control still counts", async () => {
  // The bypass link reveals itself by sliding into view rather than by outlining.
  const report = await audit(SOUND
    .replace(":focus-visible { outline: 2px solid #b36; }", "a:focus { position: fixed; top: 8px; } button:focus-visible, input:focus-visible { outline: 2px solid #b36; }")
    .replace('<a href="#a">Runs</a>', '<a href="#a" style="position: fixed; top: -70px">Skip to content</a>'));
  assert.deepEqual(report.unfocusable, []);
});

test("skipped heading levels are reported with both ends of the jump", async () => {
  const report = await rejects(SOUND.replace("<h2>Recorded</h2>", "<h3>Recorded</h3>"),
    /heading levels must not skip/);
  assert.deepEqual(report.skipped, ['h1 "Training runs" -> h3 "Recorded"']);
});

test("a page with no h1, or with two, is reported", async () => {
  await rejects(SOUND.replace("<h1>Training runs</h1>", "<h2>Training runs</h2>"), /needs exactly one h1/);
  await rejects(SOUND.replace("<h1>Training runs</h1>", "<h1>Training runs</h1><h1>Again</h1>"), /needs exactly one h1/);
});

test("a positive tabindex is reported", async () => {
  const report = await rejects(SOUND.replace("<button>Export CSV</button>", '<button tabindex="3">Export CSV</button>'),
    /a positive tabindex reorders Tab/);
  assert.equal(report.positiveTabindex.length, 1);
  // tabindex="-1" and tabindex="0" are both legitimate and must not be flagged.
  for (const value of ["-1", "0"]) {
    const fine = await audit(SOUND.replace("<button>Export CSV</button>", `<button tabindex="${value}">Export CSV</button>`));
    assert.deepEqual(fine.positiveTabindex, [], value);
  }
});

test("a Tab stop inside content hidden from assistive technology is reported", async () => {
  for (const attribute of ['aria-hidden="true"', "inert"]) {
    const report = await audit(SOUND.replace("<main>", `<main><section ${attribute}><button>Restore backup</button></section>`));
    assert.ok(report.buried.length, attribute);
    assert.throws(() => assertStructure(report, "#/fixture"), /hidden from assistive technology is still a Tab stop/, attribute);
  }
});

test("an unnamed nav landmark and a missing or duplicated main are reported", async () => {
  await rejects(SOUND.replace('<nav aria-label="Workspace">', "<nav>"), /every nav landmark needs a name/);
  await rejects(SOUND.replace("<main>", "<main><main>").replace("</main>", "</main></main>"), /exactly one main landmark/);
  // aria-labelledby names a nav just as well as aria-label.
  const named = await audit(SOUND.replace('<nav aria-label="Workspace">', '<h2 id="navname" hidden>Workspace</h2><nav aria-labelledby="navname">'));
  assert.equal(named.unlabelledNav, 0);
});

test("hidden headings and disabled or hidden controls are left out of the audit", async () => {
  // A disabled button is not a Tab stop, and a display:none heading is not in the outline. Counting
  // either would make the sweep fail on pages that are actually correct.
  const report = await audit(SOUND
    .replace("<h2>Recorded</h2>", '<h2>Recorded</h2><h4 style="display:none">Hidden</h4>')
    .replace("<button>Export CSV</button>", '<button>Export CSV</button><button disabled></button>'));
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.unnamed, []);
  assertStructure(report, "#/fixture");
});
