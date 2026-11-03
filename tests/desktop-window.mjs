import { mkdir } from "node:fs/promises";
import path from "node:path";

export const headlessArguments = process.platform === "linux" ? ["--ozone-platform=headless"] : [];
export async function isolatedEnvironment(environment) {
  if (process.platform !== "linux") return environment;
  const directory = environment.OMARKIE_DATA_DIR;
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const isolated = { ...environment, OMARKIE_TEST_HIDDEN: environment.OMARKIE_TEST_HIDDEN ?? "1", XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state"), XDG_DATA_HOME: path.join(directory, "share") };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"]) delete isolated[key];
  return isolated;
}

// Without a window manager (Xvfb, nested X) Chromium sizes new windows to their minimum, which collapses the sidebar.
export async function fullSize(application, page) {
  // Tiling compositors (Hyprland) resize the window after it first maps and ignore setBounds.
  const shell = page.locator(".app-shell"); await shell.waitFor();
  if (await page.evaluate(() => innerWidth > 760)) return;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1380, height: 960 }));
  await page.reload(); await shell.waitFor();
  if (await shell.evaluate(element => element.classList.contains("sidebar-hidden"))) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
}
