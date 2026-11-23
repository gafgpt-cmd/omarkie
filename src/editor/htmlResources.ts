import createDOMPurify, { type Config } from "dompurify";
export const bundledImageUrls = new Map<string, string>();
export const normalizedURL = (value: string) => value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
export const remoteURL = (value: string) => /^(?:https?:|[/\\]{2})/i.test(normalizedURL(value));
let mediaPurifier: ReturnType<typeof createDOMPurify> | undefined;
export function sanitizeDocumentMedia(html: string, config: Config) {
  if (!mediaPurifier) {
    mediaPurifier = createDOMPurify(window);
    mediaPurifier.addHook("uponSanitizeAttribute", (node, attribute) => {
      if (attribute.attrName === "src" && node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
          /^(?:img|video|audio|source)$/.test(node.localName) &&
          /^(?:blob:|data:(?:image|video|audio)\/|omarkie(?:-asset)?:)/i.test(normalizedURL(attribute.attrValue))) {
        attribute.forceKeepAttr = true;
      }
    });
  }
  return mediaPurifier.sanitize(html, config);
}
// Keep the normal safe link protocols plus this app's document-scoped media
// scheme. File URLs are rewritten before sanitization, never enabled globally.
const allowedURI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|omarkie-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
export function safeDocumentHtml(html: string, documentId?: string, block = true) {
  const template = document.createElement("template"); template.innerHTML = html;
  if (documentId) for (const element of template.content.querySelectorAll("img,video,audio,source")) {
    const source = element.getAttribute("src") || "", classified = normalizedURL(source);
    if (source && !remoteURL(classified) && (!/^[a-z][a-z\d+.-]*:/i.test(classified) || /^file:/i.test(classified) || /^[a-z]:[\\/]/i.test(classified))) {
      element.setAttribute("src",`omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`);
    }
  }
  return sanitizeDocumentMedia(template.innerHTML,{ALLOW_DATA_ATTR:false,FORBID_ATTR:["contenteditable"],ALLOWED_URI_REGEXP:allowedURI,ADD_TAGS:["video","audio","source",...(block ? ["iframe"] : [])],ADD_ATTR:["controls",...(block ? ["allowfullscreen","sandbox"] : [])]});
}
