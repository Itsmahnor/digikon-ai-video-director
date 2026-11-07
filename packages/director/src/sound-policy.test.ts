import { describe, expect, it } from "vitest";
import { ALL_SOUND, soundPolicyIssues, soundPolicyOf, soundRuleText, systemSoundFor, VISUAL_SYSTEMS, EditPlan } from "@digikon/contracts";
import { DemoClient, buildDirectorGraph, requestedAudioIssues, unrequestedAudioIssues, type GenerateRequest } from "./index.js";
import { cfg, deps, input, project, recipes } from "./fixtures.js";
import { RecipeLibrary } from "@digikon/recipes";

describe("what the brief says about sound", () => {
  const cases: [string, Partial<typeof ALL_SOUND>][] = [
    ["A brand film. Narration only, no music.", { music: false, narration: true, effects: false }],
    ["Sound: narration (voice-over), no music.", { music: false, narration: true }],
    ["Sound: music only, no voice-over.", { music: true, narration: false, effects: false }],
    ["Sound: silent, text on screen only.", { music: false, narration: false, effects: false }],
    ["No sound effects please.", { music: true, narration: true, effects: false }],
    ["Make it warm. Sound: narration and music.", { music: true, narration: true, effects: true }],
    ["A calm film about our roastery.", { music: true, narration: true, effects: true }],
  ];
  it.each(cases)("%s", (text, want) => expect(soundPolicyOf(text)).toMatchObject(want));

  it("replaces a visual system's sound line when the brief decides, and leaves it alone otherwise", () => {
    const cinema = VISUAL_SYSTEMS.cinema.sound;
    expect(cinema).toContain("slow score");
    const out = systemSoundFor(cinema, soundPolicyOf("Narration only, no music."));
    expect(out).toContain("narration with silence between the lines");
    expect(out).toContain("no music bed");
    expect(out).toContain("This replaces the system's usual sound");
    expect(out).toContain("hold titles");
    expect(systemSoundFor(cinema, ALL_SOUND)).toBe(cinema);
    expect(soundRuleText(ALL_SOUND)).toBe("");
  });

  it("flags a score or a voice-over the brief rules out, and nothing else", () => {
    const scenes = [{ scene_id: "S01", voiceover: "Our story begins here.", audio_cues: ["a slow score under the whole film"] }, { scene_id: "S02", voiceover: null, audio_cues: ["a soft chime"] }];
    const narrationOnly = soundPolicyIssues(scenes, soundPolicyOf("Narration only, no music."));
    expect(narrationOnly.some((x) => x.startsWith("S01") && /music/.test(x))).toBe(true);
    expect(narrationOnly.some((x) => x.startsWith("S02") && /effect/.test(x))).toBe(true);
    expect(narrationOnly.some((x) => /voiceover/.test(x))).toBe(false); // narration is allowed
    const noVoice = soundPolicyIssues(scenes, soundPolicyOf("Music only, no voice-over."));
    expect(noVoice.some((x) => x.startsWith("S01") && /narration/.test(x))).toBe(true);
    expect(soundPolicyIssues(scenes, ALL_SOUND)).toEqual([]);
  });

  it("refuses a music recipe in the edit plan when music is ruled out, but accepts loudness for the narration", () => {
    const use = (id: string, recipe: string) => ({ use_id: id, scene_id: "S01", recipe_id: recipe, params: {}, rationale: "x" });
    const lib = new RecipeLibrary(recipes, "draft");
    const mixers = recipes.filter((r) => r.operation_type === "mix_audio").map((r) => r.recipe_id);
    expect(mixers.length).toBeGreaterThan(0);
    const music = mixers.find((r) => /music|duck/.test(r)), loud = mixers.find((r) => /loud/.test(r));
    const p = { ...project, brief: "A brand film. Narration only, no music." };
    if (music) expect(unrequestedAudioIssues(EditPlan.parse({ project_id: "p", version: 1, uses: [use("U01", music)] }), { scenes: [] } as never, { recipes: lib }, p)).toEqual([expect.stringContaining("audio_not_requested")]);
    if (loud) expect(unrequestedAudioIssues(EditPlan.parse({ project_id: "p", version: 1, uses: [use("U01", loud)] }), { scenes: [] } as never, { recipes: lib }, p)).toEqual([]);
  });
});

/** A model that records every prompt it is shown, always calls the film Cinema, and can be made to plan a score the brief rules out. */
class Spy extends DemoClient {
  prompts: { name: string; user: string }[] = [];
  constructor(private readonly stubborn: boolean) { super({ creative: true }); }
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    this.prompts.push({ name: req.name, user: req.user });
    const out = (await super.generate(req)) as any;
    if (req.name === "treatment" && out.art_direction) out.art_direction = { ...out.art_direction, visual_system: "cinema" };
    if (req.name === "storyboard" && out.scenes?.length) {
      const repair = /Problems found in your previous answer/.test(req.user);
      // first attempt (or a stubborn model): the system's habit, a slow score. A good repair does what the brief says: narration, no score.
      if (this.stubborn || !repair) out.scenes[0] = { ...out.scenes[0], audio_cues: ["a slow score under the whole film"] };
      else out.scenes[0] = { ...out.scenes[0], voiceover: "Our story begins here.", audio_cues: [] };
    }
    return req.schema.parse(out);
  }
}
const BRIEF = "A cinematic brand film, our story, for the founder. Sound: narration (voice-over), no music. Hold the titles; slow pacing.";
const run = (llm: Spy, id: string) => buildDirectorGraph(deps(llm as never)).invoke({ ...input, assets: [], project: { ...input.project, brief: BRIEF } } as never, cfg(id)) as Promise<any>;

