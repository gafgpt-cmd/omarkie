// Without a window manager (Xvfb, nested X) Chromium sizes new windows to their minimum, which collapses the sidebar.
export async function fullSize(application, page) {
  if (await page.evaluate(() => innerWidth > 760)) return;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1380, height: 960 }));
  await page.reload();
}
