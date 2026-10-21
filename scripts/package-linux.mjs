import { build, Platform, Arch } from "electron-builder";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { prepareElectronApplication } from "./prepare-electron.mjs";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux x64 releases on a Linux x64 machine.");
// rpm needs rpmbuild and pacman needs bsdtar; OMARKIE_LINUX_TARGETS narrows the set on hosts without them.
const outputs = {
  deb: `Omarkie-${pkg.version}-linux-x64.deb`,
  AppImage: `Omarkie-${pkg.version}-linux-x64.AppImage`,
  rpm: `omarkie-${pkg.version}-1.x86_64.rpm`,
  pacman: `omarkie-${pkg.version}-1-x86_64.pkg.tar.zst`,
};
const targets = (process.env.OMARKIE_LINUX_TARGETS || Object.keys(outputs).join(",")).split(",").map(target => target.trim()).filter(Boolean);
for (const target of targets) if (!outputs[target]) throw new Error(`Unknown Linux target: ${target}`);
const application = await prepareElectronApplication("linux");
await build({
  targets: Platform.LINUX.createTarget(targets, Arch.x64),
  publish: "never",
  config: {
    appId: pkg.build.appId, productName: pkg.build.productName,
    directories: { app: application, output: "release/linux" },
    files: ["**/*"], asar: true, npmRebuild: false,
    electronVersion: pkg.devDependencies.electron,
    linux: {
      executableName: "omarkie", icon: "build/icon.png", category: "Office",
      artifactName: "Omarkie-${version}-linux-x64.${ext}",
      maintainer: "gafgpt-cmd <239689105+gafgpt-cmd@users.noreply.github.com>",
      mimeTypes: ["text/markdown", "text/x-markdown"],
      syncDesktopName: true,
    },
    rpm: { artifactName: outputs.rpm },
    // electron-builder's default Arch list names packages Arch no longer ships (http-parser, libappindicator-gtk3).
    pacman: { artifactName: outputs.pacman, synopsis: pkg.description, compression: "zstd", depends: ["gtk3", "nss", "alsa-lib", "libxss", "libxtst", "xdg-utils", "at-spi2-core", "libdrm", "mesa", "libsecret", "libnotify", "libcups"] },
  },
});
const names = targets.map(target => outputs[target]);
const sums = [];
for (const name of names) {
  const bytes = await readFile(path.join("release/linux", name));
  if (bytes.length < 1024 * 1024) throw new Error(`Unexpectedly small Linux package: ${name}`);
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
}
await writeFile("release/linux/SHA256SUMS-linux-x64.txt", sums.join("\n") + "\n");
for (const name of await readdir("release/linux")) {
  if (/^(?:Omarkie-\d[\w.-]*\.(?:deb|AppImage)|omarkie-\d[\w.-]*\.(?:x86_64\.rpm|pkg\.tar\.zst))$/.test(name) && !names.includes(name)) await rm(path.join("release/linux", name));
}
console.log(sums.join("\n"));
