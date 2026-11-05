import { SceneVisual, processFlow, type ArtDirection } from "@digikon/contracts";

/**
 * One representative example per visual block, and the art direction they share. They are the inputs the block capabilities were
 * validated with (see capabilities/visual), and the inputs the tests render. They are examples, not a statement that every input works.
 */

export const EXAMPLE_ART_DIRECTION: ArtDirection = {
  audience_response: "Busy owners should feel relief and click to start the free trial.",
  concept: "Booking goes from a pile of back-and-forth messages to one calm, confirmed slot.",
  visual_metaphor: "A tangle of message bubbles that resolves into a single tidy calendar row.",
  palette: { background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#b8430a", accent_2: "#2b8a6e" },
  typography: { weight: "bold", scale: "standard", case: "sentence", rationale: "Bold sentence case reads as friendly and confident." },
  composition: "Headline in a left column or on top, one picture beside or below it, generous margins, one accent per scene.",
  motion_language: { feel: "precise", easing: "ease_out", description: "Elements ease out of their own place; nothing bounces; every scene ends held still." },
  narrative: { opening: "Show the pain at once, in the audience's own inbox.", development: "Show the one change: pick a slot and it is booked.", conclusion: "Invite one action and hold still on it." },
};

export const EXAMPLE_VISUALS: Record<Exclude<SceneVisual["block"], "asset_stage">, { visual: SceneVisual; overlay_text: string | null; creative_use: string; limitations: string[] }> = {
  message_thread: {
    visual: { block: "message_thread", mode: "pile_up", camera: "push_in", reveal: "none", backdrop: "dots", messages: [{ from: "them", text: "Does Tuesday work?" }, { from: "you", text: "Tuesday is full" }, { from: "them", text: "Can we do Thursday?" }, { from: "you", text: "Thursday after 3?" }, { from: "them", text: "Actually, Friday?" }] },
    overlay_text: null,
    creative_use: "Show a problem as a conversation: a hook that puts the viewer in the pain, or a pile that gets out of hand.",
    limitations: ["Two to six messages of at most 48 characters, two lines each at most.", "No avatars, typing indicators or real app chrome: it is a stylised thread.", "Message text is sample content and must not state results or numbers."],
  },
  ui_demo: {
    visual: { block: "ui_demo", camera: "static", reveal: "wipe_right", backdrop: "grid", window_title: "Booking page", sidebar: ["Calendar", "Clients", "Settings"], rows: [{ label: "Tue 10:00", tag: "Open", state: "open" }, { label: "Tue 11:30", tag: "Busy", state: "busy" }, { label: "Wed 09:00", tag: "Open", state: "open" }, { label: "Thu 14:00", tag: "Open", state: "open" }], cursor_target: 2, confirm_text: "Booked" },
    overlay_text: "Share your open times. Your client picks one.",
    creative_use: "Explain what a product does in one gesture: a drawn cursor picks a row and a confirmation lands. Always labelled as a concept illustration.",
    limitations: ["A stylised window, not a screenshot: it never shows the real product.", "Up to six rows, four sidebar items, one cursor target, one confirmation.", "No scrolling, typing or multi-step flows."],
  },
  process_flow: {
    visual: { block: "process_flow", camera: "pan_right", reveal: "none", backdrop: "flat", steps: [{ label: "Share times", detail: "Your open slots" }, { label: "Client picks", detail: "One tap" }, { label: "Confirmed", detail: "Added to calendar" }] },
    overlay_text: "From request to booked in three steps.",
    creative_use: "Show how something works as a sequence: nodes light up in order along a line that draws itself.",
    limitations: ["Two to five steps; labels of at most 22 characters.", "Lays out horizontally in wide areas and vertically in tall ones.", "No branching or loops."],
  },
  data_chart: {
    visual: { block: "data_chart", chart: "bars", camera: "static", reveal: "wipe_up", backdrop: "flat", title: "Back-and-forth, before and after", points: [{ label: "Mon", value: 80 }, { label: "Tue", value: 65 }, { label: "Wed", value: 70 }, { label: "Thu", value: 30 }, { label: "Fri", value: 20 }], highlight_index: 4 },
    overlay_text: "Fewer messages, more booked time.",
    creative_use: "Give a trend or a comparison a shape. Heights only; the chart is always labelled illustrative data.",
    limitations: ["Values are relative heights and are never printed.", "Three to seven points; bars or one line.", "It is illustrative: it must not be presented as a measured result."],
  },
  kinetic_type: {
    visual: { block: "kinetic_type", style: "word_pop", emphasis_word: 3, camera: "static", reveal: "none", backdrop: "gradient" },
    overlay_text: "Booking should not take this many emails.",
    creative_use: "Let the words carry the scene when the sentence is the idea: a statement, a turn, a punchline.",
    limitations: ["Animates the approved overlay text only (120 characters).", "Three entrance styles: slide_stack, word_pop, mask_rise.", "One typeface file: weight, scale and case are what vary."],
  },
  layered_cards: {
    visual: { block: "layered_cards", depth: "strong", camera: "pull_out", reveal: "iris", backdrop: "gradient", cards: [{ title: "Your calendar", detail: "Always in sync" }, { title: "Open times", detail: "You choose them" }, { title: "Client picks", detail: "No emails" }] },
    overlay_text: "Everything in one place.",
    creative_use: "Show layers of a product or idea with controlled parallax: cards stack, drift at different depths and the front one is the point.",
    limitations: ["Two to four cards of at most 24 characters plus a detail line.", "Drift is a slow oscillation, not a camera move through space.", "Cards are text and shapes; no images yet."],
  },
  end_card: {
    visual: { block: "end_card", wordmark: "Slotly", button: "Start free trial", subline: "Free for 14 days", camera: "static", reveal: "none", backdrop: "gradient" },
    overlay_text: "Booking, finally simple.",
    creative_use: "Close on one action and hold still: a typeset name, a headline, a button and a small line.",
    limitations: ["The wordmark is typeset text, never a logo.", "The button is a drawn shape: it is not interactive and carries no URL.", "Animation completes early so the card holds still at the end."],
  },
  title_plate: {
    visual: { block: "title_plate", eyebrow: "A new collection", subline: "Autumn in the old quarter", plate: "hairline", camera: "push_in", reveal: "none", backdrop: "vignette" },
    overlay_text: "The Long Evening",
    creative_use: "Set one title alone on the frame, as a film or a campaign would: a reveal, a chapter, a name.",
    limitations: ["The title is the approved overlay text, up to three lines on a wide frame.", "One eyebrow line and one subline at most.", "It says one thing; it is not a place for a list."],
  },
  quote_statement: {
    visual: { block: "quote_statement", attribution: "Our founding belief", camera: "static", reveal: "none", backdrop: "paper" },
    overlay_text: "Make fewer things, and make them to last a lifetime.",
    creative_use: "Give a belief or a promise the weight of a sentence somebody means: a large mark, lines arriving one at a time.",
    limitations: ["The quote is the approved overlay text and is never invented for a real person.", "The attribution is one short line, or none.", "Five lines at most on a wide frame."],
  },
  spec_callouts: {
    visual: { block: "spec_callouts", form: "orb", style: "spotlight", camera: "static", reveal: "none", backdrop: "spotlight", notes: [{ label: "Hand-polished", detail: "Forty hours at the bench" }, { label: "Single origin", detail: "One valley, one season" }, { label: "Refillable", detail: "Made to be kept" }] },
    overlay_text: "One object, considered.",
    creative_use: "Draw out what matters about one subject on leader lines: an object in a spotlight, a blueprint of a device, a blackboard diagram of an idea.",
    limitations: ["The form is abstract (orb, slab, column, ring): it stands for the subject and is never a picture of the real product.", "Two to five notes of at most 22 characters, with a short detail each.", "A detail shown as a fact needs an approved claim behind the scene."],
  },
  split_panels: {
    visual: { block: "split_panels", axis: "columns", camera: "static", reveal: "none", backdrop: "flat", panels: [{ word: "Raw", note: "Unlined wool" }, { word: "Cut", note: "By hand" }, { word: "Worn", note: "Every day" }] },
    overlay_text: "The autumn edit.",
    creative_use: "Cut the frame into an editorial spread: panels slide in on a beat, each carrying one big word.",
    limitations: ["Two to four panels, one word of at most 14 characters each.", "A portrait frame always stacks the panels.", "Colours come from the palette in a fixed order; images do not sit in panels yet."],
  },
  route_map: {
    visual: { block: "route_map", shape: "coast", camera: "pan_right", reveal: "none", backdrop: "paper", stops: [{ label: "Lisbon", note: "Leave at first light" }, { label: "Sintra", note: "Into the hills" }, { label: "Cascais", note: "Back to the sea" }] },
    overlay_text: "Three days on the Atlantic coast.",
    creative_use: "Tell a journey as a line drawn across the frame, its stops arriving as the line reaches them.",
    limitations: ["A drawn impression of a route: it is not real geography and shows no real map.", "Two to five stops of at most 20 characters.", "The line runs one way, with no branches."],
  },
  timeline_path: {
    visual: { block: "timeline_path", camera: "static", reveal: "none", backdrop: "flat", marks: [{ when: "Then", label: "One workshop, two people" }, { when: "Now", label: "Twelve countries" }, { when: "Next", label: "Fully circular" }] },
    overlay_text: "How we got here.",
    creative_use: "Lay a history, a roadmap or the chapters of a story along one line.",
    limitations: ["Two to five marks; a mark's date or word has at most 12 characters.", "A real date or figure needs an approved claim behind the scene.", "Runs across a wide frame and down a tall one."],
  },
  composition: {
    // a free layout: a headline of the scene's own words above steps that draw themselves in order, built from the elements library but placed and timed as the plan says
    visual: SceneVisual.parse({
      block: "composition", camera: "static", reveal: "none", backdrop: "flat",
      intent: "Walk the viewer from request to booked slot in three beats, the headline above and the steps arriving in order.",
      elements: [
        { id: "headline", kind: "text", text: "From request to booked.", at: { x: 0.08, y: 0.04, w: 0.84 }, size: 0.055, motion: { enter: "rise", delay: 0, duration: 0.2 } },
        ...processFlow([{ label: "Share times", detail: "Your open slots" }, { label: "Client picks", detail: "One tap" }, { label: "Booked", detail: "Confirmed" }]),
      ],
    }),
    overlay_text: "From request to booked.",
    creative_use: "A scene whose layout is composed for the story rather than chosen from the fixed blocks.",
    limitations: ["Text and shapes only; pictures are placed with asset_refs and drawn over it.", "Every word must come from the scene's approved text, claims or facts.", "Everything must finish early enough to be read before the scene ends."],
  },  closing_signature: {
    visual: { block: "closing_signature", wordmark: "Maison Vael", action: "Visit the atelier", subline: "By appointment", camera: "static", reveal: "none", backdrop: "vignette" },
    overlay_text: "Made slowly.",
    creative_use: "Close quietly: the name, a thin rule, one line to follow, for a film that should not end on a button.",
    limitations: ["The wordmark is typeset text, never a logo.", "The action is text, not a button, and carries no URL.", "It holds still at the end."],
  },
};
