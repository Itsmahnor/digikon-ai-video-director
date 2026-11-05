/**
 * Where a change request goes. The Director owns what the video says (story, claims, scenes, wording) and any change to it reopens Gate 1; the Editor owns how it looks and
 * moves (colour, type, animation, timing, camera, sound level) and a change to it reopens Gate 2 only. A request that is both, or neither, is not guessed at: one question is asked.
 * This only decides the route. It never edits a plan, an approval or a hash, and a model is not needed (the classifier is rules over plain words).
 */
export type ChangeRoute = "editor" | "director" | "ask";

export interface ChangeRouting {
  route: ChangeRoute;
  /** The gate that has to be approved again when the change is made. Null while the route is undecided. */
  reopens: "edit_plan" | "storyboard" | null;
  reason: string;
  /** Set only when the route is "ask": the one question to put to the user. */
  question: string | null;
}

const STORY = /\b(claim|claims|statistic|figure|price|discount|offer|testimonial|fact|facts|script|voice ?over|narration|say|says|saying|wording|word|words|text says|headline|slogan|tagline|message|story|narrative|hook|call to action|cta|audience|add a scene|remove a scene|delete a scene|new scene|reorder|re-order|order of (the )?scenes|swap (the )?scenes|scene order|longer story|shorter story|tone of voice|mention|include|leave out|drop the|brand name|product name)\b/i;
const LOOK = /\b(colou?rs?|palette|font|fonts|typeface|type size|bigger|smaller|larger|size|bold|italic|animation|animate|animated|transition|transitions|fade|wipe|zoom|pan|camera|motion|speed up|slow down|faster|slower|timing|pace|duration|position|move it|align|centre|center|margin|spacing|background|backdrop|brightness|contrast|blur|crop|filter|style|look|looks|feel|template|logo size|volume|louder|quieter|music level|sound level)\b/i;

export function classifyChange(request: string): ChangeRouting {
  const text = request.trim();
  if (!text) return { route: "ask", reopens: null, reason: "the request is empty", question: "What would you like to change?" };
  const story = STORY.test(text), look = LOOK.test(text);
  if (story && !look) return { route: "director", reopens: "storyboard", reason: "it changes what the video says, so the Director revises the storyboard and you approve it again (gate 1), then the edit plan (gate 2)", question: null };
  if (look && !story) return { route: "editor", reopens: "edit_plan", reason: "it changes how the video looks or moves, so only the Editor's plan changes and you approve it again (gate 2); the approved storyboard stays as it is", question: null };
  return {
    route: "ask", reopens: null,
    reason: story && look ? "the request mixes a change to what is said with a change to how it looks" : "the request does not say whether it is about the story or the look",
    question: "Is this about what the video says (the words, claims or scenes), or about how it looks and moves (colours, type, animation, timing)?",
  };
}