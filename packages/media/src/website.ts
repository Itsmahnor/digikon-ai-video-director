import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Reads a public web page for the guided intake: colours, fonts, headings, copy and logo candidates. It never trusts the address it is given.
 *  - Only http and https, no credentials in the URL, only the usual web ports.
 *  - Private, loopback, link-local, carrier-grade NAT, multicast and metadata addresses are refused (SSRF). The check runs on the address the connection actually uses, at connect time
 *    (so a name that resolves to a private address, or changes its answer between the check and the connection, is refused), and again for every redirect.
 *  - Bounded: a total time limit, a byte limit, a redirect limit, and only HTML responses.
 * Anything that goes wrong is a `could_not_read` result with a reason, never an exception, so the wizard can ask the user instead. Nothing here is a fact: the candidates it
 * returns are shown to the user and only count as approved brand facts after they confirm them.
 */
export type CouldNotReadReason = "invalid_url" | "blocked" | "offline" | "timeout" | "too_large" | "not_html" | "redirect_limit" | "http_error" | "no_content";
export interface CouldNotRead { status: "could_not_read"; reason: CouldNotReadReason; detail: string }
export interface WebsiteReading {
  status: "ok";
  url: string;
  final_url: string;
  site_name: string | null;
  title: string | null;
  description: string | null;
  headings: string[];
  copy: string[];
  /** Most used non-neutral colours as lower-case #rrggbb, with how often each appeared. */
  colours: { hex: string; count: number }[];
  fonts: string[];
  /** Absolute URLs of images that look like the logo. Not downloaded here. */
  logo_candidates: string[];
  /** Sentences from the page offered to the user as possible brand facts. Not approved. */
  candidate_facts: { text: string; source: string }[];
  stylesheets_read: number;
}
export type WebsiteResult = WebsiteReading | CouldNotRead;

export interface ReadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxStylesheets?: number;
  /** Exact `host:port` values that may be private. For tests with a local server only; the console never sets it. */
  allowHosts?: readonly string[];
  /** Replaces DNS resolution (tests). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}
const DEFAULTS = { timeoutMs: 8000, maxBytes: 1_500_000, maxRedirects: 3, maxStylesheets: 2 } as const;
const WEB_PORTS = new Set(["", "80", "443", "8080", "8443"]);

class Refusal extends Error { constructor(readonly reason: CouldNotReadReason, detail: string) { super(detail); } }

// ---------- addresses ----------
function v4(ip: string): number[] | null { const p = ip.split(".").map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null; }
/** The IPv4 address hidden inside an IPv6 one (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d, 64:ff9b::a.b.c.d), or null. The URL parser rewrites the dotted form to hex, so both must be understood. */
function embeddedV4(ip: string): string | null {
  if (!net.isIPv6(ip)) return null;
  let h = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) { const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number]; h = h.slice(0, h.length - dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail = ""] = h.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = h.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const g = groups.map((x) => parseInt(x || "0", 16));
  const zeros5 = g.slice(0, 5).every((x) => x === 0);
  const prefixOk = (zeros5 && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (!prefixOk) return null;
  return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
}
/** True for any address a user-supplied URL must never reach. Unknown shapes are refused. */
export function isBlockedAddress(ip: string): boolean {
  const embedded = embeddedV4(ip);
  if (embedded) return isBlockedAddress(embedded);
  if (net.isIPv4(ip)) {
    const [a, b, c] = v4(ip)!;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a! >= 224;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === "::" || h === "::1") return true;
    const first = parseInt(h.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */ || (first & 0xff00) === 0xff00 /* multicast */;
  }
  return true;
}

/** Checks a URL before any connection: scheme, credentials, port, and a literal IP host. Hostnames are checked again at connect time. */
export function validateTarget(raw: string, opts: ReadOptions = {}): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Refusal("invalid_url", "that is not a web address"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Refusal("invalid_url", "only http and https addresses can be read");
  if (u.username || u.password) throw new Refusal("invalid_url", "addresses with a user name or password are not read");
  const allowed = opts.allowHosts?.includes(u.host) ?? false;
  if (!allowed && !WEB_PORTS.has(u.port)) throw new Refusal("blocked", `port ${u.port} is not read`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowed && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))) throw new Refusal("blocked", "local addresses are not read");
  if (!allowed && net.isIP(host) && isBlockedAddress(host)) throw new Refusal("blocked", "private and local addresses are not read");
  return u;
}

