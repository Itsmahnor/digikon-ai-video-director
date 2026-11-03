import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The browser the Remotion and HyperFrames adapters draw with. They only ever use a browser that is already on this machine:
 * nothing here downloads one. Order: the path given, DIGIKON_CHROME_PATH, then the usual install locations. Null when none exists.
 */
export function findChrome(explicit?: string | null): string | null {
  const candidates = [
    explicit, process.env["DIGIKON_CHROME_PATH"],
    process.env["ProgramFiles"] && join(process.env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["LOCALAPPDATA"] && join(process.env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

export type BrowserBits = "64-bit" | "32-bit" | "unknown";
export interface BrowserInspection {
  path: string;
  bits: BrowserBits;
  compatible: boolean;
  /** Why the browser was accepted or rejected, in words that can be shown to a person. */
  reason: string;
}

/** The two flags that matter: Remotion 4.0.539 always starts its browser with this one (`@remotion/renderer/dist/open-browser.js`). */
export const REMOTION_GPU_MEMORY_FLAG = "--force-gpu-mem-available-mb=4096";

/**
 * Reads the executable header to tell a 32-bit browser from a 64-bit one (PE for Windows, ELF for Linux). Other formats are reported
 * as `unknown` and accepted, because they cannot be checked here.
 *
 * Known defect, reproduced on 2026-10-27 with Chrome 155 (a 32-bit build, `Program Files (x86)`): Remotion's hard-coded
 * `--force-gpu-mem-available-mb=4096` makes that browser paint only each element's own background and none of its children, so
 * every Remotion scene comes out as a plain colour. 1024 to 3000 paint correctly; 4096 does not. The 64-bit Edge paints correctly
 * with the same flag. A 32-bit browser is therefore refused for Remotion. Why 4096 matters is not proven (4096 MB is 2^32 bytes).
 */
export function inspectBrowser(path: string): BrowserInspection {
  let head: Buffer;
  try {
    if (!statSync(path).isFile()) return { path, bits: "unknown", compatible: false, reason: "it is not a file" };
    const fd = openSync(path, "r");
    try { head = Buffer.alloc(4096); readSync(fd, head, 0, 4096, 0); } finally { closeSync(fd); }
  } catch { return { path, bits: "unknown", compatible: false, reason: "it cannot be read" }; }
  const bad = (bits: BrowserBits): BrowserInspection => ({ path, bits, compatible: false, reason: `it is a ${bits} build; Remotion 4.0.539 starts its browser with ${REMOTION_GPU_MEMORY_FLAG}, which makes a ${bits} browser paint only scene backgrounds (reproduced), so it is not used` });
  if (head[0] === 0x4d && head[1] === 0x5a) { // "MZ": a Windows executable
    const pe = head.readUInt32LE(0x3c);
    if (pe + 6 > head.length || head.toString("latin1", pe, pe + 4) !== "PE\0\0") return { path, bits: "unknown", compatible: false, reason: "its Windows header cannot be read" };
    const machine = head.readUInt16LE(pe + 4);
    if (machine === 0x8664 || machine === 0xaa64) return { path, bits: "64-bit", compatible: true, reason: "a 64-bit build" };
    if (machine === 0x14c) return bad("32-bit");
    return { path, bits: "unknown", compatible: false, reason: `an unrecognised processor type (0x${machine.toString(16)})` };
  }
  if (head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF") return head[4] === 2 ? { path, bits: "64-bit", compatible: true, reason: "a 64-bit build" } : bad("32-bit");
  return { path, bits: "unknown", compatible: true, reason: "its word size cannot be read from the file (not Windows or Linux), so it is accepted without a check" };
}

/** The installed version of a browser executable ("unknown" when it cannot be read). Nothing is launched on Windows: the file's version resource is read instead. */
const browserVersions = new Map<string, string>();
export function browserVersion(path: string | null | undefined): string {
  if (!path) return "unknown";
  const known = browserVersions.get(path);
  if (known) return known;
  let v = "unknown";
  try {
    if (process.platform === "win32") {
      v = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:DIGIKON_BROWSER_PATH).VersionInfo.ProductVersion"], { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, DIGIKON_BROWSER_PATH: path } }).trim() || "unknown";
    } else v = execFileSync(path, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim() || "unknown";
  } catch { /* version stays unknown */ }
  browserVersions.set(path, v);
  return v;
}

function remotionCandidates(explicit?: string | null): string[] {
  const pf = process.env["ProgramFiles"], pf86 = process.env["ProgramFiles(x86)"], local = process.env["LOCALAPPDATA"];
  return [
    explicit, process.env["DIGIKON_REMOTION_BROWSER"],
    // Edge first: it is installed with Windows, and its 64-bit build is the one verified to paint Remotion scenes.
    pf86 && join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), pf && join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    pf && join(pf, "Google", "Chrome", "Application", "chrome.exe"), local && join(local, "Google", "Chrome", "Application", "chrome.exe"),
    pf86 && join(pf86, "Google", "Chrome", "Application", "chrome.exe"), // usually 32-bit: inspected, and refused if it is
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable",
  ].filter((c): c is string => !!c);
}

export interface RemotionBrowserChoice {
  /** The browser to use, or null when none already installed is compatible. */
  path: string | null;
  bits: BrowserBits | null;
  /** Every installed candidate that was looked at and why it was or was not taken. */
  inspected: BrowserInspection[];
}

/**
 * Picks the browser Remotion renders in. It only looks at browsers already installed and never downloads one. An explicit path that
 * is a 32-bit build is refused, not honoured, and the next candidate is tried. Order: the path given, DIGIKON_REMOTION_BROWSER, Edge,
 * then Chrome; the first compatible one wins.
 */
export function selectRemotionBrowser(explicit?: string | null): RemotionBrowserChoice {
  return selectRemotionBrowserFrom(remotionCandidates(explicit));
}

/** The same choice from an explicit list, in order. Used by `selectRemotionBrowser` and by tests and configuration that name the candidates. */
export function selectRemotionBrowserFrom(candidates: readonly string[]): RemotionBrowserChoice {
  const inspected: BrowserInspection[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    if (!existsSync(c)) continue;
    const i = inspectBrowser(c);
    inspected.push(i);
    if (i.compatible) return { path: c, bits: i.bits, inspected };
  }
  return { path: null, bits: null, inspected };
}

/** The browser path Remotion should use, or null. See `selectRemotionBrowser` for the reasons. */
export function findRemotionBrowser(explicit?: string | null): string | null {
  return selectRemotionBrowser(explicit).path;
}
/** Environment for a child process that must not report anywhere or check for updates. */
export const QUIET_ENV = {
  DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", HF_CLI_TELEMETRY_DISABLED: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1",
  NO_UPDATE_NOTIFIER: "1", REMOTION_DISABLE_TELEMETRY: "1", CI: "1",
} as const;

export interface ProcessResult { code: number | null; output: string }

/**
 * Runs a program with an argument array (no shell), keeps the last of its output, and stops it and everything it started when
 * the signal fires. Rejects with the aborted flag on a stop so callers can tell a stop from a failure.
 */
export function runProcess(file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; keep?: number }): Promise<ProcessResult> {
  return new Promise((resolveP, reject) => {
    if (opts.signal.aborted) return reject(Object.assign(new Error("stopped"), { aborted: true }));
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = opts.keep ?? 8000;
    const take = (b: Buffer) => { out = (out + b.toString("utf8")).slice(-keep); };
    child.stdout.on("data", take); child.stderr.on("data", take);
    const stop = () => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    };
    opts.signal.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => { opts.signal.removeEventListener("abort", stop); reject(e); });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", stop);
      if (opts.signal.aborted) reject(Object.assign(new Error("stopped"), { aborted: true }));
      else resolveP({ code, output: out });
    });
  });
}

