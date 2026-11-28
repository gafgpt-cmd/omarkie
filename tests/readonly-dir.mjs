import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function lockDirectory(directory, mode = 0o500) {
  if (process.platform === "win32") {
    // Deny specific write rights without SYNCHRONIZE (bundled in generic W), so reads and realpath still work.
    await execFileAsync("icacls", [directory, "/deny", "*S-1-1-0:(CI)(WD,AD,WEA,WA)"], { windowsHide: true });
    return;
  }
  await chmod(directory, mode);
}

export async function unlockDirectory(directory, mode = 0o700) {
  if (process.platform === "win32") {
    await execFileAsync("icacls", [directory, "/remove:d", "*S-1-1-0"], { windowsHide: true });
    return;
  }
  await chmod(directory, mode);
}
