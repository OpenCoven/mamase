import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
    if (!match) throw new Error(`Contrast fixture requires opaque computed RGB colors: ${color}`);
    const [r, g, b] = match.slice(1).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export async function writeFailureEvidence(directory, page, layouts) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const summary = {
    schema: "mamase.synthetic-browser-failure.v1",
    fixture: "verify-ux isolated synthetic browser context",
    layoutsCompleted: layouts,
    viewport: page && !page.isClosed() ? page.viewportSize() : null,
    screenshot: "unavailable",
    limitations: "No DOM, console, network trace, storage, cases, model files or private workspace exported.",
  };
  await writeFile(join(directory, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (page && !page.isClosed()) {
    // A CSS-resolution viewport-only image, capped, never a scrolling workspace dump.
    const image = await page.screenshot({ fullPage: false, scale: "css", timeout: 5000 });
    if (image.length <= 2 * 1024 * 1024) {
      await writeFile(join(directory, "failure.png"), image, { mode: 0o600 });
      summary.screenshot = "failure.png";
    } else summary.screenshot = "omitted: exceeds 2 MiB cap";
  }
  await writeFile(join(directory, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}
