import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Run the shipped launcher against an isolated pacman database and runtime executables.
const linux = process.platform === "linux";
async function sandbox({ local = "", installed = [], sync = "electron47" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-launcher-")), log = path.join(root, "calls.log");
  const executable = async (name, body) => { const file = path.join(root, name); await writeFile(file, `#!/usr/bin/bash\n${body}`, { mode: 0o755 }); };
  const stub = (name, body = "") => executable(name, `printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n${body}`);
  await executable("pacman", `case "$*" in
    "-Qi obsidian") ${local ? `printf 'Depends On      : bash  %s\\n' '${local}'` : "exit 1"} ;;
    "-Qq") printf '%s\\n' ${installed.join(" ")} ;;
    "-Si obsidian") ${sync ? `printf 'Depends On      : bash  %s\\n' '${sync}'` : "exit 1"} ;;
    *) exit 1 ;;
  esac`);
  const launcher = path.join(root, "omarkie");
  await writeFile(launcher, await readFile(new URL("../packaging/arch/omarkie", import.meta.url)), { mode: 0o755 });
  const run = (args = []) => spawnSync(launcher, args, { env: { PATH: root, HOME: root }, encoding: "utf8", timeout: 5000 });
  return { root, stub, run, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean), done: () => rm(root, { recursive: true, force: true }) };
}

test("launcher prefers Obsidian's installed Electron over a newer series", { skip: !linux }, async () => {
  const box = await sandbox({ local: "electron43>=43.8", installed: ["electron39", "electron43", "electron44"] });
  try {
    for (const series of ["electron39", "electron43", "electron44"]) await box.stub(series);
    const result = box.run(["notes/My file.md"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await box.calls(), ["electron43 /usr/lib/omarkie/app.asar notes/My file.md"]);
  } finally { await box.done(); }
});

test("without a usable Obsidian runtime the newest supported, runnable installed series wins", { skip: !linux }, async () => {
  for (const local of ["", "electron39", "electron49"]) {
    const box = await sandbox({ local, installed: ["electron", "electron100", "electron39", "electron43", "electron49", "electron102"] });
    try {
      for (const series of ["electron", "electron39", "electron43", "electron100"]) await box.stub(series);
      const result = box.run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await box.calls(), ["electron100 /usr/lib/omarkie/app.asar"]);
    } finally { await box.done(); }
  }
});

test("launched from the desktop without Electron: loud error, critical notification, terminal that installs it", { skip: !linux }, async () => {
  const box = await sandbox({ installed: ["electron39"], sync: "electron48" });
  try {
    await box.stub("electron39"); await box.stub("notify-send"); await box.stub("xdg-terminal-exec");
    const result = box.run(["a b.md"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Omarkie cannot start: the electron48 package is not installed/);
    assert.match(result.stderr, /sudo pacman -S --needed electron48/);
    const [notify, terminal] = await box.calls();
    assert.match(notify, /^notify-send --urgency=critical --app-name=Omarkie Omarkie cannot start/);
    assert.match(notify, /A terminal is opening to install it/);
    assert.match(terminal, /^xdg-terminal-exec bash -c if sudo pacman -S --needed electron48; then setsid -f omarkie a\\ b\.md {2}<\/dev\/null >\/dev\/null 2>&1;/);
  } finally { await box.done(); }
});

test("from the desktop without a terminal launcher the notification carries the install command", { skip: !linux }, async () => {
  const box = await sandbox();
  try {
    await box.stub("notify-send");
    const result = box.run();
    assert.equal(result.status, 1);
    const calls = await box.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Install it with: sudo pacman -S --needed electron47$/);
    assert.doesNotMatch(calls[0], /terminal/);
  } finally { await box.done(); }
});

test("unavailable or unsupported sync metadata never yields a guessed install offer", { skip: !linux }, async () => {
  for (const sync of ["", "electron42"]) {
    const box = await sandbox({ sync });
    try {
      await box.stub("notify-send"); await box.stub("xdg-terminal-exec");
      const result = box.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no supported Electron series for Obsidian/);
      assert.doesNotMatch(result.stderr, /pacman -S/);
      const calls = await box.calls();
      assert.equal(calls.length, 1);
      assert.match(calls[0], /^notify-send /);
    } finally { await box.done(); }
  }
});

test("in a terminal it runs the pacman install itself, then starts Omarkie", { skip: !linux || spawnSync("/usr/bin/script", ["--version"]).status !== 0 }, async () => {
  const box = await sandbox({ sync: "electron46" });
  try {
    // The sudo stub plays pacman: it "installs" the Electron stub, which the launcher then runs.
    await box.stub("sudo", `printf '#!/usr/bin/bash\\nprintf "%%s %%s\\\\n" electron46 "$*" >> ${path.join(box.root, "calls.log")}\\n' > ${path.join(box.root, "electron46")}; /usr/bin/chmod +x ${path.join(box.root, "electron46")}`);
    const result = spawnSync("/usr/bin/script", ["-qec", `exec ${path.join(box.root, "omarkie")} x.md`, "/dev/null"], { encoding: "utf8", env: { PATH: box.root, HOME: box.root, TERM: "dumb" }, timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(await box.calls(), ["sudo pacman -S --needed electron46", "electron46 /usr/lib/omarkie/app.asar x.md"]);
  } finally { await box.done(); }
});
