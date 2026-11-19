import { mkdir } from "node:fs/promises";
import path from "node:path";

// Playwright injects CDPScreenshotNewSurface through its electron loader only when launching the repository app; packaged-payload launches via executablePath miss it, so pass it explicitly to match Playwright's default. The packaged-payload screenshot hang reproduced locally without it; with it ime-desktop passes unchanged against the packaged payload and captures the evidence screenshot. The tagged-run ime-desktop timeout was stuck at 'waiting for fonts to load', so the mechanism connecting this flag to that stall is unproven.
export const headlessArguments = process.platform === "linux" ? [`--ozone-platform=${process.env.OMARKIE_TEST_DISPLAY ? "x11" : "headless"}`, "--enable-features=CDPScreenshotNewSurface"] : [];
export async function isolatedEnvironment(environment) {
  if (process.platform !== "linux") return environment;
  const directory = environment.OMARKIE_DATA_DIR;
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const display = environment.OMARKIE_TEST_DISPLAY;
  const isolated = { ...environment, OMARKIE_TEST_HIDDEN: environment.OMARKIE_TEST_HIDDEN ?? (display ? "0" : "1"), XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state"), XDG_DATA_HOME: path.join(directory, "share") };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"]) delete isolated[key];
  if (display) {
    isolated.DISPLAY = display;
    if (environment.XAUTHORITY) isolated.XAUTHORITY = environment.XAUTHORITY;
  }
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
