import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const checks = [];
function run(name, cmd, args, { required = true } = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    checks.push({ name, ok: true, detail: out.split("\n")[0].trim(), required });
  } catch {
    checks.push({ name, ok: false, detail: "not found / failed", required });
  }
}

const major = Number(process.versions.node.split(".")[0]);
checks.push({ name: "node >= 20", ok: major >= 20, detail: process.version, required: true });
run("git", "git", ["--version"]);
run("ffmpeg", "ffmpeg", ["-version"]);
run("ffprobe", "ffprobe", ["-version"]);
run("docker", "docker", ["--version"]);
run("docker daemon", "docker", ["info", "--format", "{{.ServerVersion}}"], { required: false });
checks.push({ name: ".env present", ok: existsSync(".env"), detail: ".env", required: false });

let failed = false;
for (const c of checks) {
  const mark = c.ok ? "PASS" : c.required ? "FAIL" : "WARN";
  if (!c.ok && c.required) failed = true;
  console.log(`${mark.padEnd(5)} ${c.name.padEnd(16)} ${c.detail}`);
}
process.exit(failed ? 1 : 0);
