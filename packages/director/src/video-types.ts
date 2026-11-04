import { VideoTypeProposal, type Project } from "@digikon/contracts";

/**
 * Playbook catalog for video types, condensing the approved Director skills
 * (topic: video-type-playbook) from examples/skills/digikon-original/skills.
 */
export const CATEGORY_VIDEO_TYPES: Record<"saas" | "ecommerce" | "general-promo", VideoTypeProposal[]> = {
  saas: [
    {
      id: "saas-product-demo",
      title: "SaaS product demo video",
      category: "saas",
      description: "A continuous, real product flow showing the job to be done and the result on screen.",
      example: "Send an invoice in three clicks: create, add client, send, with the paid status shown last.",
      recommended: false,
    },
    {
      id: "saas-feature-launch",
      title: "SaaS feature launch video",
      category: "saas",
      description: "Focuses on one new capability: the old way vs the new way, how it works, and who gets it.",
      example: "Introducing automated invoice reminders: set rules once, get paid 4x faster.",
      recommended: false,
    },
    {
      id: "saas-explainer-60s",
      title: "SaaS 60-second explainer video",
      category: "saas",
      description: "A clear problem-solution arc for prospects: problem context, core value proposition, proof, and CTA.",
      example: "Struggling to track contractor hours? Digikon automates timesheets in one click.",
      recommended: false,
    },
  ],
  ecommerce: [
    {
      id: "ecom-product-showcase",
      title: "E-commerce product showcase",
      category: "ecommerce",
      description: "Hero close-up, three key features or angles with short labels, in-use context, and clear CTA.",
      example: "A water bottle: hero spin, insulated lid label, pour shot, in-bag shot, CTA.",
      recommended: false,
    },
    {
      id: "ecom-ugc-style-ad",
      title: "E-commerce UGC-style ad",
      category: "ecommerce",
      description: "Authentic first-person hook, relatable problem, genuine demonstration, and unpolished feel.",
      example: "I was skeptical until I tried this kitchen slicer: 5 seconds to prep salad.",
      recommended: false,
    },
    {
      id: "ecom-unboxing",
      title: "E-commerce unboxing video",
      category: "ecommerce",
      description: "Anticipation, packaging reveal, tactile experience, first impressions, and quality details.",
      example: "Unboxing luxury headphones: premium case, magnetic clasp, immediate sound test.",
      recommended: false,
    },
  ],
  "general-promo": [
    {
      id: "promo-brand-story",
      title: "Brand story video",
      category: "general-promo",
      description: "The founding problem or belief, what the brand does, human moments, and promise.",
      example: "A bakery's origin story using the owner's own photos and one approved line.",
      recommended: false,
    },
    {
      id: "promo-social-ad",
      title: "Social promo ad",
      category: "general-promo",
      description: "Fast thumb-stopping hook in 0-3s, quick value proposition, on-screen text, and urgent CTA.",
      example: "Stop scrolling: flash summer sale starts now, 20% off all weekend.",
      recommended: false,
    },
    {
      id: "promo-event-teaser",
      title: "Event teaser video",
      category: "general-promo",
      description: "Creates anticipation and FOMO: high energy, key speakers/highlights, dates, and registration CTA.",
      example: "Digikon Summit 2026: 3 days, 50 speakers, London. Tickets live now.",
      recommended: false,
    },
  ],
};

const KEYWORD_PATTERNS: Record<string, RegExp> = {
  "saas-feature-launch": /\b(launch|new feature|announc|update|release|changelog)\b/i,
  "saas-explainer-60s": /\b(explain|explainer|overview|how it works|understand)\b/i,
  "saas-product-demo": /\b(demo|product|screen|workflow|tutorial|app|platform)\b/i,
  "ecom-unboxing": /\b(unbox|unboxing|package|packaging|open|box|delivery)\b/i,
  "ecom-ugc-style-ad": /\b(ugc|tiktok|creator|review|influencer|authentic|first-person)\b/i,
  "ecom-product-showcase": /\b(showcase|product|feature|detail|angles|look|material)\b/i,
  "promo-event-teaser": /\b(event|teaser|summit|conference|webinar|festival|coming soon)\b/i,
  "promo-social-ad": /\b(social|scroll|fast|feed|sale|discount|deal|limited|offer)\b/i,
  "promo-brand-story": /\b(story|origin|founder|mission|history|journey|about us|brand)\b/i,
};

/**
 * Proposes 2 to 3 category-appropriate video types with a one-line description and a reference example,
 * marking the best recommendation based on brief context.
 */
export function proposeVideoTypes(
  category: "saas" | "ecommerce" | "general-promo" | null,
  brief = "",
): VideoTypeProposal[] {
  const cat = category ?? "general-promo";
  const pool = (CATEGORY_VIDEO_TYPES[cat] ?? CATEGORY_VIDEO_TYPES["general-promo"]).map((p) => ({ ...p }));

  // Score candidates against brief keywords
  let bestIdx = 0;
  let bestScore = -1;
  pool.forEach((p, idx) => {
    const rx = KEYWORD_PATTERNS[p.id];
    let score = 0;
    if (rx && rx.test(brief)) score += 2;
    if (brief.toLowerCase().includes(p.id.split("-")[1] ?? "")) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  // Re-order so recommended is first
  const recommendedItem = pool[bestIdx] ?? pool[0]!;
  const others = pool.filter((_, idx) => idx !== bestIdx);
  const ordered = [{ ...recommendedItem, recommended: true }, ...others.map((o) => ({ ...o, recommended: false }))];

  return ordered.map((item) => VideoTypeProposal.parse(item));
}

export interface VideoTypeNodeOut {
  proposals: VideoTypeProposal[];
  chosen: string;
  skills: string[];
  trace: string[];
}

/**
 * Node executed after intake and asset analysis, proposing 2 to 3 video types and recording user choice.
 */
export async function videoTypeNode(
  project: Pick<Project, "video_category" | "video_type" | "brief">,
  chosenVideoType?: string | null,
): Promise<VideoTypeNodeOut> {
  const category = project.video_category ?? null;
  const proposals = proposeVideoTypes(category, project.brief);

  // User explicit choice takes priority; fallback to project field, then top recommended proposal
  const candidate = chosenVideoType || project.video_type;
  const matched = proposals.find((p) => p.id === candidate);
  const chosen = matched ? matched.id : candidate ? candidate : proposals[0]!.id;

  return {
    proposals,
    chosen,
    skills: [chosen],
    trace: [`video_type_step: proposed [${proposals.map((p) => p.id).join(", ")}], selected ${chosen}`],
  };
}
