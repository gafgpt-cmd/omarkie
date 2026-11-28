// Rows 26, 29, 30, 32, 33, 34 and 37: real FAT/exFAT/NTFS images as fake USB sticks.
// Needs root: loop devices and mounts are a root/CI capability on every OS (measured in the study, M12).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  copyTree, manifest, openService, openSync, sameGlass, scratch, vault,
} from "../lib.mjs";
import { replayJournalText } from "../../../shared/glass-core.mjs";

const skip = reason => Object.assign(new Error(reason), { skip: true });
const note = "# Map\n\nContour lines close together mean a steep slope.\n";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${command} ${args.join(" ")}: ${error.message}\n${stderr}`), { stdout, stderr, code: error.code }));
      else resolve({ stdout, stderr });
    });
  });
}

async function requireRoot() {
  if (process.getuid?.() !== 0) throw skip("needs root for loop devices and mounts; the privileged drives job runs this row");
  for (const tool of ["mkfs.vfat", "losetup", "mount", "umount"]) {
    await run("sh", ["-c", `command -v ${tool}`]).catch(() => { throw skip(`${tool} is missing on this runner`); });
  }
}

async function createImage(file, size) {
  const handle = await open(file, "w");
  try { await handle.truncate(size); } finally { await handle.close(); }
}

// One image file, attached as a loop device and mounted as if it were a stick.
class Stick {
  constructor(folder) { this.folder = folder; }
  static async create(kind) {
    const folder = await scratch(`omarkie-chaos-${kind}-`);
    const stick = new Stick(folder);
    stick.image = path.join(folder, `${kind}.img`);
    await createImage(stick.image, 96 * 1024 * 1024);
    if (kind === "vfat") await run("mkfs.vfat", ["-F", "32", stick.image]);
    else if (kind === "exfat") await run("mkfs.exfat", [stick.image]);
    else if (kind === "ntfs") await run("mkfs.ntfs", ["-F", "-Q", stick.image]);
    stick.kind = kind;
    await stick.attach();
    return stick;
  }
  async attach(point = path.join(this.folder, `mnt-${Math.random().toString(36).slice(2, 7)}`)) {
    this.mountpoint = point;
    await mkdir(point, { recursive: true });
    const { stdout } = await run("losetup", ["--show", "-f", this.image]);
    this.device = stdout.trim();
    const options = this.kind === "vfat" ? "uid=0,gid=0,umask=0000,utf8" : "uid=0,gid=0,umask=0000";
    await run("mount", ["-t", this.kind, "-o", options, this.device, point]);
    return point;
  }
  async detach({ lazy = true } = {}) {
    if (this.device) {
      await run("umount", lazy ? ["-l", this.mountpoint] : [this.mountpoint]).catch(() => {});
      await run("losetup", ["-d", this.device]).catch(() => {});
      this.device = null;
    }
  }
}

async function withStick(kind, body) {
  await requireRoot();
  const stick = await Stick.create(kind);
  try { return await body(stick); } finally { await stick.detach({ lazy: false }); }
}

async function placeVault(sourceFolder, target) {
  await mkdir(target, { recursive: true });
  await copyTree(sourceFolder, target);
  return target;
}

export const rows = [
  {
    id: 26,
    name: "the whole vault moves to a stick: same vault id, same magnets, one glass",
    async run() {
      const source = await vault({ "map.md": note, "notes/Dose.md": "# Dose\n\nUnits.\n" });
      const first = await openSync(source);
      let basis;
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-move", text: "moved pin" });
        await first.service.request({ action: "add", note: "notes/Dose.md", magnet: "m-dose", text: "dose pin" });
        await first.sync.whenIdle();
        basis = await manifest(source);
      } finally { await first.sync.close(); await first.service.close(); }

      const results = [];
      for (const kind of ["exfat", "ntfs"]) {
        results.push(await withStick(kind, async stick => {
          const onStick = await placeVault(source.folder, path.join(stick.mountpoint, "vault"));
          const moved = { root: stick.mountpoint, folder: onStick, data: source.data, cache: source.cache };
          const second = await openSync(moved);
          try {
            const after = await manifest(moved);
            assert.equal(after.vaultId, basis.vaultId, `the id travels on ${kind}`);
            assert.ok(sameGlass(basis, after), `same glass travels on ${kind}`);
            assert.deepEqual(after.journals, basis.journals);
            assert.ok(after.notes.length >= basis.notes.length);
          } finally { await second.sync.close(); await second.service.close(); }
          return { kind, vaultId: basis.vaultId };
        }));
      }
      return results;
    },
  },
  {
    id: 29,
    name: "an NFD name on the stick is one note with one glass; the NFC spelling finds it",
    async run() {
      return withStick("vfat", async stick => {
        const nfd = "Fluoroscopi\u0301a.md";
        const nfc = nfd.normalize("NFC");
        const source = await vault({});
        const body = "# Fluoroscopía\n\nDose.\n";
        const { put } = await import("../lib.mjs");
        await put(source.folder, nfd, body);
        const first = await openSync(source);
        try {
          await first.service.request({ action: "add", note: nfd, magnet: "m-accent", text: "accent pin" });
          await first.sync.whenIdle();
        } finally { await first.sync.close(); await first.service.close(); }

        const onStick = await placeVault(source.folder, path.join(stick.mountpoint, "vault"));
        const environment = { root: stick.mountpoint, folder: onStick, data: source.data, cache: source.cache };
        const second = await openSync(environment);
        try {
          await second.sync.scan("nfd");
          assert.equal(second.service.currentNotes().length, 1, "one note, not two spellings");
          assert.equal((await manifest(environment)).journals.length, 1);
          const listed = await second.service.request({ action: "list", note: nfc });
          assert.equal(listed.magnets[0].fields.text, "accent pin", "the other normalisation finds the glass");
        } finally { await second.sync.close(); await second.service.close(); }
        return { kind: "vfat", nfd: true };
      });
    },
  },
  {
    id: 30,
    name: "unplug a stick mid-write: pause and banner, replay on remount, the same vault at a new path",
    async run() {
      return withStick("vfat", async stick => {
        const folder = path.join(stick.mountpoint, "vault");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "map.md"), note);
        const environment = { root: stick.mountpoint, folder, data: path.join(stick.folder, "data"), cache: path.join(stick.folder, "cache") };
        const { service, sync } = await openSync(environment);
        let basis;
        try {
          await service.request({ action: "add", note: "map.md", magnet: "m-live", text: "before unplug" });
          await sync.whenIdle();
          basis = await manifest(environment);
          await stick.detach(); // lazy unmount, then the backing file goes away

          const unplugged = await service.request({ action: "add", note: "map.md", magnet: "m-live", text: "while unplugged" });
          assert.equal(unplugged.saved, false, "no write is claimed while the stick is gone");
          assert.ok(service.status().pending >= 1);
          assert.ok(service.status().error, "the offline banner state is set");

          // Same stick, same path: no torn line was committed while gone, then the queued op replays.
          await stick.attach(stick.mountpoint);
          const journal = path.join(folder, ".omarkie", "glass", unplugged.journal.split("/").at(-1));
          assert.equal(replayJournalText(await readFile(journal, "utf8")).invalid, 0, "no torn line was committed");
          const flushed = await service.request({ action: "flush" });
          assert.equal(flushed.pending, 0);
          assert.equal(flushed.error, null);
          assert.equal((await service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "while unplugged");
          basis = await manifest(environment);
        } finally { await sync.close(); await service.close(); }

        // Replugged under another mount point: the app still knows the vault and its glass.
        await stick.detach({ lazy: false });
        await stick.attach(path.join(stick.folder, "usb2"));
        const replugged = { root: stick.mountpoint, folder: path.join(stick.mountpoint, "vault"), data: environment.data, cache: environment.cache };
        const second = await openSync(replugged);
        try {
          const after = await manifest(replugged);
          assert.equal(after.vaultId, basis.vaultId, "recognised at the new path");
          assert.ok(sameGlass(basis, after), "the same glass, not a duplicate");
          assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets.length, 1);
        } finally { await second.sync.close(); await second.service.close(); }
        return { replayed: true, repluggedElsewhere: true };
      });
    },
  },
  {
    id: 32,
    name: "FAT name traps: reserved names and long titles fail cleanly, glass names stay portable",
    async run() {
      return withStick("vfat", async stick => {
        const folder = path.join(stick.mountpoint, "vault");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "CON.md"), "# Con\n\nCtrl.\n");
        const longName = `${"a".repeat(200)}.md`;
        await writeFile(path.join(folder, longName), "# Long\n");
        await writeFile(path.join(folder, "map.md"), note);

        // The filesystem itself refuses these; the app must fail cleanly, not write a partial journal.
        await assert.rejects(writeFile(path.join(folder, "a:b.md"), "# Colon\n"));
        await assert.rejects(writeFile(path.join(folder, `${"b".repeat(300)}.md`), "# Too long\n"));

        const environment = { root: stick.mountpoint, folder, data: path.join(stick.folder, "data"), cache: path.join(stick.folder, "cache") };
        const service = await openService(environment);
        try {
          for (const name of ["CON.md", longName, "map.md"]) {
            const added = await service.request({ action: "add", note: name, text: name });
            assert.equal(added.saved, true, `${name} was saved`);
            const file = added.journal.split("/").at(-1);
            assert.ok(Buffer.byteLength(file) <= 120, `journal name ${file.length} bytes`);
            assert.doesNotMatch(file, /[<>:"/\\|?*\u0000-\u001f]/);
            assert.ok((await lstat(path.join(folder, ".omarkie", added.journal))).isFile());
          }
          await assert.rejects(service.request({ action: "add", note: `${"b".repeat(300)}.md`, text: "nope" }), /not found|vault-relative/u);
        } finally { await service.close(); }
        return { kind: "vfat", reserved: "CON.md", longName: longName.length };
      });
    },
  },
  {
    id: 33,
    name: "a case-insensitive stick follows a case-only rename: one note, one glass",
    async run() {
      return withStick("vfat", async stick => {
        const folder = path.join(stick.mountpoint, "vault");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "Kerma.md"), "# Kerma\n\nDose units.\n");
        const environment = { root: stick.mountpoint, folder, data: path.join(stick.folder, "data"), cache: path.join(stick.folder, "cache") };
        const { service, sync } = await openSync(environment);
        try {
          assert.equal(sync.caseInsensitive, true, "the drive is detected as case-insensitive");
          const added = await service.request({ action: "add", note: "Kerma.md", text: "case pin" });
          await sync.whenIdle();
          await rename(path.join(folder, "Kerma.md"), path.join(folder, "case.tmp"));
          await rename(path.join(folder, "case.tmp"), path.join(folder, "kerma.md"));
          await sync.scan("case-rename");
          const notes = service.currentNotes();
          assert.equal(notes.length, 1, `one note, saw ${notes.length}`);
          assert.equal(notes[0].id, added.id);
          assert.equal(notes[0].path, "kerma.md", "the stored path follows the drive's spelling");
          assert.equal((await service.request({ action: "list", note: "kerma.md" })).magnets[0].fields.text, "case pin");
        } finally { await sync.close(); await service.close(); }
        return { kind: "vfat", caseOnly: true };
      });
    },
  },
  {
    id: 34,
    name: "FAT whole-second stamps: a same-size edit inside the window is decided by content",
    async run() {
      return withStick("vfat", async stick => {
        const folder = path.join(stick.mountpoint, "vault");
        await mkdir(folder, { recursive: true });
        const file = path.join(folder, "map.md");
        await writeFile(file, "# Map\n\nabcde\n");
        const environment = { root: stick.mountpoint, folder, data: path.join(stick.folder, "data"), cache: path.join(stick.folder, "cache") };
        const { service, sync } = await openSync(environment);
        try {
          await service.request({ action: "add", note: "map.md", magnet: "m-fat", text: "pin" });
          await sync.scan("first");
          const stamp = new Date(Math.floor(Date.now() / 2_000) * 2_000);
          await utimes(file, stamp, stamp);
          await sync.scan("stamped");
          const before = service.currentNotes()[0].fingerprint.hash;

          await writeFile(file, "# Map\n\nfghij\n");
          await utimes(file, stamp, stamp);
          await sync.scan("fat-edit");
          const after = service.currentNotes()[0].fingerprint.hash;
          assert.notEqual(after, before, "content, not mtime, decided the change");
          assert.equal((await sync.find({ query: "fghij" })).count, 1);
        } finally { await sync.close(); await service.close(); }
        return { kind: "vfat", contentDecided: true };
      });
    },
  },
  {
    id: 37,
    name: "a 5 GB media reference is never copied, symlinks are ignored, and FAT32 refuses the file",
    async run() {
      await requireRoot();
      // FAT32 cannot hold a 4 GB+ file at all: the app must reference media, never copy it.
      const folder = await scratch("omarkie-chaos-fat32-");
      const image = path.join(folder, "fat32.img");
      await createImage(image, 96 * 1024 * 1024);
      await run("mkfs.vfat", ["-F", "32", image]);
      const mountpoint = path.join(folder, "mnt");
      await mkdir(mountpoint, { recursive: true });
      const { stdout } = await run("losetup", ["--show", "-f", image]);
      const device = stdout.trim();
      await run("mount", ["-t", "vfat", "-o", "uid=0,gid=0,umask=0000,utf8", device, mountpoint]);
      try {
        const big = path.join(mountpoint, "big.mp4");
        const handle = await open(big, "w");
        try {
          await assert.rejects(handle.truncate(5 * 1024 * 1024 * 1024), /File too large|EFBIG/u);
        } finally { await handle.close(); }
        const vaultFolder = path.join(mountpoint, "vault");
        await mkdir(vaultFolder, { recursive: true });
        await writeFile(path.join(vaultFolder, "map.md"), "# Map\n\nSee video.\n");
        await assert.rejects(symlink("/etc/passwd", path.join(vaultFolder, "leak.md")), error => ["EPERM", "ENOSYS"].includes(error.code));
        const environment = { root: mountpoint, folder: vaultFolder, data: path.join(folder, "data"), cache: path.join(folder, "cache") };
        const { service, sync } = await openSync(environment);
        try {
          await service.request({ action: "add", note: "map.md", magnet: "m-media", text: "see also" });
          await sync.whenIdle();
          const map = await sync.map();
          assert.equal(map.files, 1);
          const store = path.join(vaultFolder, ".omarkie");
          let largest = 0;
          for (const name of await readdir(store, { recursive: true })) {
            const info = await lstat(path.join(store, String(name))).catch(() => null);
            if (info?.isFile()) largest = Math.max(largest, info.size);
          }
          assert.ok(largest < 1024 * 1024, `glass store stays small, largest file ${largest} bytes`);
        } finally { await sync.close(); await service.close(); }

        // On a symlink-capable filesystem, verify the vault still ignores symlinked notes.
        const posixVault = path.join(folder, "posix-vault");
        await mkdir(posixVault, { recursive: true });
        await writeFile(path.join(posixVault, "map.md"), "# Map\n\nSee video.\n");
        await symlink("/etc/passwd", path.join(posixVault, "leak.md"));
        const posixEnv = { root: folder, folder: posixVault, data: path.join(folder, "posix-data"), cache: path.join(folder, "posix-cache") };
        const posix = await openSync(posixEnv);
        try {
          await posix.service.request({ action: "add", note: "map.md", magnet: "m-media", text: "see also" });
          await posix.sync.whenIdle();
          assert.equal((await posix.sync.map()).files, 1, "the symlink is not a note");
        } finally { await posix.sync.close(); await posix.service.close(); }
        return { kind: "fat32", fiveGbRefused: true, symlinkIgnored: true };
      } finally {
        await run("umount", ["-l", mountpoint]).catch(() => {});
        await run("losetup", ["-d", device]).catch(() => {});
      }
    },
  },
];
