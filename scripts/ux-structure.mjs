import assert from "node:assert/strict";

// A screen-reader and keyboard-only user navigates by structure, not by sight: heading level to
// heading level, Tab stop to Tab stop, landmark to landmark. Every check here stands in for a
// specific thing a human pass reports — an unnamed button read as "button", a heading level that
// skips so the page title leads nowhere, a Tab stop with no visible ring, a control stranded inside
// content hidden from assistive technology. None of them change a pixel, so no contrast, layout or
// screenshot assertion notices when one breaks.
//
// This lives in its own module so `tests/ux-structure.test.js` can drive it against pages built to
// contain each defect. Proving it inside the full gate is not possible: earlier assertions in
// scripts/verify-ux.mjs fail first on any app-wide mutation, so a passing gate would say nothing
// about whether these checks have teeth.

export function auditStructure(page) {
  return page.evaluate(() => {
    const focusable = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    const visible = (element) => element.checkVisibility() && !element.disabled;
    const describe = (element) => {
      const classes = typeof element.className === "string" && element.className.trim();
      return `<${element.tagName.toLowerCase()}${element.id ? ` id="${element.id}"` : ""}${classes ? ` class="${classes}"` : ""}>`;
    };
    // Deliberately generous: anything a screen reader could plausibly announce counts as a name, so
    // a failure here means the control really would be read as a bare role.
    const accessibleName = (element) => {
      const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "").join(" ");
      return (element.getAttribute("aria-label") || labelledBy || element.getAttribute("title") ||
        [...(element.labels || [])].map((label) => label.textContent).join(" ") ||
        element.textContent || element.value || "").replace(/\s+/g, " ").trim();
    };
    const controls = [...document.querySelectorAll(focusable)].filter(visible);
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((element) => element.checkVisibility())
      .map((element) => ({ level: Number(element.tagName[1]), text: element.textContent.replace(/\s+/g, " ").trim().slice(0, 60) }));
    const skipped = headings.slice(1)
      .map((heading, index) => ({ heading, previous: headings[index] }))
      .filter(({ heading, previous }) => heading.level - previous.level > 1)
      .map(({ heading, previous }) => `h${previous.level} "${previous.text}" -> h${heading.level} "${heading.text}"`);
    // Focusing each control is the only way to read the style the browser will actually paint for
    // it; a rule declared elsewhere in the sheet proves nothing about this element. The indicator
    // has to be a *difference* between the resting and focused paint — these controls carry a
    // permanent box-shadow, so "has an outline or a shadow while focused" is satisfied by the
    // resting elevation alone and would pass with every focus ring deleted. `top` and `transform`
    // are included because the bypass link reveals itself by moving rather than by outlining.
    const paint = (element) => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow,
        style.borderColor, style.backgroundColor, style.color, style.top, style.transform,
        style.textDecorationLine].join(" | ");
    };
    const previous = document.activeElement;
    const unfocusable = [];
    for (const element of controls) {
      const resting = paint(element);
      element.focus();
      if (document.activeElement !== element) { unfocusable.push(`${describe(element)} refused focus`); continue; }
      if (paint(element) === resting) unfocusable.push(`${describe(element)} looks identical focused and unfocused`);
      element.blur();
    }
    previous?.focus?.();
    return {
      controls: controls.length,
      unnamed: controls.filter((element) => !accessibleName(element)).map(describe),
      positiveTabindex: [...document.querySelectorAll("[tabindex]")].filter((element) => element.tabIndex > 0).map(describe),
      buried: controls.filter((element) => element.closest('[aria-hidden="true"]') || element.closest("[inert]")).map(describe),
      unfocusable, headings, skipped,
      h1: headings.filter((heading) => heading.level === 1).length,
      mains: document.querySelectorAll("main").length,
      unlabelledNav: [...document.querySelectorAll("nav")]
        .filter((element) => !element.getAttribute("aria-label") && !element.getAttribute("aria-labelledby")).length,
    };
  });
}

export function assertStructure(report, label) {
  assert.ok(report.controls > 0, `${label}: no keyboard-reachable controls`);
  assert.deepEqual(report.unnamed, [], `${label}: every Tab stop needs an accessible name`);
  assert.deepEqual(report.positiveTabindex, [], `${label}: a positive tabindex reorders Tab away from the visual order`);
  assert.deepEqual(report.buried, [], `${label}: a control hidden from assistive technology is still a Tab stop`);
  assert.deepEqual(report.unfocusable, [], `${label}: every Tab stop needs a visible focus indicator`);
  assert.deepEqual(report.skipped, [], `${label}: heading levels must not skip, or heading navigation lands nowhere`);
  assert.equal(report.h1, 1, `${label}: needs exactly one h1 to name the page: ${JSON.stringify(report.headings)}`);
  assert.equal(report.mains, 1, `${label}: needs exactly one main landmark`);
  assert.equal(report.unlabelledNav, 0, `${label}: every nav landmark needs a name to tell it from the others`);
}