// ---------- fetching ----------
interface Fetched { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function fetchOnce(u: URL, opts: Required<Pick<ReadOptions, "timeoutMs" | "maxBytes">> & ReadOptions, deadline: number): Promise<Fetched> {
  const allowed = opts.allowHosts?.includes(u.host) ?? false;
  const resolver = opts.resolve ?? ((h: string) => dns.lookup(h, { all: true }));
  // The address the socket will use is checked here, at connect time.
  const lookup = (hostname: string, o: { all?: boolean }, cb: (err: Error | null, a?: unknown, f?: number) => void) => {
    resolver(hostname).then((addrs) => {
      if (!addrs.length) return cb(new Refusal("offline", "the name did not resolve"));
      if (!allowed) for (const a of addrs) if (isBlockedAddress(a.address)) return cb(new Refusal("blocked", "the name points at a private or local address"));
      if (o.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family }))); else cb(null, addrs[0]!.address, addrs[0]!.family);
    }, (e) => cb(e instanceof Error ? e : new Error(String(e))));
  };
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Refusal("timeout", "the page took too long"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", lookup: lookup as never, headers: { "user-agent": "DigikonBrandReader/1.0 (+reads one public page for a brand kit)", accept: "text/html,application/xhtml+xml,text/css;q=0.9", "accept-encoding": "identity" } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > opts.maxBytes) { reject(new Refusal("too_large", `the page is larger than ${Math.round(opts.maxBytes / 1024)} KB`)); req.destroy(); res.destroy(); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => reject(e));
    });
    const timer = setTimeout(() => { reject(new Refusal("timeout", "the page took too long")); req.destroy(); }, left);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

function asRefusal(e: unknown): Refusal {
  if (e instanceof Refusal) return e;
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? "";
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|CERT|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED/.test(code)) return new Refusal("offline", `could not connect (${code})`);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/.test(code)) return new Refusal("timeout", "the page took too long");
  return new Refusal("offline", `could not read the page (${e instanceof Error ? e.message : String(e)}`.slice(0, 160) + ")");
}

/** Follows redirects, validating every hop. */
async function fetchPage(start: URL, opts: Required<Pick<ReadOptions, "timeoutMs" | "maxBytes" | "maxRedirects">> & ReadOptions, deadline: number): Promise<{ finalUrl: URL; res: Fetched }> {
  let u = start;
  for (let hop = 0; ; hop++) {
    const res = await fetchOnce(u, opts, deadline);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= opts.maxRedirects) throw new Refusal("redirect_limit", `more than ${opts.maxRedirects} redirects`);
      u = validateTarget(new URL(String(res.headers.location), u).toString(), opts);
      continue;
    }
    return { finalUrl: u, res };
  }
}

// ---------- extraction ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", copy: "©" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m)));
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null; };
const abs = (href: string | null, base: URL): string | null => { if (!href) return null; try { const u = new URL(href, base); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; } };
const meta = (html: string, key: string) => { for (const m of html.matchAll(/<meta\b[^>]*>/gi)) { const t = m[0]; const k = attr(t, "property") ?? attr(t, "name"); if (k?.toLowerCase() === key) return attr(t, "content"); } return null; };

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
export function colourHexes(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi)) {
    let h = m[1]!.toLowerCase();
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    out.push(`#${h.slice(0, 6)}`);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/gi)) out.push(toHex(+m[1]!, +m[2]!, +m[3]!));
  return out;
}
/** Near-grey colours (white, black, greys) are the page's neutrals, not its brand colours. */
export const isNeutral = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]; return Math.max(r, g, b) - Math.min(r, g, b) <= 14; };

const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "inherit", "initial", "unset", "revert", "-apple-system", "blinkmacsystemfont", "emoji", "math", "fangsong", "segoe ui", "helvetica neue", "helvetica", "arial", "times new roman", "times", "courier new", "courier", "georgia", "verdana", "tahoma", "trebuchet ms", "apple color emoji", "segoe ui emoji", "noto color emoji"]);
export function fontNames(css: string, html = ""): string[] {
  const counts = new Map<string, number>();
  const add = (n: string, w = 1) => { const k = n.trim().replace(/^["']|["']$/g, "").trim(); if (k && k.length <= 60 && !GENERIC_FONTS.has(k.toLowerCase()) && !/^var\(/.test(k)) counts.set(k, (counts.get(k) ?? 0) + w); };
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) for (const n of m[1]!.replace(/!important/i, "").split(",")) add(n);
  for (const m of css.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*([^;}]+)/gi)) add(m[1]!, 3);
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi)) for (const f of decode(m[1]!).matchAll(/family=([^&:;]+)/g)) add(decodeURIComponent(f[1]!.replace(/\+/g, " ")), 4);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([n]) => n);
}

