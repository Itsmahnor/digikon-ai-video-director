import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDependencyCheck, implementationHash, loadCapabilityRegistry } from "./index.js";
import { root } from "../../director/src/fixtures.js";

const registry = () => loadCapabilityRegistry(join(root(""), "capabilities"));
const webRecords = () => registry().records.filter((r) => r.status === "validated" && (r.engine === "remotion" || r.engine === "hyperframes"));

describe("validation evidence must describe the code that runs", () => {
  it("every stored Remotion and HyperFrames capability was validated against the current scene implementation, or it is not usable", () => {
    const reg = registry();
    expect(webRecords().length).toBeGreaterThan(10);
    for (const r of webRecords()) {
      const recorded = /scenes ([0-9a-f]{16})/.exec(r.validated!.browser ?? "")?.[1];
      const usable = reg.usable.some((u) => u.capability_id === r.capability_id);
      expect(usable, `${r.capability_id} is ${usable ? "usable" : "not usable"}; evidence is for scenes ${recorded}, code is ${implementationHash(r.engine)}`).toBe(recorded === implementationHash(r.engine));
    }
  });

  it("evidence recorded for older scene code is refused, with the reason", () => {
    const r = webRecords()[0]!;
    const old = structuredClone(r);
    old.validated!.browser = (old.validated!.browser ?? "").replace(/scenes [0-9a-f]{16}/, "scenes 0000000000000000");
    expect(defaultDependencyCheck(old)).toContain("implementation changed after it was validated");
  });

  it("evidence that does not record the implementation at all is refused", () => {
    const r = webRecords()[0]!;
    const old = structuredClone(r);
    old.validated!.browser = "msedge.exe 64-bit; remotion 4.0.539";
    expect(defaultDependencyCheck(old)).toContain("does not record");
  });

  it("evidence for the current code is accepted", () => {
    const r = webRecords()[0]!;
    const now = structuredClone(r);
    now.validated!.browser = (now.validated!.browser ?? "").replace(/scenes [0-9a-f]{16}/, `scenes ${implementationHash(r.engine)}`);
    expect(defaultDependencyCheck(now)).toBeNull();
  });

  it("an end card and a text motion are validated with the approved two-line copy, not a single phrase", () => {
    for (const id of ["remotion:end-card-cta", "hyperframes:end-card-cta-hyperframes"]) {
      const r = registry().records.find((x) => x.capability_id === id)!;
      expect(r.validated!.checks.join(" "), id).toContain("two-line copy is drawn as 2 separate lines");
    }
  });
});
