// Without a window manager (Xvfb, nested X) Chromium sizes new windows to their minimum, which collapses the sidebar.
export async function fullSize(application, page) {
  // Tiling compositors (Hyprland) resize the window after it first maps and ignore setBounds.
  const shell = page.locator(".app-shell"); await shell.waitFor();
  if (await page.evaluate(() => innerWidth > 760)) return;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1380, height: 960 }));
  await page.reload(); await shell.waitFor();
  if (await shell.evaluate(element => element.classList.contains("sidebar-hidden"))) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
}