function sentences(s: string): string[] { return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 25 && x.length <= 200); }

export function extractPage(html: string, base: URL, css: string): Omit<WebsiteReading, "status" | "url" | "final_url" | "stylesheets_read"> {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ");
  const title = ((t) => (t ? text(t) : null))(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]) || null;
  const description = meta(html, "description") ?? meta(html, "og:description");
  const siteName = meta(html, "og:site_name");
  const headings = [...stripped.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => text(m[2]!)).filter((t) => t.length >= 2 && t.length <= 140).slice(0, 12);
  const paras = [...stripped.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => text(m[2]!)).filter((t) => t.length >= 40 && t.length <= 300);
  const copy = [...new Set(paras)].slice(0, 12);

  const counts = new Map<string, number>();
  const all = css + "\n" + [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join("\n");
  for (const h of colourHexes(all)) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const key of ["theme-color", "msapplication-tilecolor"]) { const c = meta(html, key); if (c) for (const h of colourHexes(c)) counts.set(h, (counts.get(h) ?? 0) + 5); }
  const colours = [...counts].filter(([h]) => !isNeutral(h)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([hex, count]) => ({ hex, count }));

  const logos: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) { const t = m[0]; if (/logo/i.test(`${attr(t, "src") ?? ""} ${attr(t, "alt") ?? ""} ${attr(t, "class") ?? ""} ${attr(t, "id") ?? ""}`)) { const u = abs(attr(t, "src"), base); if (u) logos.push(u); } }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const t = m[0]; if (/\bicon\b|apple-touch-icon/i.test(attr(t, "rel") ?? "")) { const u = abs(attr(t, "href"), base); if (u) logos.push(u); } }
  const og = abs(meta(html, "og:image"), base); if (og) logos.push(og);

  const facts = [...(description ? sentences(description) : []), ...copy.flatMap(sentences)];
  const candidate_facts = [...new Set(facts)].slice(0, 8).map((t) => ({ text: t, source: base.toString() }));
  return { site_name: siteName, title, description: description ? decode(description) : null, headings, copy, colours, fonts: fontNames(all, html), logo_candidates: [...new Set(logos)].slice(0, 5), candidate_facts };
}

// ---------- the reader ----------
export async function readWebsite(raw: string, options: ReadOptions = {}): Promise<WebsiteResult> {
  const opts = { ...DEFAULTS, ...options };
  const deadline = Date.now() + opts.timeoutMs;
  try {
    const start = validateTarget(raw.trim(), opts);
    const { finalUrl, res } = await fetchPage(start, opts, deadline);
    if (res.status < 200 || res.status >= 300) throw new Refusal("http_error", `the site answered ${res.status}`);
    if (!/^(text\/html|application\/xhtml\+xml)/i.test(String(res.headers["content-type"] ?? ""))) throw new Refusal("not_html", "that address is not a web page");
    const html = res.body.toString("utf8");
    const visible = text(html.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " "));
    if (visible.length < 200) throw new Refusal("no_content", "the page has almost no text (it may build its content with JavaScript); type the details in instead");

    // Same-site stylesheets, a few, for colours and fonts; a failure there never fails the page.
    let css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    let read = 0;
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      if (read >= opts.maxStylesheets) break;
      if (!/stylesheet/i.test(attr(m[0], "rel") ?? "")) continue;
      const href = abs(attr(m[0], "href"), finalUrl);
      if (!href || new URL(href).host !== finalUrl.host) continue;
      try { const r = await fetchOnce(validateTarget(href, opts), { ...opts, maxBytes: 400_000 }, deadline); if (r.status >= 200 && r.status < 300 && /css/i.test(String(r.headers["content-type"] ?? ""))) { css += "\n" + r.body.toString("utf8"); read++; } } catch { /* the page is still readable */ }
    }
    return { status: "ok", url: start.toString(), final_url: finalUrl.toString(), stylesheets_read: read, ...extractPage(html, finalUrl, css) };
  } catch (e) {
    const r = asRefusal(e);
    return { status: "could_not_read", reason: r.reason, detail: r.message };
  }
}
