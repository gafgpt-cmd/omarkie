import { readFile } from "node:fs/promises";
import path from "node:path";

// Waits below return on an app signal (first note painted, Glass settled, a save landing on disk).
// The ceiling is only a failure guard for a signal that never comes, never the expected duration.
export const ceiling = 60_000;

const snapshot = async application => application.evaluate(() => globalThis.omarkieReadiness.snapshot());
const changed = async (application, version, ms) => application.evaluate((_, [version, ms]) => globalThis.omarkieReadiness.changed(version, ms), [version, ms]);
const paintedAt = async page => page.evaluate(() => {
  const mark = performance.getEntriesByName("omarkie:first-document-painted")[0];
  return mark ? Math.round(mark.startTime) : null;
});

async function until(application, goal, check) {
  const deadline = Date.now() + ceiling;
  let state = await snapshot(application);
  for (;;) {
    if (await check(state)) return state;
    if (Date.now() >= deadline) throw new Error(`${goal}: no app signal in ${ceiling} ms; readiness ${JSON.stringify(state)}`);
    // Each save, dirty flip and Glass step wakes this; the short cap re-reads disk changes made outside a save.
    state = await changed(application, state.version, Math.min(1000, deadline - Date.now()));
  }
}

// The first document painted and Glass startup settled (ready, failed or off): the app is idle and usable.
export async function appReady(application, page) {
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0, null, { timeout: ceiling });
  return until(application, "Glass startup", state => state.glass !== "starting");
}

// The file matches `expected` (exact text or a predicate) once the app's save reached disk; returns the file text.
// A save failure while waiting fails at once with its error.
export async function saved(application, file, expected) {
  const start = await snapshot(application), matches = typeof expected === "function" ? expected : text => text === expected;
  let disk;
  try {
    await until(application, `save of ${path.basename(file)}`, async state => {
      if (state.saveFailures > start.saveFailures) throw new Error(`Save failed: ${state.lastSaveError}`);
      disk = await readFile(file, "utf8").catch(error => `<${error.code}>`);
      return matches(disk);
    });
  } catch (error) {
    error.message += `\nexpected ${typeof expected === "function" ? expected.toString() : JSON.stringify(expected)}\non disk  ${JSON.stringify(disk)}`;
    throw error;
  }
  return disk;
}

// Resolves on the photo's own load event; a src switch to its screen-size preview fires load again.
export async function photoDecoded(image) {
  await image.waitFor({ timeout: ceiling });
  await image.evaluate((element, ms) => new Promise((resolve, reject) => {
    const decoded = () => element.complete && element.naturalWidth > 0;
    if (decoded()) return resolve();
    const timer = setTimeout(() => reject(new Error(`photo not decoded in ${ms} ms: ${element.currentSrc} complete=${element.complete}`)), ms);
    element.addEventListener("load", function loaded() {
      if (!decoded()) return;
      clearTimeout(timer); element.removeEventListener("load", loaded); resolve();
    });
  }), ceiling);
}

// App state at a failure: readiness, first paint time and visible alerts.
export async function readinessReport(application, page) {
  const report = {};
  report.readiness = await snapshot(application).catch(error => `unavailable: ${error.message}`);
  report.firstNotePaintedMs = await paintedAt(page).catch(() => null);
  report.alerts = await page?.getByRole("alert").allTextContents().catch(() => []);
  return report;
}
