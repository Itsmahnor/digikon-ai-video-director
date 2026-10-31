import type { ArtDirection, SceneVisual } from "@digikon/contracts";

/**
 * One representative example per visual block, and the art direction they share. They are the inputs the block capabilities were
 * validated with (see capabilities/visual), and the inputs the tests render. They are examples, not a statement that every input works.
 */

export const EXAMPLE_ART_DIRECTION: ArtDirection = {
  audience_response: "Busy owners should feel relief and click to start the free trial.",
  concept: "Booking goes from a pile of back-and-forth messages to one calm, confirmed slot.",
  visual_metaphor: "A tangle of message bubbles that resolves into a single tidy calendar row.",
  palette: { background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#e8590c", accent_2: "#2b8a6e" },
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
};
