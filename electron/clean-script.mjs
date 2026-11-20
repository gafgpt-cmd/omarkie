import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { t } from "./i18n.mjs";
import { hookArguments } from "./cli-hook.mjs";

const exec = promisify(execFile);
const passes = "1,2,3,4,5,6,7";
const maxBytes = 20 * 1024 * 1024;

export async function runCleanScript(body, configured = process.env.OMARKIE_CLEAN_SCRIPT) {
  if (typeof body !== "string" || Buffer.byteLength(body) > maxBytes) throw new Error(t("文件内容无效或超过 20 MB。"));
  if (!configured) return null;
  const argv = hookArguments(configured);
  if (!argv) {
    throw new Error(t("清理脚本设置无效。"));
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "omarkie-clean-"));
  const file = path.join(scratch, "source.md"), report = path.join(scratch, "report.json");
  try {
    await writeFile(file, body, { mode: 0o600 });
    await exec(argv[0], [...argv.slice(1), file, "--passes", passes, "--report", report], {
      timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const [result] = JSON.parse(await readFile(report, "utf8"));
    if (passes.split(",").some(number => result?.passes?.[`p0${number}`]?.status !== "ok")) throw new Error();
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) throw new Error();
    const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file));
    if (!output.trim() && body.trim()) throw new Error();
    return output;
  } catch {
    // Child diagnostics may include lines of the source.
    throw new Error(t("清理脚本失败。文档未更改。"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
