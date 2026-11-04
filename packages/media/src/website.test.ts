import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { colourHexes, fontNames, isBlockedAddress, isNeutral, readWebsite, validateTarget } from "./website.js";

/** A local fixture server, so nothing here needs the internet. `allowHosts` lets the reader reach it; the console never sets that. */
let server: http.Server, base = "", host = "";
const PAGE = `<!doctype html><html><head><title>Acme Roasters &amp; Co</title>
<meta name="description" content="Small-batch coffee roasted weekly in Leeds. Orders ship within two days of roasting.">
<meta property="og:site_name" content="Acme Roasters"><meta property="og:image" content="/img/share.png"><meta name="theme-color" content="#C8501E">
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="https://other.example/x.css">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Work+Sans&display=swap" rel="stylesheet">
<style>:root{--brand:#c8501e;--ink:#222} body{font-family:"Work Sans",system-ui,sans-serif;color:#222;background:#fff} .btn{background:rgb(200,80,30);color:#FFF}
@font-face{font-family:"Fraunces";src:url(x.woff2)} h1{font-family:Fraunces, serif}</style></head>
<body><header><img class="site-logo" src="/img/logo.svg" alt="Acme Roasters logo"></header>
<h1>Coffee that tastes like this week</h1><h2>Roasted weekly</h2><h3>Shipped fast</h3>
<p>We roast every Monday in small batches, so what reaches you is never more than a few days old.</p>
<p>Orders ship within two days of roasting, and every bag shows its roast date on the label.</p>
<ul><li>Subscribe and pause any time, with no minimum commitment and no hidden fees.</li></ul>
<p style="color:#0a7a5a">Short.</p><p>${"More about our roastery and the people who run it. ".repeat(8)}</p></body></html>`;
const CSS = `a{color:#c8501e} .x{background:#0A7A5A} .y{font-family:'Fraunces',Georgia,serif;border-color:#EEE}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = req.url ?? "/";
    const send = (code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => { res.writeHead(code, { "content-type": type, ...extra }); res.end(body); };
    if (u === "/") return send(200, "text/html; charset=utf-8", PAGE);
    if (u === "/site.css") return send(200, "text/css", CSS);
    if (u === "/js-only") return send(200, "text/html", `<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>`);
    if (u === "/big") return send(200, "text/html", "<html><body><p>" + "x".repeat(300_000) + "</p></body></html>");
    if (u === "/json") return send(200, "application/json", `{"a":1}`);
    if (u === "/missing") return send(404, "text/html", "<html><body>not here</body></html>");
    if (u === "/slow") return void setTimeout(() => send(200, "text/html", PAGE), 1500);
    if (u === "/r1") return send(302, "text/plain", "", { location: "/r2" });
    if (u === "/r2") return send(301, "text/plain", "", { location: "/r3" });
    if (u === "/r3") return send(307, "text/plain", "", { location: "/" });
    if (u === "/loop") return send(302, "text/plain", "", { location: "/loop" });
    if (u === "/to-metadata") return send(302, "text/plain", "", { location: "http://169.254.169.254/latest/meta-data/" });
    if (u === "/to-ftp") return send(302, "text/plain", "", { location: "ftp://example.com/x" });
    send(404, "text/plain", "no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`; base = `http://${host}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const read = (path: string, o: Parameters<typeof readWebsite>[1] = {}) => readWebsite(base + path, { allowHosts: [host], ...o });

describe("website reader: what it extracts", () => {
  it("reads colours, fonts, headings, copy, logo candidates and candidate facts from a page", async () => {
    const r = await read("/");
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.title).toBe("Acme Roasters & Co");
    expect(r.site_name).toBe("Acme Roasters");
    expect(r.description).toContain("Small-batch coffee");
    expect(r.headings).toEqual(["Coffee that tastes like this week", "Roasted weekly", "Shipped fast"]);
    expect(r.copy.length).toBeGreaterThanOrEqual(3);
    const hexes = r.colours.map((c) => c.hex);
    expect(hexes).toContain("#c8501e"); // brand orange: #c8501e, rgb(200,80,30), theme-color, stylesheet link colour
    expect(hexes).toContain("#0a7a5a");
    expect(hexes).not.toContain("#ffffff"); // neutrals are not brand colours
    expect(hexes).not.toContain("#222222");
    expect(r.colours[0]!.hex).toBe("#c8501e");
    expect(r.fonts).toEqual(expect.arrayContaining(["Fraunces", "Work Sans"]));
    expect(r.fonts).not.toContain("serif");
    expect(r.logo_candidates[0]).toBe(`${base}/img/logo.svg`);
    expect(r.logo_candidates).toContain(`${base}/favicon.ico`);
    expect(r.logo_candidates).toContain(`${base}/img/share.png`);
    expect(r.stylesheets_read).toBe(1); // the same-site stylesheet; the other host's is never fetched
    expect(r.candidate_facts.length).toBeGreaterThan(0);
    expect(r.candidate_facts.every((f) => f.source.startsWith(base))).toBe(true);
  });
  it("follows up to three redirects and reports the final address", async () => {
    const r = await read("/r1");
    expect(r).toMatchObject({ status: "ok", final_url: `${base}/` });
  });
  it("pure helpers: colour normalisation, neutrals and font names", () => {
    expect(colourHexes("a{color:#ABC;b:#112233ff;c:rgb(1, 2, 3);d:rgba(255,0,0,.5)}")).toEqual(["#aabbcc", "#112233", "#010203", "#ff0000"]);
    expect(isNeutral("#ffffff") && isNeutral("#000000") && isNeutral("#808080") && !isNeutral("#c8501e")).toBe(true);
    expect(fontNames(`p{font-family: Inter, -apple-system, "Helvetica Neue", sans-serif}`)).toEqual(["Inter"]);
  });
});

describe("website reader: when it cannot read, it says why and does not throw", () => {
  it("a page with no real text (built with JavaScript) -> no_content", async () => expect(await read("/js-only")).toMatchObject({ status: "could_not_read", reason: "no_content" }));
  it("a page over the size limit -> too_large", async () => expect(await read("/big", { maxBytes: 100_000 })).toMatchObject({ status: "could_not_read", reason: "too_large" }));
  it("not HTML -> not_html", async () => expect(await read("/json")).toMatchObject({ status: "could_not_read", reason: "not_html" }));
  it("an error status -> http_error", async () => expect(await read("/missing")).toMatchObject({ status: "could_not_read", reason: "http_error" }));
  it("too slow -> timeout", async () => expect(await read("/slow", { timeoutMs: 300 })).toMatchObject({ status: "could_not_read", reason: "timeout" }));
  it("a redirect loop, or more than the limit -> redirect_limit", async () => {
    expect(await read("/loop")).toMatchObject({ status: "could_not_read", reason: "redirect_limit" });
    expect(await read("/r1", { maxRedirects: 2 })).toMatchObject({ status: "could_not_read", reason: "redirect_limit" });
  });
  it("nothing listening / offline -> offline", async () => {
    const dead = http.createServer(); await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const h = `127.0.0.1:${(dead.address() as AddressInfo).port}`; await new Promise<void>((r) => dead.close(() => r()));
    expect(await readWebsite(`http://${h}/`, { allowHosts: [h] })).toMatchObject({ status: "could_not_read", reason: "offline" });
    expect(await readWebsite("http://no-such-host.invalid/", { resolve: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } })).toMatchObject({ status: "could_not_read", reason: "offline" });
  });
});

