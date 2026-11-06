/**
 * Template inspiration. The template library (hundreds of validated scene layouts) is shown to the Director as references to learn from, one short list per story
 * beat, with variety forced across beats (a family already shown is not offered again while others exist). The Director still writes its own composition. Afterwards
 * the composition's layout is compared with every template it was shown; a composition that matches one too closely is reported (warning only for now: it never
 * blocks Gate 1). The Director never imports the template package: the console supplies this port.
 */
export interface TemplateRef { template_id: string; title: string; family: string; category: string; summary: string; motion: string; type: string; energy: string }

export interface TemplateInspirationPort {
  suggest(q: { text: string; category?: string; film_id?: string; exclude_families?: string[]; k: number }): Promise<TemplateRef[]>;
  /** Layout similarity (0..1) of one composed scene to each named template. */
  compare(composition: unknown, template_ids: readonly string[]): Promise<{ template_id: string; similarity: number }[]>;
}

/** A composition whose layout matches a shown template at or above this share is reported. A first guess from the library's own distribution; calibrate before it blocks anything. */
export const TOO_CLOSE = 0.6;

/** The template category a beat most likely wants, from its purpose; undefined when nothing fits (then no category filter is applied). */
export function categoryForBeat(purpose: string, index: number, count: number): string | undefined {
  const p = purpose.toLowerCase();
  if (index === 0) return "hook";
  if (index === count - 1 && /(cta|call to action|sign ?up|buy|book|start|try|download|end card|close|offer)/.test(p)) return "cta_end";
  const rules: [RegExp, string][] = [
    [/(problem|pain|frustrat|struggle|waste)/, "problem"], [/(testimonial|customer|review|trust|social proof|people)/, "social_proof"],
    [/(compare|versus| vs |alternative|before and after)/, "comparison"], [/(stat|number|data|chart|result|proof|metric|%)/, "data_proof"],
    [/(demo|interface|screen|dashboard|app|click|ui)/, "ui_demo"], [/(step|how it works|process|flow|workflow)/, "process"],
    [/(feature|benefit|capabilit)/, "feature_highlight"], [/(solution|reveal|introduc|meet )/, "solution_reveal"], [/(brand|logo|signature|tagline)/, "brand_moment"],
  ];
  return rules.find(([re]) => re.test(p))?.[1];
}

export interface BeatInspiration { beat: string; category: string | null; templates: TemplateRef[] }

export async function inspirationFor(port: TemplateInspirationPort, filmId: string, treatment: { tone: string; beats: readonly { beat: string; purpose: string }[] }, perBeat = 3): Promise<{ beats: BeatInspiration[]; shown: string[]; section: string | null }> {
  const beats: BeatInspiration[] = [], families: string[] = [];
  for (const [i, b] of treatment.beats.entries()) {
    const category = categoryForBeat(`${b.beat} ${b.purpose}`, i, treatment.beats.length);
    const text = `${b.purpose}. ${b.beat}. ${treatment.tone} tone`;
    let found = await port.suggest({ text, ...(category ? { category } : {}), film_id: filmId, exclude_families: [...families], k: perBeat });
    if (found.length === 0 && families.length) found = await port.suggest({ text, ...(category ? { category } : {}), film_id: filmId, k: perBeat });
    for (const t of found) if (!families.includes(t.family)) families.push(t.family);
    beats.push({ beat: b.beat, category: category ?? null, templates: found });
  }
  const shown = [...new Set(beats.flatMap((b) => b.templates.map((t) => t.template_id)))];
  if (!shown.length) return { beats, shown, section: null };
  const lines = beats.filter((b) => b.templates.length).map((b) => `Beat "${b.beat}"${b.category ? ` (${b.category})` : ""}:\n${b.templates.map((t) => `  - [${t.template_id}] ${t.title} (${t.family}; ${t.motion} motion, ${t.type} type, ${t.energy} energy): ${t.summary}`).join("\n")}`);
  const section = [
    "## Layout inspiration (references only)",
    "These are validated layouts from the template library that fit each beat. They show what works: how a hook or a proof scene is usually structured, how it moves, how type is handled. They are NOT a menu to fill in.",
    "Write your own composition for each scene from this film's story. Learn the principle (hierarchy, rhythm, what moves first), then make a layout of your own that differs from every reference below in at least two of: where things sit, how they move, how type is treated. A scene that reproduces one reference's layout will be flagged.",
    ...lines,
  ].join("\n");
  return { beats, shown, section };
}

export interface CloseMatch { scene_id: string; template_id: string; similarity: number }

/** Compares every composed scene with the templates the Director was shown. Returns those at or above the threshold, closest first. */
export async function closeMatches(port: TemplateInspirationPort, scenes: readonly { scene_id: string; visual: { block: string } | null }[], shown: readonly string[], threshold = TOO_CLOSE): Promise<CloseMatch[]> {
  if (!shown.length) return [];
  const out: CloseMatch[] = [];
  for (const s of scenes) {
    if (s.visual?.block !== "composition") continue;
    const best = (await port.compare(s.visual, shown)).filter((m) => m.similarity >= threshold).sort((a, b) => b.similarity - a.similarity)[0];
    if (best) out.push({ scene_id: s.scene_id, template_id: best.template_id, similarity: Math.round(best.similarity * 1000) / 1000 });
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}
