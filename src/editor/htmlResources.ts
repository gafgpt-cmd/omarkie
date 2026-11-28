import createDOMPurify, { type Config, type DOMPurify } from "dompurify";
export const bundledImageUrls = new Map<string, string>();
export const normalizedURL = (value: string) => value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
export const remoteURL = (value: string) => /^(?:https?:|[/\\]{2})/i.test(normalizedURL(value));
// One purifier per config, configured once: parsing the config on every call cost ~1 ms per block
// on a cold renderer, and the rich editor sanitizes every block of the first document.
// Callers pass module-level config constants, never per-call literals.
const mediaPurifiers = new WeakMap<Config, DOMPurify>();
export function sanitizeDocumentMedia(html: string, config: Config) {
  let purifier = mediaPurifiers.get(config);
  if (!purifier) {
    purifier = createDOMPurify(window);
    purifier.addHook("uponSanitizeAttribute", (node, attribute) => {
      const source = attribute.attrName === "src" && /^(?:img|video|audio|source)$/.test(node.localName);
      const poster = attribute.attrName === "poster" && node.localName === "video";
      const candidates = attribute.attrName === "srcset" && /^(?:img|source)$/.test(node.localName);
      const url = normalizedURL(attribute.attrValue);
      if (node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
          ((source && /^data:(?:video|audio)\//i.test(url)) ||
           ((source || poster || candidates) && /^(?:blob:|data:image\/|omarkie(?:-asset)?:)/i.test(url)))) {
        attribute.forceKeepAttr = true;
      }
    });
    purifier.setConfig(config);
    mediaPurifiers.set(config, purifier);
  }
  return purifier.sanitize(html);
}
// Keep the normal safe link protocols plus this app's document-scoped media
// scheme. File URLs are rewritten before sanitization, never enabled globally.
const allowedURI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|omarkie-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
const htmlConfig = (block: boolean): Config => ({ ALLOW_DATA_ATTR: false, FORBID_ATTR: ["contenteditable"], ALLOWED_URI_REGEXP: allowedURI, ADD_TAGS: ["video", "audio", "source", ...(block ? ["iframe"] : [])], ADD_ATTR: ["controls", ...(block ? ["allowfullscreen", "sandbox"] : [])] });
const blockHtml = htmlConfig(true), inlineHtml = htmlConfig(false);
export function safeDocumentHtml(html: string, documentId?: string, block = true) {
  const template = document.createElement("template"); template.innerHTML = html;
  if (documentId) for (const element of template.content.querySelectorAll("img,video,audio,source")) {
    const source = element.getAttribute("src") || "", classified = normalizedURL(source);
    if (source && !remoteURL(classified) && (!/^[a-z][a-z\d+.-]*:/i.test(classified) || /^file:/i.test(classified) || /^[a-z]:[\\/]/i.test(classified))) {
      element.setAttribute("src",`omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`);
    }
  }
  return sanitizeDocumentMedia(template.innerHTML, block ? blockHtml : inlineHtml);
}
