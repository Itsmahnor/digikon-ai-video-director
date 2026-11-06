import type { GenerateRequest, LlmClient } from "./llm.js";
import { composeScene } from "./demo-compose.js";
import { detectCategory } from "./video-types.js";

/**
 * DEMO ONLY. Canned, rule-based answers so the console can be exercised without an API key.
 * It is not Claude and does not understand briefs. The console shows a banner whenever it is active.
 */
export class DemoClient implements LlmClient {
  /** `creative` answers with art direction and drawn visuals, the way the real Director now must. Without it the canned answers are the older, plainer ones. */
  constructor(private readonly opts: { creative?: boolean; compose?: boolean } = {}) {}
  get predatesArtDirection(): boolean { return !this.opts.creative; }
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
      case "editor_review": return { conflicts: [], revision_requests: [] }; // the demo reviewer has no opinions
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

  private extractCategory(user: string): "saas" | "ecommerce" | "general-promo" {
    const targetMatch = /## Target\n([\s\S]*?)(?:\n\n|\n##|$)/.exec(user);
    const target = targetMatch ? (() => { try { return JSON.parse(targetMatch[1]!); } catch { return {}; } })() : {};
    if (target.video_category) return target.video_category;
    const briefMatch = /<brief>\n([\s\S]*?)\n<\/brief>/.exec(user);
    const brief = briefMatch ? briefMatch[1]! : "";
    return detectCategory(brief);
  }

