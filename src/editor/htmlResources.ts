import DOMPurify from "dompurify";
export const bundledImageUrls = new Map<string, string>();
export const normalizedURL = (value: string) => value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
export const remoteURL = (value: string) => /^(?:https?:|[/\\]{2})/i.test(normalizedURL(value));
// Keep the normal safe link protocols plus this app's document-scoped media
// scheme. File URLs are rewritten before sanitization, never enabled globally.
const allowedURI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|omarkie-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
export function safeDocumentHtml(html: string, documentId?: string, block = true) {
  const template = document.createElement("template"); template.innerHTML = html;
  if (documentId) for (const element of template.content.querySelectorAll("img,video,audio,source")) {
    const source = normalizedURL(element.getAttribute("src") || "");
    if (source && !remoteURL(source) && (!/^[a-z][a-z\d+.-]*:/i.test(source) || /^file:/i.test(source) || /^[a-z]:[\\/]/i.test(source))) {
      element.setAttribute("src",`omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`);
    }
  }
  return DOMPurify.sanitize(template.innerHTML,{ALLOW_DATA_ATTR:false,FORBID_ATTR:["contenteditable"],ALLOWED_URI_REGEXP:allowedURI,ADD_TAGS:["video","audio","source",...(block ? ["iframe"] : [])],ADD_ATTR:["controls",...(block ? ["allowfullscreen","sandbox"] : [])]});
}
