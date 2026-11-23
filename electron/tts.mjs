import { spawn } from "node:child_process";
import { hookArguments } from "./cli-hook.mjs";
import { t } from "./i18n.mjs";

export function speak(configured, text, signal) {
  if (signal.aborted) return;
  const argv = hookArguments(configured);
  if (!argv) throw new Error(t("朗读设置无效：请检查 OMARKIE_TTS。"));
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, signal, killSignal: "SIGKILL" });
    let failure;
    child.on("error", error => { failure = error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.once("close", code => {
      if (signal.aborted || code === 0 && !failure) resolve();
      else if (["ENOENT", "EACCES", "EPERM"].includes(failure?.code)) reject(new Error(t("无法启动朗读程序：请检查 OMARKIE_TTS。")));
      else reject(new Error(t("朗读程序未能完成播放。")));
    });
    child.stdin.end(text, "utf8");
  });
}
