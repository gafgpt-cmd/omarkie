import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    "-S electron43") printf 'install electron43\\n' >> ${JSON.stringify(log)}; exec /usr/bin/mv "$HOME/electron43-ready" "$HOME/electron43" ;;
    *) exit 1 ;;
  esac`);
  const launcher = path.join(root, "omarkie");
  await writeFile(launcher, await readFile(new URL("../packaging/arch/omarkie", import.meta.url)), { mode: 0o755 });
  const run = (args = []) => spawnSync(launcher, args, { env: { PATH: root, HOME: root }, encoding: "utf8", timeout: 5000 });
  return { root, executable, stub, run, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean), done: () => rm(root, { recursive: true, force: true }) };
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

test("without installed Obsidian the newest supported, runnable series wins", { skip: !linux }, async () => {
  const box = await sandbox({ installed: ["electron", "electron100", "electron39", "electron43", "electron49", "electron102"] });
  try {
    for (const series of ["electron", "electron39", "electron43", "electron100"]) await box.stub(series);
    const result = box.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await box.calls(), ["electron100 /usr/lib/omarkie/app.asar"]);
  } finally { await box.done(); }
});

const hasPty = linux && spawnSync("/usr/bin/script", ["--version"]).status === 0;

async function prepareRecovery(box, file) {
  await box.executable("sudo", 'exec "$@"');
  await box.stub("electron43-ready", `[[ $# == 2 && $1 == /usr/lib/omarkie/app.asar && $2 == ${JSON.stringify(file)} ]] || exit 2\nprintf 'launched\\n' >> "$HOME/calls.log"`);
}

test("desktop recovery installs the local default and reopens the exact file", { skip: !hasPty }, async () => {
  const box = await sandbox({ local: "electron43", installed: ["electron43", "electron44"], sync: "electron48" });
  try {
    await prepareRecovery(box, "a b.md");
    await box.stub("electron44");
    await box.stub("notify-send");
    for (const name of ["bash", "setsid"]) await symlink(`/usr/bin/${name}`, path.join(box.root, name));
    await box.executable("xdg-terminal-exec", `printf -v command '%q ' "$@"\nexec /usr/bin/script -qec "exec $command" /dev/null`);
    const result = box.run(["a b.md"]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /the electron43 executable is missing/);
    let calls;
    for (let i = 0; i < 100; i++) {
      calls = await box.calls();
      if (calls.at(-1) === "launched") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(calls[0] ?? "", /^notify-send --urgency=critical .*A terminal is opening to install it/);
    assert.deepEqual(calls.slice(1), ["install electron43", "electron43-ready /usr/lib/omarkie/app.asar a b.md", "launched"], result.stdout + result.stderr);
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
    assert.match(calls[0], /Install it with: sudo pacman -S electron47$/);
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

test("in a terminal it runs the pacman install itself, then starts Omarkie", { skip: !hasPty }, async () => {
  const box = await sandbox({ local: "electron43", installed: ["electron43"], sync: "electron46" });
  try {
    await prepareRecovery(box, "x.md");
    const result = spawnSync("/usr/bin/script", ["-qec", `exec ${path.join(box.root, "omarkie")} x.md`, "/dev/null"], { encoding: "utf8", env: { PATH: box.root, HOME: box.root, TERM: "dumb" }, timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(await box.calls(), ["install electron43", "electron43-ready /usr/lib/omarkie/app.asar x.md", "launched"]);
  } finally { await box.done(); }
});