  private treatment(user: string) {
    const total = this.target(user);
    const category = this.extractCategory(user);
    const facts = [...user.matchAll(/\[(F\d+)\] ([^\n]+)/g)].map((m) => ({ id: m[1]!, text: m[2]! }));
    const claims = [
      ...facts.slice(0, 2).map((f, i) => ({ claim_id: `C0${i + 1}`, text: f.text, brand_fact_id: f.id })),
      { claim_id: "C09", text: "The best you can buy", brand_fact_id: null, kind: "factual", safe_alternative: "Let the product shots speak; no ranking claim." },
    ];
    const a = Math.round(total * 0.35 * 2) / 2, c = Math.max(2, Math.min(4, Math.round(total * 0.2 * 2) / 2));
    const midSec = Math.round((total - a - c) * 2) / 2;

    if (category === "saas") {
      const trialFact = facts.find((f) => /14\s*days/i.test(f.text));
      return {
        logline: "Automate calendar scheduling in one click, without the back-and-forth.",
        hook: "Stop losing hours to manual calendar scheduling.",
        tone: "calm, efficient, and precise",
        beats: [
          { beat: "Hook", purpose: "Show the scheduling bottleneck and double bookings", approx_seconds: a },
          { beat: "Demo", purpose: "Demonstrate 1-click calendar sync and automatic availability", approx_seconds: midSec },
          { beat: "Call to action", purpose: "Invite user to start free trial", approx_seconds: c },
        ],
        cta: trialFact ? "Start 14-day free trial" : "Start free trial",
        claims,
        ...(!this.opts.creative ? {} : { art_direction: {
          audience_response: "The viewer should feel relief from administrative friction and try the app.",
          concept: "Scheduling reduced to one click.",
          visual_metaphor: null,
          visual_system: "saas_clarity",
          palette: { background: "#0b132b", surface: "#1c2541", text: "#ffffff", muted: "#a0aec0", accent: "#48cae4", accent_2: "#5bc0be" },
          typography: { weight: "bold", scale: "standard", case: "sentence", rationale: "Clean technical sans-serif for software readability." },
          composition: "Left-aligned headline with clear interface viewport and generous padding.",
          motion_language: { feel: "precise", easing: "ease_out", description: "Elements ease smoothly and hold still on key outcomes." },
          narrative: { opening: "Expose the workflow friction.", development: "Demonstrate the seamless software workflow.", conclusion: "Close with clear free-trial sign-up action." },
        } }),
        conflicts_log: [{ conflict: "Style wanted a superlative claim", decision: "Dropped: no approved fact supports it (claims rule wins)." }],
      };
    }

    if (category === "ecommerce") {
      return {
        logline: "Engineered for speed: lightweight responsive cushioning with high-traction grip.",
        hook: "Feel the responsive bounce in every stride.",
        tone: "dynamic, athletic, and tactile",
        beats: [
          { beat: "Hook", purpose: "Arrest attention with the shoe in motion", approx_seconds: a },
          { beat: "Proof", purpose: "Showcase responsive sole technology and breathable upper", approx_seconds: midSec },
          { beat: "Call to action", purpose: "Direct runners to visit store and gear up", approx_seconds: c },
        ],
        cta: "Visit store today",
        claims,
        ...(!this.opts.creative ? {} : { art_direction: {
          audience_response: "Runners should feel motivated to test the shoes in store.",
          concept: "High-speed cushioning in motion.",
          visual_metaphor: null,
          visual_system: "product_bench",
          palette: { background: "#111111", surface: "#222222", text: "#ffffff", muted: "#888888", accent: "#e63946", accent_2: "#f4a261" },
          typography: { weight: "bold", scale: "large", case: "upper", rationale: "Bold uppercase typography channels athletic energy and impact." },
          composition: "Diagonal product hero staging with high visual contrast.",
          motion_language: { feel: "snappy", easing: "ease_out", description: "Snappy momentum matched to athletic movement." },
          narrative: { opening: "Hero runner footage bursts into frame.", development: "Showcase tactile technical details.", conclusion: "Clear store location call to action." },
        } }),
        conflicts_log: [{ conflict: "Style wanted a superlative claim", decision: "Dropped: no approved fact supports it (claims rule wins)." }],
      };
    }

    // Default: general-promo
    return {
      logline: "Small-batch craft coffee roasted weekly for the freshest cup at home.",
      hook: "Great coffee begins the day it was roasted.",
      tone: "warm and direct",
      beats: [
        { beat: "Hook", purpose: "Open on freshly roasted coffee beans in small batches", approx_seconds: a },
        { beat: "Proof", purpose: "Show the small-batch craft that ensures peak flavor", approx_seconds: midSec },
        { beat: "Call to action", purpose: "Invite coffee lovers to order their first bag", approx_seconds: c },
      ],
      cta: "Order your first bag",
      claims,
      ...(!this.opts.creative ? {} : { art_direction: {
        audience_response: "The viewer should feel confident enough to place one order.",
        concept: "One honest view of the product, then one action.",
        visual_metaphor: null,
        visual_system: "cinema",
        palette: { background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#b8430a", accent_2: "#2b8a6e" },
        typography: { weight: "bold", scale: "standard", case: "sentence", rationale: "Bold sentence case reads as warm and direct." },
        composition: "Headline on the left or top, one picture beside it, generous margins.",
        motion_language: { feel: "precise", easing: "ease_out", description: "Elements ease out of place and every scene ends held still." },
        narrative: { opening: "Open on the most concrete view.", development: "Show the detail that earns trust.", conclusion: "Hold on one clear action." },
      } }),
      conflicts_log: [{ conflict: "Style wanted a superlative claim", decision: "Dropped: no approved fact supports it (claims rule wins)." }],
    };
  }

  private storyboard(user: string) {
    const total = this.target(user);
    const category = this.extractCategory(user);
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
    const hasClaim2 = /"claim_id": "C02"/.test(user);
    const sizes = ["medium", "close_up", "wide"];
    /** What the scene needs: the supplied clip it uses, or graphics the workflow can build. */
    const needs = (v: { asset_ids: string[] }, graphics: string) => v.asset_ids.length
      ? [{ need: "Supplied footage", kind: "footage", availability: "supplied", asset_id: v.asset_ids[0] }]
      : [{ need: graphics, kind: "graphics", availability: "generate_graphics" }];
    const hookVideo = withVideo(hook);

    let scenes: Record<string, unknown>[];

    if (category === "saas") {
      const hookVis = hookVideo.asset_ids.length || !this.opts.creative ? {} : {
        visual: { block: "message_thread", messages: [{ from: "them", text: "Can we find 15 mins this week?" }, { from: "you", text: "Sent you my direct booking link!" }], mode: "stack", camera: "push_in", reveal: "none", backdrop: "flat" },
      };
      scenes = [
        { scene_id: "S01", purpose: "Hook", ...(this.opts.creative ? { visual_purpose: "Open on calendar scheduling friction" } : {}), ...hookVis, duration_seconds: hook, ...hookVideo, required_assets: needs(hookVideo, "Animated scheduling graphics"), shot: shot("medium", "slow_push_in", "Scheduling booking interface"), overlay: { text: "Automate your calendar bookings", safe_area: "platform_safe" }, transition_out: "cut" },
        ...middleScenes.map((d, i) => {
          const v = withVideo(d);
          const blocks = [
            { block: "process_flow", steps: [{ label: "Connect calendar", detail: "Google & Outlook" }, { label: "Auto-sync", detail: "Instant updates" }] },
            { block: "layered_cards", depth: "subtle", cards: [{ title: "Fewer back-and-forths", detail: null }, { title: "One booking link", detail: null }] },
          ];
          const vis = v.asset_ids.length || !this.opts.creative ? {} : { visual: { ...blocks[i % 2]!, camera: i % 2 ? "static" : "pan_right", reveal: "none", backdrop: i % 2 ? "grid" : "dots" } };
          const purposeDesc = i % 2 ? "Layered cards showing the booking flow" : "Process flow showing 2-way sync";
          return {
            scene_id: `S${String(i + 2).padStart(2, "0")}`, purpose: "Proof",
            ...(this.opts.creative ? { visual_purpose: `Proof ${i + 1}: ${purposeDesc}` } : {}),
            ...vis, duration_seconds: d, ...v,
            required_assets: needs(v, "Animated interface graphics"),
            shot: shot(sizes[i % 3]!, i % 2 ? "static" : "pan_right", "Interface demonstration"),
            claim_ids: i === 0 && hasClaim ? ["C01"] : i === 1 && hasClaim2 ? ["C02"] : [],
            overlay: null, transition_out: "cut",
          };
        }),
        { scene_id: `S${String(middleScenes.length + 2).padStart(2, "0")}`, purpose: "Call to action", ...(this.opts.creative ? { visual_purpose: "Close on free trial call to action", visual: { block: "end_card", wordmark: null, button: "Start free trial", subline: "Works with Google Calendar and Outlook", camera: "push_in", reveal: "none", backdrop: "gradient" } } : {}), duration_seconds: ctaDur, asset_ids: [], required_assets: [{ need: "End card graphics", kind: "graphics", availability: "generate_graphics" }], shot: shot("wide", "slow_push_in", "Trial sign-up end card"), overlay: { text: "Start your free trial today", safe_area: "platform_safe" }, transition_out: "cut" },
      ];
    } else if (category === "ecommerce") {
      const hookVis = hookVideo.asset_ids.length || !this.opts.creative ? {} : {
        visual: { block: "kinetic_type", style: "word_pop", emphasis_word: 1, camera: "push_in", reveal: "none", backdrop: "spotlight" },
      };
      scenes = [
        { scene_id: "S01", purpose: "Hook", ...(this.opts.creative ? { visual_purpose: "Arrest attention with the shoe in motion" } : {}), ...hookVis, duration_seconds: hook, ...hookVideo, required_assets: needs(hookVideo, "Product hero graphics"), shot: shot("close_up", "slow_push_in", "Shoe in motion"), overlay: { text: "Engineered for speed", safe_area: "platform_safe" }, transition_out: "cut" },
        ...middleScenes.map((d, i) => {
          const v = withVideo(d);
          const blocks = [
            { block: "layered_cards", depth: "prominent", cards: [{ title: "Lightweight foam", detail: "Responsive bounce" }, { title: "Engineered grip", detail: "All-weather traction" }] },
            { block: "process_flow", steps: [{ label: "Step in", detail: "Sock-like fit" }, { label: "Push off", detail: "High energy return" }] },
          ];
          const vis = v.asset_ids.length || !this.opts.creative ? {} : { visual: { ...blocks[i % 2]!, camera: i % 2 ? "pan_right" : "static", reveal: "none", backdrop: "spotlight" } };
          return {
            scene_id: `S${String(i + 2).padStart(2, "0")}`, purpose: "Proof",
            ...(this.opts.creative ? { visual_purpose: `Proof ${i + 1}: ${i % 2 ? "stride flow" : "cushioning and grip cards"}` } : {}),
            ...vis, duration_seconds: d, ...v,
            required_assets: needs(v, "Product detail graphics"),
            shot: shot(sizes[i % 3]!, i % 2 ? "pan_right" : "static", "Product detail demonstration"),
            claim_ids: i === 0 && hasClaim ? ["C01"] : [],
            overlay: null, transition_out: "cut",
          };
        }),
        { scene_id: `S${String(middleScenes.length + 2).padStart(2, "0")}`, purpose: "Call to action", ...(this.opts.creative ? { visual_purpose: "Close on store visit call to action", visual: { block: "end_card", wordmark: null, button: "Visit store today", subline: "Available in all sizes", camera: "push_in", reveal: "none", backdrop: "flat" } } : {}), duration_seconds: ctaDur, asset_ids: [], required_assets: [{ need: "End card graphics", kind: "graphics", availability: "generate_graphics" }], shot: shot("wide", "slow_push_in", "Store visit end card"), overlay: { text: "Visit store today", safe_area: "platform_safe" }, transition_out: "cut" },
      ];
    } else {
      // General promo
      const hookVis = hookVideo.asset_ids.length || !this.opts.creative ? {} : {
        visual: { block: "kinetic_type", style: "word_pop", emphasis_word: 1, camera: "push_in", reveal: "none", backdrop: "gradient" },
      };
      scenes = [
        { scene_id: "S01", purpose: "Hook", ...(this.opts.creative ? { visual_purpose: "Open on freshly roasted coffee beans" } : {}), ...hookVis, duration_seconds: hook, ...hookVideo, required_assets: needs(hookVideo, "Animated opening graphics"), shot: shot("close_up", "slow_push_in", "Opening hero view"), overlay: { text: "Roasted weekly in small batches", safe_area: "platform_safe" }, transition_out: "cut" },
        ...middleScenes.map((d, i) => {
          const v = withVideo(d);
          const blocks = [
            { block: "timeline_path", marks: [{ when: "Roast", label: "Small batches" }, { when: "Pack", label: "Sealed fresh" }, { when: "Ship", label: "To your door" }] },
            { block: "title_plate", eyebrow: null, subline: null, plate: "hairline" },
          ];
          const vis = v.asset_ids.length || !this.opts.creative ? {} : { visual: { ...blocks[i % 2]!, camera: i % 2 ? "pan_right" : "static", reveal: "none", backdrop: "flat" } };
          return {
            scene_id: `S${String(i + 2).padStart(2, "0")}`, purpose: "Proof",
            ...(this.opts.creative ? { visual_purpose: `Proof ${i + 1}: ${i % 2 ? "how it works" : "the layers of the detail"}` } : {}),
            ...vis, duration_seconds: d, ...v,
            required_assets: needs(v, "Animated detail graphics"),
            shot: shot(sizes[i % 3]!, i % 2 ? "pan_right" : "static", "Detail that earns trust"),
            claim_ids: i === 0 && hasClaim ? ["C01"] : [],
            overlay: this.opts.creative && !v.asset_ids.length && i % 2 ? { text: "Fresh to the last cup", safe_area: "platform_safe" } : null, transition_out: "cut",
          };
        }),
        { scene_id: `S${String(middleScenes.length + 2).padStart(2, "0")}`, purpose: "Call to action", ...(this.opts.creative ? { visual_purpose: "Close on invitation to order", visual: { block: "closing_signature", wordmark: null, action: "Order your first bag", subline: null, camera: "push_in", reveal: "none", backdrop: "gradient" } } : {}), duration_seconds: ctaDur, asset_ids: [], required_assets: [{ need: "End card graphics", kind: "graphics", availability: "generate_graphics" }], shot: shot("wide", "slow_push_in", "Brand end card"), overlay: { text: "Order your first bag", safe_area: "platform_safe" }, transition_out: "cut" },
      ];
    }

    // asked to compose: each drawn scene gets a layout of its own, written from the film's own words, instead of a fixed block
    if (this.opts.compose && this.opts.creative) {
      const tr = (() => { const i = user.indexOf("## Treatment" + String.fromCharCode(10) + "{"); if (i < 0) return null; const j = user.indexOf(String.fromCharCode(10, 10) + "## ", i); try { return JSON.parse(user.slice(i + 13, j < 0 ? undefined : j)) as { logline: string; hook: string; cta: string }; } catch { return null; } })();
      if (tr) {
        scenes = scenes.map((sc, i) => {
          if ((sc["asset_ids"] as string[] | undefined)?.length || !sc["visual"]) return sc;
          const kind = i === 0 ? "open" : i === scenes.length - 1 ? "close" : "middle";
          const shot = sc["shot"] as { camera_motion: string };
          const overlay = (sc["overlay"] as { text: string } | null)?.text ?? null;
          return { ...sc, visual: composeScene(kind, i, shot.camera_motion, { logline: tr.logline, hook: tr.hook, cta: tr.cta, overlay }) };
        });
      }
    }    // when the checker sends the storyboard back because the brief asked for sound, the stub answers the way a model would: a short voiceover and a chime in the first scene
    if (/audio_requested/.test(user) && scenes.length) scenes[0] = { ...scenes[0], voiceover: "Welcome. Here is the short version.", audio_cues: ["a soft chime"] };    return this.placePictures({ scenes }, user);
  }

  /** Canned placement for the demo: each usable picture takes over a scene, a logo the opening one. What reaches the scene is only what the manifest listed. */
  private placePictures(plan: { scenes: Record<string, unknown>[] }, user: string) {
    const block = /## Asset manifest[^\n]*\n([\s\S]*?)\n\n## /.exec(user)?.[1];
    if (!block || !this.opts.creative) return plan;
    const manifest = JSON.parse(block) as { asset_id: string; usage: string; categories: { category: string }[]; caveats: string[] }[];
    const isLogo = (m: (typeof manifest)[number]) => /logo/.test(m.categories[0]?.category ?? "");
    const usable = manifest.filter((m) => (m.usage === "auto" || m.usage === "must_use" || m.usage === "optional") && (m.caveats.length === 0 || m.usage === "must_use")).sort((a, b) => Number(isLogo(b)) - Number(isLogo(a)));
    usable.slice(0, plan.scenes.length).forEach((m, i) => {
      const logo = isLogo(m), scene = plan.scenes[i]!;
      const screen = /screenshot|dashboard/.test(m.categories[0]?.category ?? "");
      Object.assign(scene, {
        visual: { block: "asset_stage", backdrop: "flat" }, asset_ids: [m.asset_id], source_in_seconds: 0, overlay: null, claim_ids: [], visual_purpose: `Shows picture ${i + 1} of the upload: ${m.categories[0]?.category ?? "unknown"}`,
        required_assets: [{ need: logo ? "The uploaded logo" : "The uploaded picture", kind: logo ? "logo" : screen ? "ui_screenshot" : "image", availability: "supplied", asset_id: m.asset_id }],
        asset_refs: [{ asset_id: m.asset_id, role: logo ? "logo" : screen ? "screen" : "hero", placement: "center", scale: logo ? 0.6 : 1, fit: "contain", crop: null, layer: 1, animation: logo ? "scale_in" : "fade_in", frame: screen ? "browser" : "none", mandatory: m.usage === "must_use", reason: "It is the most relevant supplied picture for this beat." }],
        shot: { shot_size: "medium", camera_motion: "static", visual_action: "The uploaded picture, shown as supplied" },
      });
    });
    return plan;
  }
  private editPlan(user: string) {
    const scenes = JSON.parse(/## Scenes\n([\s\S]*?)\n\n## /.exec(user)![1]!) as { scene_id: string; overlay: unknown; media: string[]; duration_seconds: number; visual_block?: string | null }[];
    const uses: unknown[] = [];
    let n = 1;
    const add = (scene_id: string, recipe_id: string, rationale: string) => uses.push({ use_id: `U${String(n++).padStart(2, "0")}`, scene_id, recipe_id, params: {}, rationale });
    scenes.forEach((s, i) => {
      const last = i === scenes.length - 1;
      if (s.visual_block) add(s.scene_id, "scene-composition", "The scene is drawn from its approved visual.");
      else if (last) add(s.scene_id, "end-card-cta", "Closing card holds the call to action.");
      else {
        if (s.media.includes("video") && s.duration_seconds >= 1.5) add(s.scene_id, "slow-push-in", "Gentle push builds focus on the real footage.");
        if (s.overlay) add(s.scene_id, "text-fade-up", "Simple, readable headline entrance.");
      }
    });
    if (user.includes("- id: loudness-normalise ")) add(scenes[scenes.length - 1]!.scene_id, "loudness-normalise", "Level the final mix once, at the end.");
    // asked to compose: the Editor's share is how the composed scenes move. It changes motion only, never copy or layout (a patch cannot carry them).
    if (this.opts.compose) {
      const head = "## Composed scenes (the layouts the storyboard approved; you may change only how their elements move)";
      const i = user.indexOf(head);
      if (i >= 0) {
        const from = user.indexOf("[", i), to = user.indexOf("\n\n", from);
        try {
          const scenes = JSON.parse(user.slice(from, to < 0 ? undefined : to)) as { scene_id: string; duration_seconds: number; elements: { id: string; kind: string; text?: string }[] }[];
          const enters = ["rise", "slide_left", "drop", "scale_in"] as const;
          const motion = scenes.map((s, k) => {
            const texts = s.elements.filter((e) => e.kind === "text");
            const lead = texts[0], second = s.elements.find((e) => e !== lead);
            const words = (lead?.text ?? "").split(/\s+/).length;
            // everything must still be fully shown 0.8 s before the end: a stagger spans (words - 1) * each of the scene
            const each = Math.min(0.03, Math.max(0.005, (0.12 * s.duration_seconds) / Math.max(1, words - 1) / s.duration_seconds));
            const elements = [
              ...(lead ? [{ id: lead.id, motion: { enter: "rise", easing: "spring", delay: 0.02, stagger: { unit: "word", each } } }] : []),
              ...(second ? [{ id: second.id, motion: { enter: enters[k % enters.length], delay: 0.12 } }] : []),
            ];
            return elements.length ? { scene_id: s.scene_id, rationale: "Give the scene its own rhythm: the line it is about arrives word by word, the rest follows.", elements } : null;
          }).filter((m) => m !== null);
          if (motion.length) return { uses, composition_motion: motion };
        } catch { /* no usable summary: keep the motion as it is */ }
      }
    }    return { uses };
  }
}

