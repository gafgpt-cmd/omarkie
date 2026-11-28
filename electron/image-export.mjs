import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// PNG export: the portable print HTML laid out at a fixed CSS width, captured once at 1x or 2x.
// Offscreen: a hidden onscreen window never paints, so its screenshot never resolves.
export const imageWidth = 800;
const maxSide = 16384, maxPixels = 48 * 1024 * 1024;
export const imageScale = value => value === 2 ? 2 : 1;
// Checked on the measured layout, before the raster exists.
export function imageFits(height, scale) {
  const width = imageWidth * scale, pixels = Math.ceil(height * scale);
  return height > 0 && pixels <= maxSide && width * pixels <= maxPixels;
}
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
const settle = `document.fonts.ready.then(() => Promise.race([
  Promise.all([...document.images].map(image => image.decode().catch(() => {}))),
  new Promise(resolve => setTimeout(resolve, 5000)),
]))`;

export async function captureImage(html, scale, tooLarge) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "omarkie-image-")), file = path.join(folder, "export.html"), page = pathToFileURL(file).href;
  const view = new BrowserWindow({ show: false, width: imageWidth, height: 600, useContentSize: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, javascript: false, offscreen: true, partition: "image-export-" + randomUUID() } });
  try {
    view.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !(request.url === page || request.url.startsWith("data:")) }));
    view.webContents.on("will-navigate", event => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await writeFile(file, html.replace(/<head>/i, "<head>" + csp), "utf8");
    await view.loadFile(file);
    const cdp = view.webContents.debugger;
    cdp.attach("1.3");
    const metrics = height => cdp.sendCommand("Emulation.setDeviceMetricsOverride", { width: imageWidth, height, deviceScaleFactor: scale, mobile: false });
    // A 1 px viewport: the content size never floors at the viewport height.
    await metrics(1);
    await cdp.sendCommand("Emulation.setScrollbarsHidden", { hidden: true });
    await cdp.sendCommand("Runtime.evaluate", { expression: settle, awaitPromise: true });
    const height = Math.ceil((await cdp.sendCommand("Page.getLayoutMetrics")).cssContentSize.height);
    if (!imageFits(height, scale)) throw new Error(tooLarge);
    await metrics(height);
    const { data } = await cdp.sendCommand("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: imageWidth, height, scale: 1 } });
    return Buffer.from(data, "base64");
  } finally {
    view.destroy();
    await rm(folder, { recursive: true, force: true });
  }
}
