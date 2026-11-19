import { getSystemErrorName } from "node:util";
import path from "node:path";
import { t } from "./i18n.mjs";
const windows = process.platform === "win32", mac = process.platform === "darwin";
let binding;
export async function moveExclusive(from, to) {
  binding ??= import("koffi").then(({ default: koffi }) => {
    const library = koffi.load(windows ? "kernel32.dll" : null);
    const move = windows ? library.func("int __stdcall MoveFileExW(str16 from, str16 to, uint32 flags)") : mac ? library.func("int renamex_np(str from, str to, uint flags)") : library.func("int renameat2(int fromfd, str from, int tofd, str to, uint flags)");
    return { move, lastError: windows ? library.func("uint32 __stdcall GetLastError()") : koffi.errno };
  });
  const { move, lastError } = await binding;
  const result = windows ? move(path.toNamespacedPath(from), path.toNamespacedPath(to), 0) : mac ? move(from, to, 4) : move(-100, from, -100, to, 1);
  if (windows ? result !== 0 : result === 0) return;
  const number = lastError(), code = windows ? [80, 183].includes(number) ? "EEXIST" : "WIN32_" + number : getSystemErrorName(-number);
  throw Object.assign(new Error(code === "EEXIST" ? t("目标已存在，未覆盖任何文件。") : t("文件操作无效。") + " (" + code + ")"), { code, errno: number, path: from, dest: to });
}
