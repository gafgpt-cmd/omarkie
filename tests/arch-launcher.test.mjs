import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Runs the real /usr/bin/omarkie launcher against stub programs; every stub logs how it was called.
const linux = process.platform === "linux";
async function sandbox(electron) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-launcher-")), log = path.join(root, "calls.log");
  const stub = async (name, body = "") => { const file = path.join(root, name); await writeFile(file, `#!/usr/bin/bash\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n${body}`); await chmod(file, 0o755); };
  const launcher = path.join(root, "omarkie");
  await writeFile(launcher, (await readFile(new URL("../packaging/arch/omarkie", import.meta.url), "utf8")).replaceAll("@ELECTRON@", electron), { mode: 0o755 });
  const run = (args = [], extra = {}) => spawnSync("bash", [launcher, ...args], { env: { PATH: `${root}:/usr/bin:/bin`, HOME: root }, encoding: "utf8", ...extra });
  return { root, stub, run, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean), done: () => rm(root, { recursive: true, force: true }) };
}

test("launcher hands the app and the user's files to the shared Electron", { skip: !linux }, async () => {
  const box = await sandbox("electron-stub-present");
  try {
    await box.stub("electron-stub-present");
    const result = box.run(["notes/My file.md"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await box.calls(), ["electron-stub-present /usr/lib/omarkie/app.asar notes/My file.md"]);
  } finally { await box.done(); }
});

test("launched from the desktop without Electron: loud error, critical notification, terminal that installs it", { skip: !linux }, async () => {
  const box = await sandbox("electron-stub-missing");
  try {
    await box.stub("notify-send"); await box.stub("xdg-terminal-exec");
    const result = box.run(["a b.md"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.match(result.stderr, /Omarkie cannot start: the electron-stub-missing package is not installed/);
    assert.match(result.stderr, /sudo pacman -S --needed electron-stub-missing/);
    const [notify, terminal] = await box.calls();
    assert.match(notify, /^notify-send --urgency=critical --app-name=Omarkie Omarkie cannot start/);
    assert.match(terminal, /^xdg-terminal-exec bash -c if sudo pacman -S --needed electron-stub-missing; then setsid -f omarkie a\\ b\.md/);
  } finally { await box.done(); }
});

test("without a terminal launcher it still fails loudly with a non-zero exit", { skip: !linux }, async () => {
  const box = await sandbox("electron-stub-missing");
  try {
    const result = spawnSync("bash", ["-c", `PATH=${box.root}:/nonexistent exec /usr/bin/bash ${path.join(box.root, "omarkie")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { HOME: box.root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Omarkie cannot start/);
  } finally { await box.done(); }
});

test("in a terminal it runs the pacman install itself, then starts Omarkie", { skip: !linux || spawnSync("script", ["--version"]).status !== 0 }, async () => {
  const box = await sandbox("electron-stub-late");
  try {
    // The sudo stub plays pacman: it "installs" the Electron stub, which the launcher then runs.
    await box.stub("sudo", `printf '#!/usr/bin/bash\\nprintf "%%s %%s\\\\n" electron-stub-late "$*" >> ${path.join(box.root, "calls.log")}\\n' > ${path.join(box.root, "electron-stub-late")}; chmod +x ${path.join(box.root, "electron-stub-late")}`);
    const result = spawnSync("script", ["-qec", `bash ${path.join(box.root, "omarkie")} x.md`, "/dev/null"], { encoding: "utf8", env: { PATH: `${box.root}:/usr/bin:/bin`, HOME: box.root, TERM: "dumb" } });
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(await box.calls(), ["sudo pacman -S --needed electron-stub-late", "electron-stub-late /usr/lib/omarkie/app.asar x.md"]);
  } finally { await box.done(); }
});
