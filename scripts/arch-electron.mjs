import { execFileSync } from "node:child_process";

// pkgver of the Arch package. At the release tag it is the plain version; a build N commits past it
// is `<version>.r<N>.g<hash>`, which pacman sorts as newer, so `pacman -Q omarkie` names the build.
export function archPkgver(version, describe) {
  const revision = describe.trim(), match = /^v(.+)-(\d+)-g([0-9a-f]+)$/.exec(revision);
  if (match) return match[1] === version && match[2] === "0" ? version : `${version}.r${match[2]}.g${match[3]}`;
  return /^[0-9a-f]{4,40}$/.test(revision) ? `${version}.r0.g${revision}` : version;
}
export function describeBuild(version) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  try { return execFileSync("git", ["describe", "--tags", "--long", "--match", `v${version}`], options); }
  catch {
    try { return execFileSync("git", ["describe", "--tags", "--long", "--always"], options); }
    catch { return ""; }
  }
}