describe("website reader: server-side request forgery is refused", () => {
  const blocked = ["http://127.0.0.1/", "http://127.1.2.3:80/", "http://localhost/", "http://app.localhost/", "http://10.0.0.5/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://100.64.0.1/", "http://[::1]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://printer.local/", "http://db.internal/", "http://224.0.0.1/"];
  for (const url of blocked) it(`refuses ${url}`, async () => expect(await readWebsite(url), url).toMatchObject({ status: "could_not_read", reason: "blocked" }));
  it("refuses odd ports on public hosts", async () => expect(await readWebsite("http://example.com:22/", { resolve: async () => [{ address: "93.184.216.34", family: 4 }] })).toMatchObject({ reason: "blocked" }));
  it("refuses other schemes, credentials and junk", async () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@example.com/", "not a url", ""]) expect(await readWebsite(url), url).toMatchObject({ status: "could_not_read", reason: "invalid_url" });
  });
  it("refuses a public-looking name that resolves to a private address (checked at connect time)", async () => {
    expect(await readWebsite("http://innocent.example/", { resolve: async () => [{ address: "10.1.2.3", family: 4 }] })).toMatchObject({ reason: "blocked" });
    // one good and one private answer is still refused
    expect(await readWebsite("http://mixed.example/", { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] })).toMatchObject({ reason: "blocked" });
  });
  it("re-checks every redirect: a page may not bounce the reader to the metadata service or another scheme", async () => {
    expect(await read("/to-metadata")).toMatchObject({ status: "could_not_read", reason: "blocked" });
    expect(await read("/to-ftp")).toMatchObject({ status: "could_not_read", reason: "invalid_url" });
  });
  it("address classification", () => {
    for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.0.9", "169.254.1.1", "0.1.2.3", "100.100.0.1", "198.18.0.1", "240.0.0.1", "::1", "::", "fe80::abcd", "fd12::1", "::ffff:192.168.1.1", "::ffff:7f00:1", "::ffff:a00:1", "::127.0.0.1", "64:ff9b::7f00:1", "not-an-ip"]) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "::ffff:5db8:d822", "2606:2800:220:1:248:1893:25c8:1946"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it("validateTarget allows normal web addresses", () => {
    for (const u of ["https://example.com/a?b=1", "http://example.com:8080/", "https://example.com:443/"]) expect(() => validateTarget(u)).not.toThrow();
  });
});
