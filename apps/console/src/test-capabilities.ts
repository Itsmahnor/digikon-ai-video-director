import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test support for the production gate. Planning refuses a recipe that has no validated capability, so an end-to-end test that wants a capability learned at render time
 * first needs the plan to be approvable: `seedCapabilities` copies the committed, really-rendered validation records into the test's own store, and
 * `withdrawCapabilities` removes them again after approval, which is the situation the learning path exists for (evidence lost or invalidated after the plan was approved).
 * Records are named like the files in capabilities/registry/<engine>/, for example "ffmpeg__xfade-fadeblack".
 */
const committed = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "capabilities", "registry");
const fileOf = (root: string, name: string) => join(root, "registry", name.split("__")[0]!, `${name}.json`);

export function seedCapabilities(store: string, names: readonly string[]): void {
  for (const n of names) {
    const from = join(committed, n.split("__")[0]!, `${n}.json`);
    if (!existsSync(from)) throw new Error(`no committed capability record ${n}; run: npm run capabilities`);
    const to = fileOf(store, n);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

export function withdrawCapabilities(store: string, names: readonly string[]): void {
  for (const n of names) rmSync(fileOf(store, n), { force: true });
}
