import { execFileSync } from "node:child_process";

// Electron series the Arch package depends on. An explicit choice wins; otherwise the newest
// series already installed (for example the one Obsidian pins) is reused, so the system keeps one
// runtime; with none installed, the recommended series Omarkie is built and tested with.
// Omarkie is smoke-tested down to Electron 43.
export const minimumElectron = 43;
export function electronSeries({ override, installed, recommended, minimum = minimumElectron }) {
  if (override) {
    const major = /^electron([1-9]\d*)$/.exec(override)?.[1];
    if (!major || Number(major) < minimum) throw new Error(`OMARKIE_ELECTRON must name electron${minimum} or newer, got ${override}`);
    return override;
  }
  const majors = installed.map(name => /^electron(\d+)$/.exec(name.trim())?.[1]).filter(Boolean).map(Number).filter(major => major >= minimum);
  return `electron${majors.length ? Math.max(...majors) : recommended}`;
}
export function installedPackages() {
  try { return execFileSync("pacman", ["-Qq"], { encoding: "utf8" }).split("\n"); } catch { return []; }
}
// pkgver of the Arch package. At the release tag it is the plain version; a build N commits past it
// is `<version>.r<N>.g<hash>`, which pacman sorts as newer, so `pacman -Q omarkie` names the build.
export function archPkgver(version, describe) {
  const match = /^v(.+)-(\d+)-g([0-9a-f]+)$/.exec(describe.trim());
  return match && match[1] === version && match[2] !== "0" ? `${version}.r${match[2]}.g${match[3]}` : version;
}
export function describeBuild(version) {
  try { return execFileSync("git", ["describe", "--tags", "--long", "--match", `v${version}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
}
