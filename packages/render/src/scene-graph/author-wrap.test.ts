import { describe, expect, it } from "vitest";
import { Composition } from "@digikon/contracts";
import { ESTIMATE_METER } from "../font-metrics.js";
import { authorGraph } from "./author.js";
import { validateSceneGraph } from "./validate.js";
import { DEFAULT_PALETTE } from "../composition.js";

// The layout that rendered as one long line behind its neighbouring card (a headline in the left 40% of a 16:9 frame).
const comp = Composition.parse({
  block: "composition", intent: "approve, then render", camera: "static", reveal: "none", backdrop: "flat",
  elements: [
    { id: "head", kind: "text", text: "You approve, then it renders", at: { x: 0.06, y: 0.12, w: 0.4 }, size: 0.09, align: "left", motion: { enter: "fade", delay: 0, duration: 0.2, easing: "ease_out" } },
    { id: "card", kind: "shape", shape: "rect", at: { x: 0.52, y: 0.12, w: 0.42, h: 0.58 }, fill: "surface", motion: { enter: "fade", delay: 0, duration: 0.2, easing: "ease_out" } },
  ],
});
const frame = { width: 1280, height: 720, fps: 30, duration_s: 4 };

describe("composition text is broken into lines for the render", () => {
  it("without a meter the text is left as written (one line), which is what used to be drawn", () => {
    const t = authorGraph(comp, frame).elements.find((e) => e.id === "head")!;
    expect((t.props as { text: string }).text).toBe("You approve, then it renders");
  });
  it("with a meter the headline is broken at its box width, so it cannot run under the card", () => {
    const g = authorGraph(comp, { ...frame, meter: ESTIMATE_METER });
    const t = g.elements.find((e) => e.id === "head")!;
    const lines = (t.props as { text: string }).text.split(String.fromCharCode(10));
    expect(lines.length).toBeGreaterThan(1);
    const px = 0.09 * 720, box = 0.4 * 1280;
    for (const l of lines) expect(ESTIMATE_METER.width(l, px, { bold: true })).toBeLessThanOrEqual(box + 0.75);
    expect(lines.join(" ")).toBe("You approve, then it renders");
    expect(validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER }).ok).toBe(true);
  });
});
