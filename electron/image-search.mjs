// Online picture search for one explicit click: Wikimedia Commons and Openverse, licence data first.
// The caller decides whether the network may be used; this module only builds candidates.

const commonsEndpoint = () => process.env.OMARKIE_SWAP_COMMONS?.trim() || "https://commons.wikimedia.org/w/api.php";
const openverseEndpoint = () => process.env.OMARKIE_SWAP_OPENVERSE?.trim() || "https://api.openverse.org/v1/images/";
const licenceFilter = "cc0,by,by-sa";
const timeoutMs = 8_000;
const thumbnailLimit = 600 * 1024;

const tagged = /<[^>]*>/g;
const space = /\s+/g;

function text(value) {
  const raw = typeof value === "string" ? value : value?.value;
  if (typeof raw !== "string") return "";
  return raw.replace(tagged, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/g, "'").replace(space, " ").trim();
}

function versionOf(name) {
  const found = /(\d+(?:\.\d+)?)/.exec(String(name ?? ""));
  return found ? found[1] : null;
}

// Commons names its licences in prose; map the reusable ones and let the rest fail the allow list.
export function commonsLicence(short, full, url) {
  const name = `${short ?? ""} ${full ?? ""}`.toLowerCase();
  const version = versionOf(name);
  if (/cc0|public domain|pd-/.test(name)) return { code: "cc0", version: version, url: url || "https://creativecommons.org/publicdomain/zero/1.0/", required: false };
  if (/by-sa/.test(name)) return { code: "by-sa", version, url: url || null, required: true };
  if (/by-nd|no ?deriv/.test(name)) return { code: "by-nd", version, url: url || null, required: true };
  if (/by-nc/.test(name)) return { code: /sa/.test(name) ? "by-nc-sa" : "by-nc", version, url: url || null, required: true };
  if (/\bby\b|attribution/.test(name)) return { code: "by", version, url: url || null, required: true };
  return { code: "unknown", version: null, url: url || null, required: true };
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function getJson(url, fetchImpl, signal) {
  // The query is the person's words: a 302 must never carry them to another host.
  const response = await fetchImpl(url, { signal, redirect: "error", headers: { accept: "application/json", "user-agent": "omarkie-swap/1 (+local note app)" } });
  if (response.status === 429) throw Object.assign(new Error("Openverse is rate-limited; try again in a minute."), { code: "QUOTA_EXCEEDED" });
  if (!response.ok) throw Object.assign(new Error(`Picture search failed (${response.status}).`), { code: "SOURCE_OFFLINE" });
  return await response.json();
}

// The thumbnail cap must bound memory, not only the bytes kept: never buffer past it.
async function boundedBody(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel?.().catch(() => {}); return null; }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > limit ? null : bytes;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}

async function preview(url, fetchImpl, signal) {
  if (!url) return null;
  try {
    const response = await fetchImpl(url, { signal, headers: { accept: "image/*" } });
    if (!response.ok) return null;
    const type = String(response.headers?.get?.("content-type") ?? "image/jpeg").split(";")[0];
    if (!/^image\//.test(type)) return null;
    const bytes = await boundedBody(response, thumbnailLimit);
    if (!bytes?.length) return null;
    return { base64: base64(bytes), mime: type };
  } catch { return null; }
}

export async function searchCommons(query, { fetchImpl = fetch, limit = 3, signal } = {}) {
  const address = new URL(commonsEndpoint());
  address.searchParams.set("action", "query");
  address.searchParams.set("format", "json");
  address.searchParams.set("formatversion", "2");
  address.searchParams.set("generator", "search");
  address.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  address.searchParams.set("gsrnamespace", "6");
  address.searchParams.set("gsrlimit", String(Math.max(1, Math.min(limit, 8))));
  address.searchParams.set("prop", "imageinfo");
  address.searchParams.set("iiprop", "url|size|extmetadata");
  address.searchParams.set("iiextmetadatafilter", "ObjectName|Artist|Credit|LicenseShortName|License|LicenseUrl|UsageTerms|AttributionRequired|ImageDescription");
  const data = await getJson(address, fetchImpl, signal);
  const rows = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const candidates = [];
  for (const page of rows.slice(0, limit)) {
    const info = page?.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata ?? {};
    const licence = commonsLicence(text(meta.LicenseShortName), text(meta.License), text(meta.LicenseUrl));
    const title = text(meta.ObjectName) || String(page.title ?? "").replace(/^File:/i, "") || "Untitled";
    const creator = text(meta.Artist) || text(meta.Credit) || "";
    candidates.push({
      kind: "find", source: "commons", sourceLabel: "Wikimedia Commons", title, creator,
      sourceUrl: page.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title ?? "")}`,
      downloadUrl: info.url, width: Number(info.width) || 0, height: Number(info.height) || 0,
      bytes: Number(info.size) || 0,
      licence: { ...licence, attribution: creator },
      notes: text(meta.UsageTerms) || text(meta.ImageDescription).slice(0, 160),
      online: true,
      preview: await preview(info.thumburl || info.url, fetchImpl, signal),
    });
  }
  return candidates;
}

export async function searchOpenverse(query, { fetchImpl = fetch, limit = 3, signal } = {}) {
  const address = new URL(openverseEndpoint());
  address.searchParams.set("q", query);
  address.searchParams.set("license", licenceFilter);
  address.searchParams.set("page_size", String(Math.max(1, Math.min(limit, 8))));
  address.searchParams.set("mature", "false");
  const data = await getJson(address, fetchImpl, signal);
  const rows = Array.isArray(data?.results) ? data.results : [];
  const candidates = [];
  for (const row of rows.slice(0, limit)) {
    if (!row?.url) continue;
    const creator = typeof row.creator === "string" ? row.creator.trim() : "";
    const licence = { code: String(row.license ?? "unknown").toLowerCase(), version: row.license_version ? String(row.license_version) : null,
      url: typeof row.license_url === "string" ? row.license_url : null, attribution: creator, required: String(row.license ?? "").toLowerCase() !== "cc0" };
    candidates.push({
      kind: "find", source: "openverse", sourceLabel: "Openverse", title: String(row.title ?? "").trim() || "Untitled", creator,
      sourceUrl: row.foreign_landing_url || row.detail_url || row.url,
      downloadUrl: row.url, width: Number(row.width) || 0, height: Number(row.height) || 0,
      licence, notes: typeof row.attribution === "string" ? row.attribution.slice(0, 200) : "",
      online: true,
      preview: await preview(row.thumbnail, fetchImpl, signal),
    });
  }
  return candidates;
}

// Both sources in one pass, capped; a failing source names itself and never blocks the other.
export async function searchOnline(query, { fetchImpl = fetch, limit = 3, sources = ["commons", "openverse"] } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const found = [], errors = [];
  for (const source of sources) {
    try {
      const rows = source === "commons"
        ? await searchCommons(query, { fetchImpl, limit, signal })
        : await searchOpenverse(query, { fetchImpl, limit, signal });
      found.push(...rows);
    } catch (error) {
      errors.push({ source, code: error?.code ?? "SOURCE_OFFLINE", message: error?.message ?? "Picture search failed." });
    }
  }
  return { candidates: found, errors };
}
