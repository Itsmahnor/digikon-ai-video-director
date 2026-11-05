import { describe, expect, it } from "vitest";
import { DemoClient, buildDirectorGraph } from "./index.js";
import { cfg, deps, input } from "./fixtures.js";

describe("the stub model and a brief that asks for sound", () => {
  it("answers the checker's audio_requested note with a voiceover and a chime, so the run reaches Gate 1 instead of escalating", async () => {
    const brief = "A 12 second YouTube explainer for my online course, with a voiceover and a soft chime.";
    const g = buildDirectorGraph(deps(new DemoClient({ creative: true }) as never));
    const r = await g.invoke({ ...input, project: { ...input.project, brief } } as never, cfg("demo-audio"));
    expect(r.status).toBe("awaiting_approval");
    expect(r.gate).toBe("storyboard");
    expect(r.scenePlan!.scenes[0]).toMatchObject({ voiceover: expect.any(String), audio_cues: ["a soft chime"] });
    expect(r.scenePlan!.scenes.slice(1).every((s) => !s.voiceover && s.audio_cues.length === 0)).toBe(true);
  });
  it("a brief that asks for no sound gets none", async () => {
    const g = buildDirectorGraph(deps(new DemoClient({ creative: true }) as never));
    const r = await g.invoke(input as never, cfg("demo-nosound"));
    expect(r.scenePlan!.scenes.every((s) => !s.voiceover && s.audio_cues.length === 0)).toBe(true);
  });
});