describe("the sound rule reaches the model and is carried out", () => {
  it("every Director prompt carries the rule, and the Cinema system's own sound line is replaced by it", async () => {
    const llm = new Spy(false);
    await run(llm, "sound-prompts");
    for (const name of ["treatment", "storyboard"]) {
      const p = llm.prompts.find((x) => x.name === name)!;
      expect(p.user, name).toContain("Sound rule from the brief");
      expect(p.user, name).toContain("narration with silence between the lines");
    }
    // what the user chose in the setup (it arrives as the brief) is in the treatment prompt word for word
    expect(llm.prompts.find((x) => x.name === "treatment")!.user).toContain(BRIEF);
    // and the storyboard sees the brief itself, not only the treatment's summary of it
    expect(llm.prompts.find((x) => x.name === "storyboard")!.user).toContain(BRIEF);
    const story = llm.prompts.find((x) => x.name === "storyboard")!.user;
    expect(story).toContain("This film is made in the Cinema system");
    expect(story).toContain("This replaces the system's usual sound");
    expect(story).not.toMatch(/Its sound: A slow score under the whole film/);
    expect(story).toContain("hold titles");
  });

  it("a storyboard that plans the system's score is sent back, and the repaired plan has no music cue", async () => {
    const llm = new Spy(false);
    const r = await run(llm, "sound-repair");
    expect(llm.prompts.filter((x) => x.name === "storyboard").length).toBeGreaterThanOrEqual(2);
    expect(llm.prompts.filter((x) => x.name === "storyboard").at(-1)!.user).toContain("sound_policy");
    expect(r.status).toBe("awaiting_approval");
    expect(r.scenePlan.scenes.flatMap((s: any) => s.audio_cues).join(" ")).not.toMatch(/score|music/i);
  });

  it("a model that keeps planning the score never reaches Gate 1", async () => {
    const llm = new Spy(true);
    const r = await run(llm, "sound-stubborn");
    expect(r.status).toBe("escalated");
    expect(JSON.stringify(r.escalation)).toContain("sound_policy");
  });
});

/** A model that writes a voice-over too long for its scene the first time, and a fitting one when it is sent back. */
class LongTalker extends DemoClient {
  prompts: { name: string; user: string }[] = [];
  constructor() { super({ creative: true }); }
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    this.prompts.push({ name: req.name, user: req.user });
    const out = (await super.generate(req)) as any;
    if (req.name === "storyboard" && out.scenes?.length) {
      const repair = /Problems found in your previous answer/.test(req.user);
      const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
      const seconds = out.scenes[0].duration_seconds;
      out.scenes[0] = { ...out.scenes[0], voiceover: words(repair ? Math.floor(seconds * 2.8) : Math.ceil(seconds * 2.8) + 8), audio_cues: [] };
    }
    return req.schema.parse(out);
  }
}
describe("a voice-over that cannot be spoken in its scene is caught while the storyboard can still change", () => {
  it("the prompt states the pace, the too-long voice-over is sent back with the limit, and the fitting one reaches Gate 1", async () => {
    const llm = new LongTalker();
    const r: any = await buildDirectorGraph(deps(llm as never)).invoke({ ...input, assets: [], project: { ...input.project, brief: "A calm brand film. Sound: narration (voice-over), no music." } } as never, cfg("long-vo"));
    const story = llm.prompts.filter((x) => x.name === "storyboard");
    expect(story[0]!.user).toContain("Narration is spoken at about 2.8 words a second");
    expect(story.length).toBeGreaterThanOrEqual(2);
    expect(story.at(-1)!.user).toContain("voiceover_too_long");
    expect(r.status).toBe("awaiting_approval");
  });
});

describe("a brief that says nothing about sound is not left silent when this machine can speak", () => {
  const silent = { scenes: [{ scene_id: "S01", voiceover: null, audio_cues: [] }] } as never;
  const spoken = { scenes: [{ scene_id: "S01", voiceover: "Hello there.", audio_cues: [] }] } as never;
  it("asks for a voiceover only when narration can be produced", () => {
    expect(requestedAudioIssues({ brief: "A 20 second promo for a bakery." }, silent, [], false)).toEqual([]);
    expect(requestedAudioIssues({ brief: "A 20 second promo for a bakery." }, silent, [], true)).toEqual([expect.stringContaining("spoken voiceover")]);
  });
  it("is satisfied once a scene has a voiceover", () => {
    expect(requestedAudioIssues({ brief: "A promo for a bakery." }, spoken, [], true)).toEqual([]);
  });
  it("never overrides the brief: silent, music only or no narration stay as written", () => {
    for (const brief of ["A promo. Sound: silent, text on screen only.", "A promo. Sound: music only, no voice-over.", "A promo with no narration."]) expect(requestedAudioIssues({ brief }, silent, [], true).filter((x) => x.includes("spoken voiceover"))).toEqual([]);
  });
});
