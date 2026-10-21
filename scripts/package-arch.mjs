import { createPackage } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { prepareElectronApplication } from "./prepare-electron.mjs";

// An Arch package that runs on the distribution's shared Electron instead of bundling Chromium.
if (process.platform !== "linux") throw new Error("Build the Arch package on Linux.");
const electron = `electron${pkg.devDependencies.electron.split(".")[0]}`;
const work = path.resolve("release/arch"), sources = path.join(work, "src");
await rm(work, { recursive: true, force: true });
await mkdir(sources, { recursive: true });

const application = await prepareElectronApplication("linux");
await createPackage(application, path.join(sources, "app.asar"));
execFileSync("bsdtar", ["-cf", path.join(sources, "ThirdPartyLicenses.tar"), "-C", path.join(application, "ThirdPartyLicenses"), "."]);
await copyFile("LICENSE", path.join(sources, "LICENSE"));
await copyFile("build/icon.png", path.join(sources, "omarkie.png"));
await copyFile("packaging/arch/omarkie.desktop", path.join(sources, "omarkie.desktop"));
const fill = text => text.replaceAll("@VERSION@", pkg.version).replaceAll("@ELECTRON@", electron).replaceAll("@DESCRIPTION@", pkg.description.replaceAll('"', "'"));
await writeFile(path.join(sources, "omarkie"), fill(await readFile("packaging/arch/omarkie", "utf8")), { mode: 0o755 });
await writeFile(path.join(sources, "PKGBUILD"), fill(await readFile("packaging/arch/PKGBUILD", "utf8")));

// -d: the shared Electron is a runtime dependency only, not needed to build.
execFileSync("makepkg", ["--force", "--nodeps", "--noconfirm", "--cleanbuild"], { cwd: sources, stdio: "inherit", env: { ...process.env, PKGDEST: work, PKGEXT: ".pkg.tar.zst" } });

const name = (await readdir(work)).find(file => file.endsWith(".pkg.tar.zst"));
if (!name) throw new Error("makepkg produced no package");
const file = path.join(work, name), listing = execFileSync("bsdtar", ["-tf", file], { encoding: "utf8" });
for (const entry of ["usr/bin/omarkie", "usr/lib/omarkie/app.asar", "usr/share/applications/omarkie.desktop", "usr/share/licenses/omarkie/LICENSE"])
  if (!listing.split("\n").includes(entry)) throw new Error(`Arch package lacks ${entry}`);
const info = execFileSync("bsdtar", ["-xOf", file, ".PKGINFO"], { encoding: "utf8" });
if (!info.includes(`depend = ${electron}\n`)) throw new Error(`Arch package does not depend on ${electron}`);
const sum = `${createHash("sha256").update(await readFile(file)).digest("hex")}  ${name}`;
await writeFile(path.join(work, "SHA256SUMS-arch.txt"), sum + "\n");
console.log(sum);
