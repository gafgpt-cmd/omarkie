import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { licenseNotices } from "./license-notices.mjs";
import { spellcheckDictionaries } from "./spellcheck-dictionaries.mjs";
import { archPkgver, describeBuild } from "./arch-electron.mjs";

// Folders the Electron host reads at runtime, at the same relative paths as in the repository.
export const applicationFolders = ["dist", "electron", "shared", "docs/showcase", "third-party/csl", "skills/omarkie-tutor"];
export const nodeBridgeModules = ["iconv-lite", "safer-buffer", "i18next", "image-size", "yaml", "koffi", "@toon-format/toon", "@parcel/watcher", "detect-libc", "is-glob", "is-extglob", "picomatch",
  "markdown-it", "markdown-it-task-lists", "markdown-it-mark", "markdown-it-sub", "markdown-it-sup", "markdown-it-emoji",
  // shared/*.mjs runs in the main process as well: ink, SRS, sync, maths and styling need their modules.
  "perfect-freehand", "ts-fsrs", "isomorphic-git", "mathjs",
  "entities", "linkify-it", "mdurl", "punycode.js", "uc.micro"];
export const nativeBridgeModule = (platform = process.platform, arch = process.arch) => `@koromix/koffi-${platform === "windows" ? "win32" : platform}-${arch}`;
export const watcherBridgeModule = (platform = process.platform, arch = process.arch) => {
  if (platform === "linux") {
    const glibc = !!process.report?.getReport?.()?.header?.glibcVersionRuntime;
    return `@parcel/watcher-linux-${arch}-${glibc ? "glibc" : "musl"}`;
  }
  return `@parcel/watcher-${platform === "windows" ? "win32" : platform}-${arch}`;
};
// A bridge module brings its own runtime dependencies: ts-fsrs pulls the spaced-repetition kit,
// markdown-it pulls linkify and friends. The lockfile knows the tree; copy the hoisted packages.
function bridgeClosure(roots) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const packages = lock.packages ?? {};
  const seen = new Set();
  const pending = roots.map(name => `node_modules/${name}`);
  while (pending.length) {
    const at = pending.pop();
    const entry = packages[at];
    if (!entry || seen.has(at)) continue;
    seen.add(at);
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      const nested = `${at}/node_modules/${dep}`;
      pending.push(packages[nested] ? nested : `node_modules/${dep}`);
    }
  }
  return [...seen]
    .filter(at => !at.includes("/node_modules/") || at.startsWith("node_modules/"))
    .map(at => at.replace(/^node_modules\//u, ""))
    .filter(name => !name.includes("/node_modules/"));
}

// Ship Node bridge dependencies; Vite bundles the editor.
export async function prepareElectronApplication(platform, application = path.resolve(`build/${platform}-app`)) {
  await rm(application, { recursive: true, force: true });
  await mkdir(application, { recursive: true });
  for (const folder of applicationFolders) await cp(folder, path.join(application, folder), { recursive: true });
  const index = path.join(application, "dist/index.html");
  await writeFile(index, (await readFile(index, "utf8")).replace('name="omarkie-build" content="dev"', `name="omarkie-build" content="${archPkgver(pkg.version, describeBuild(pkg.version))}"`));
  for (const name of bridgeClosure([...nodeBridgeModules, nativeBridgeModule(platform), watcherBridgeModule(platform)])) {
    await cp(`node_modules/${name}`, path.join(application, "node_modules", name), { recursive: true });
  }
  await cp("LICENSE", path.join(application, "LICENSE"));
  await cp("build/icon.png", path.join(application, "icon.png"));
  await licenseNotices(path.join(application, "ThirdPartyLicenses"));
  await cp("third-party/typora-plugins", path.join(application, "ThirdPartyLicenses/typora-plugins"), { recursive: true });
  await spellcheckDictionaries(path.join(application, "dictionaries"), path.join(application, "ThirdPartyLicenses/hunspell-dictionaries"));
  await writeFile(path.join(application, "package.json"), JSON.stringify({
    name: pkg.name, version: pkg.version, description: pkg.description,
    main: pkg.main, type: "module", license: pkg.license, author: pkg.author,
    ...(platform === "linux" ? { desktopName: "omarkie.desktop" } : {}),
    homepage: pkg.homepage, dependencies: Object.fromEntries([
      ...nodeBridgeModules.filter(name => pkg.dependencies[name]).map(name => [name, pkg.dependencies[name]]),
      [nativeBridgeModule(platform), pkg.dependencies.koffi],
      [watcherBridgeModule(platform), pkg.dependencies["@parcel/watcher"]],
    ]),
  }, null, 2));
  return application;
}
