import type { GenerateRequest, LlmClient } from "./llm.js";

/**
 * DEMO ONLY. Canned, rule-based answers so the console can be exercised without an API key.
 * It is not Claude and does not understand briefs. The console shows a banner whenever it is active.
 */
export class DemoClient implements LlmClient {
  readonly model = "demo-scripted (not Claude)";
  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const out = this.answer(req.name, req.user);
    return req.schema.parse(out);
  }

  private answer(name: string, user: string): unknown {
    switch (name) {
      case "route_decision": return this.route(user);
      case "intake_result": return { status: "ready", questions: [] };
      case "treatment": return this.treatment(user);
      case "storyboard": return this.storyboard(user);
      case "edit_plan": return this.editPlan(user);
      default: throw new Error(`demo client does not know "${name}"`);
    }
  }

  private route(user: string) {
    const convo = [...user.matchAll(/<user[^>]*>\n([\s\S]*?)\n<\/user>/g)].map((m) => m[1]).join(" ");
    const inv = JSON.parse(/## Asset inventory[^\n]*\n([\s\S]*?)\n## Conversation/.exec(user)![1]!);
    const platform = /(instagram reels|instagram|tiktok|youtube shorts|youtube|linkedin|facebook|snapchat)/i.exec(convo)?.[1] ?? null;
    const dur = /(\d{1,3})\s*(?:s\b|sec|second)/i.exec(convo)?.[1];
    const editWords = /\b(edit|cut|trim|caption|subtitle|crop|fix|remove|speed|enhance|add music)\b/i.test(convo);
    const mode = inv.videos >= 1 && editWords ? "edit_existing" : (inv.videos + inv.images) >= 1 ? "create_full" : "create_minimal";
    const instructions = mode === "edit_existing" ? convo.split(/[,.;]| and /i).map((s: string) => s.trim()).filter((s: string) => s.length > 3).slice(0, 6) : [];
    const objective = convo.split(/[.!?]/)[0]!.trim().slice(0, 140) || null;
    const questions = !platform && mode !== "edit_existing" ? ["Where will this video be shown (for example Instagram Reels, TikTok or YouTube)?"] : [];
    return {
      mode, confidence: 0.9, rationale: "Demo rule: edit words with a video means edit; any footage means full build; otherwise minimal.",
      fields: {
        objective: mode === "edit_existing" ? null : objective, audience: null, platform, aspect_ratio: null,
        target_duration_s: dur ? Number(dur) : null, tone: null, language: null, edit_instructions: instructions,
      },
      questions,
    };
  }

  private target(user: string): number {
    const m = /"target_duration":\s*([\d.]+)/.exec(user);
    return m ? Number(m[1]) : 15;
  }

  private treatment(user: string) {
    const total = this.target(user);
    const facts = [...user.matchAll(/\[(F\d+)\] ([^\n]+)/g)].map((m) => ({ id: m[1]!, text: m[2]! }));
    const claims = [
      ...facts.slice(0, 2).map((f, i) => ({ claim_id: `C0${i + 1}`, text: f.text, brand_fact_id: f.id })),
      { claim_id: "C09", text: "The best you can buy", brand_fact_id: null, kind: "factual", safe_alternative: "Let the product shots speak; no ranking claim." },
    ];
    const a = Math.round(total * 0.35 * 2) / 2, c = Math.max(2, Math.min(4, Math.round(total * 0.2 * 2) / 2));
    return {
      logline: "A confident, simple story that ends on one clear action.", hook: "Open on the most striking real view.", tone: "warm and direct",
      beats: [
        { beat: "Hook", purpose: "Stop the scroll with a concrete visual", approx_seconds: a },
        { beat: "Proof", purpose: "Show the detail that earns trust", approx_seconds: Math.round((total - a - c) * 2) / 2 },
        { beat: "Call to action", purpose: "Invite one action", approx_seconds: c },
      ],
      cta: "Order today", claims,
      conflicts_log: [{ conflict: "Style wanted a superlative claim", decision: "Dropped: no approved fact supports it (claims rule wins)." }],
    };
  }

  private storyboard(user: string) {
    const total = this.target(user);
    const block = /## Assets and notes[^\n]*\n([\s\S]*?)\n\n## /.exec(user)?.[1];
    const parsed = block ? JSON.parse(block) : { assets: [], notes: [] };
    const videos = (parsed.assets as { asset_id: string; media_type: string; duration: number | null }[]).filter((a) => a.media_type === "video");
    const notes = parsed.notes as { asset_id: string; usable_segments: { start: number; end: number }[] }[];
    const maxScene = Number(/No scene may be longer than ([\d.]+)s/.exec(user)?.[1] ?? 8);
    const half = (n: number) => Math.round(n * 2) / 2;

    const cta = Math.max(2, Math.min(4, half(total * 0.2)));
    const hook = Math.min(maxScene, half(total * 0.3));
    let middle = half(total - hook - cta);
    const middleScenes: number[] = [];
    const parts = Math.max(1, Math.ceil(middle / Math.min(maxScene, 6)));
    for (let i = 0; i < parts; i++) { const d = i === parts - 1 ? middle : half(middle / (parts - i)); middleScenes.push(d); middle = half(middle - d); }
    const ctaDur = Math.round((total - hook - middleScenes.reduce((a, b) => a + b, 0)) * 100) / 100;

    const used: Record<string, number> = {};
    /** First stretch of any video that is long enough, starting after anything already used from that asset. */
    const withVideo = (dur: number) => {
      for (const v of videos) {
        const segs = notes.find((n) => n.asset_id === v.asset_id)?.usable_segments ?? [{ start: 0, end: v.duration ?? 0 }];
        for (const s of segs) {
          const start = Math.max(s.start, used[v.asset_id] ?? 0);
          if (start + dur <= s.end + 1e-6) { used[v.asset_id] = start + dur; return { asset_ids: [v.asset_id], source_in_seconds: Math.round(start * 100) / 100 }; }
        }
      }
      return { asset_ids: [] as string[], source_in_seconds: 0 };
    };
    const shot = (size: string, motion: string, action: string) => ({ shot_size: size, camera_motion: motion, visual_action: action });
    const hasClaim = /"claim_id": "C01"/.test(user);
    const sizes = ["medium", "close_up", "wide"];
    /** What the scene needs: the supplied clip it uses, or graphics the workflow can build. */
    const needs = (v: { asset_ids: string[] }, graphics: string) => v.asset_ids.length
      ? [{ need: "Supplied footage", kind: "footage", availability: "supplied", asset_id: v.asset_ids[0] }]
      : [{ need: graphics, kind: "graphics", availability: "generate_graphics" }];
    const hookVideo = withVideo(hook);
    return {
      scenes: [
        { scene_id: "S01", purpose: "Hook", duration_seconds: hook, ...hookVideo, required_assets: needs(hookVideo, "Animated opening graphics"), shot: shot("close_up", "slow_push_in", "Opening hero view"), overlay: { text: "Made fresh, made to be noticed", safe_area: "platform_safe" }, transition_out: "cut" },
        ...middleScenes.map((d, i) => {
          const v = withVideo(d);
          return { scene_id: `S${String(i + 2).padStart(2, "0")}`, purpose: "Proof", duration_seconds: d, ...v, required_assets: needs(v, "Animated detail graphics"), shot: shot(sizes[i % 3]!, i % 2 ? "pan_right" : "static", "Detail that earns trust"), claim_ids: i === 0 && hasClaim ? ["C01"] : [], overlay: null, transition_out: "cut" };
        }),
        { scene_id: `S${String(middleScenes.length + 2).padStart(2, "0")}`, purpose: "Call to action", duration_seconds: ctaDur, asset_ids: [], required_assets: [{ need: "End card graphics", kind: "graphics", availability: "generate_graphics" }], shot: shot("wide", "static", "Brand end card"), overlay: { text: "Order today", safe_area: "platform_safe" }, transition_out: "cut" },
      ],
    };
  }
  private editPlan(user: string) {
    const scenes = JSON.parse(/## Scenes\n([\s\S]*?)\n\n## /.exec(user)![1]!) as { scene_id: string; overlay: unknown; media: string[]; duration_seconds: number }[];
    const uses: unknown[] = [];
    let n = 1;
    const add = (scene_id: string, recipe_id: string, rationale: string) => uses.push({ use_id: `U${String(n++).padStart(2, "0")}`, scene_id, recipe_id, params: {}, rationale });
    scenes.forEach((s, i) => {
      const last = i === scenes.length - 1;
      if (last) add(s.scene_id, "end-card-cta", "Closing card holds the call to action.");
      else {
        if (s.media.includes("video") && s.duration_seconds >= 1.5) add(s.scene_id, "slow-push-in", "Gentle push builds focus on the real footage.");
        if (s.overlay) add(s.scene_id, "text-fade-up", "Simple, readable headline entrance.");
      }
    });
    add(scenes[scenes.length - 1]!.scene_id, "loudness-normalise", "Level the final mix once, at the end.");
    return { uses };
  }
}
