import { TEMPLATE_CATEGORIES, type LibraryTemplate, type TemplateCategory } from "@digikon/contracts";
import { z } from "./families/common.js";
import { styleOf, toTemplate, type FamilyDef } from "./kit.js";

/** The generic starting point `scripts/new-template.mts` scaffolds from: a headline and a supporting line on the film's palette. Edit the written file to design from there. */
export function starterFamily(id: string, category: TemplateCategory, title: string, description?: string): FamilyDef {
  return {
    id, category, archetype: "starter", title,
    description: description ?? `${title}. A starting design: a headline and one supporting line.`,
    retrieval: `${title}. ${description ?? "Starter design with a headline and a supporting line; replace this text with what a viewer sees and what the scene is for."}`,
    mood: ["neutral"], tone: ["neutral"], energy: "medium",
    slots: [{ name: "headline", role: "headline", max_chars: 60, example: title }, { name: "subline", role: "subline", max_chars: 100, example: "A supporting line goes here." }],
    duration_s: 4.5, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop"],
    build(c) {
      c.block([
        { id: "headline", slot: "headline", px: z(c, c.f.wide ? 0.1 : 0.09), role: "display", maxLines: 3, lh: 1.08, at: 0.2, enter: "rise", stagger: "auto" },
        { id: "subline", slot: "subline", px: z(c, 0.042), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 1.2, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
      ]);
    },
  };
}

export function scaffoldTemplate(id: string, category: string, title: string, description?: string): LibraryTemplate {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`"${id}" is not a valid template id (lowercase words joined by single hyphens)`);
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category)) throw new Error(`"${category}" is not one of the 18 categories: ${TEMPLATE_CATEGORIES.join(", ")}`);
  const fam = starterFamily(id, category as TemplateCategory, title, description), s = styleOf(fam);
  return toTemplate(fam, s, s);
}
