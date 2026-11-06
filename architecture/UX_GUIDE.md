# UX and interface guide

The design rules for every screen in the plan: the intake wizard, the question module, the video-type choice, the two approval gates, scene previews, change requests and the final review. Written from the point of view of a senior product designer. These rules are also the acceptance criteria for the UI steps C4, C6, D1, E3, E4, E6 and F1 in `IMPLEMENTATION_STEPS.md`. It is a proposal, not built.

The user: a business owner or marketer. Not a video editor, not technical, short on time, often on a laptop, sometimes on a phone. They want a good video fast and they want to feel in control.

## 1. Principles

1. **One thing per screen.** One question or one decision at a time, a clear primary button, everything else quiet.
2. **Never ask what we can find out.** Read the website, the brand guide and the uploads first, then ask only for what is missing. Show what we found and let the user correct it.
3. **Skip is always allowed for optional things,** and says what happens when skipped ("We will use a clean text title instead of your logo").
4. **Show the outcome, not the settings.** Previews and plain sentences, never technical words (no "operation", "recipe", "hash", "engine").
5. **Always show where you are and what comes next.** A progress bar with named steps and "about N minutes left".
6. **Nothing is lost.** Every answer saves automatically; the user can go back, change an answer, close the tab and return.
7. **The user decides at two moments only:** approve the story, approve the look. Everything else is guided, not gated.
8. **Honest status.** If something cannot be done, say so in one plain sentence and offer a way forward. Never show a fake "complete".
9. **Fast feedback.** Show progress within 200 ms of any action; anything over 2 seconds shows what is happening.
10. **Accessible by default** (see section 8).

## 2. The journey, screen by screen

| # | Screen | Purpose | Primary action | Skip / back |
|---|---|---|---|---|
| 1 | Start | "What video do you need?" with 3 category cards (SaaS, e-commerce, promo) and a short text box | Continue | Back to home |
| 2 | Goal and audience | Goal (pick or type), audience, platform (shows the right shape: 16:9, 9:16, 1:1), length | Continue | Back |
| 3 | Brand | Website URL box with a "Read my website" button; or upload brand guide; shows what was found: colours, fonts, logo | "This looks right" / Edit | Skip (we will suggest a look) |
| 4 | Assets | Drag and drop for logo, images, footage, voiceover, music. Each shows a thumbnail, what we understood, and a licence tick ("I own or have the right to use this") | Continue | Skip each type |
| 5 | Questions | Only what is missing, one at a time (see section 3) | Answer | Skip / "Decide for me" |
| 6 | Review the brief | One-page summary of everything collected, editable inline | "Looks good, create the story" | Back to any step |
| 7 | Video type | 2-3 cards with an example clip or storyboard still, a one-line promise, who it suits | Choose this one | "Show me others" |
| 8 | Story (Gate 1) | Scenes as a vertical storyboard: picture, one-sentence description, duration, claim badges | Approve story | Ask for changes (box, per scene or whole) |
| 9 | Look (Gate 2) | Each scene as a moving preview with its sound; template picker (temporary) | Approve look | Change this scene |
| 10 | Final video | Full video player, quality notes in plain words, download | Download / Ask for changes | Back to a scene |

## 3. Question module rules

- **Typed answers.** A question about a file shows an upload box. A choice shows 2-4 large buttons. A fact shows a short text box. Never a free chat box for a simple question.
- **One at a time,** with the reason: "Do you have a logo? We will put it on the closing scene."
- **Always include:** "I don't have one" (skip) and "Decide for me".
- **Order:** the questions that change the most first (video type, offer, audience), details last.
- **Cap:** at most 7 questions in total; after that, proceed with assumptions listed on the review screen so the user can correct them.
- **Edge cases that must be handled:**
  - no logo, no website, no brand guide, no images (we generate text and shape-based scenes and say so);
  - website blocked or empty (ask for colours and a one-line description instead);
  - wrong file type, too large, corrupted, or very low resolution (say which, and what is acceptable);
  - an image with a person or someone else's logo (ask whether they have the right to use it);
  - audio: voiceover recording with background noise or too short, music with unknown rights, no audio at all (offer narration, music, or silent);
  - user changes an earlier answer (re-run only what depends on it and say what changed);
  - user leaves and returns (resume at the same step);
  - two languages in the brief (ask which language the video is in);
  - the user pastes a competitor's name or a claim we cannot support (explain we only state what they can back up).

## 4. Components

- **Progress bar** with named steps, never more than 6 steps shown at once.
- **Upload card:** drag and drop plus browse button, instant thumbnail, upload progress, remove, replace, and a clear error line beneath.
- **Found-it card** (website, brand guide): "We found: [colour chips] [font names] [logo]" with Edit on each. Never apply silently.
- **Choice card** with image or clip, title, one line, "best for".
- **Storyboard card:** frame, scene number, 1-line description, duration, edit button.
- **Preview player:** high-resolution moving preview with sound, play/pause, replay, a loading state that shows what is being made, and a plain "this is what you will get" caption.
- **Change box:** "What would you like different?" with 4-5 quick chips ("calmer", "faster", "different animation", "change the text", "different colours") plus free text. It tells the user what will happen: "This changes only this scene's look. Your approved story stays."
- **Plain-language status:** every state has a sentence, a next step, and never a raw error code.

## 5. Content and tone

- Short, warm, direct. "Here's the story for your video" rather than "Storyboard generated".
- Use the user's own words and names (the product name, not "the brand").
- Buttons are verbs: "Create the story", "Approve story", "Ask for changes".
- Errors say what happened, why in one clause, and what to do. Example: "We couldn't read that website. Some sites block automatic reading. You can paste your colours here instead, or skip."
- No jargon list: operation, recipe, template hash, capability, engine, asset id, preflight. Map them to plain words in one place (`public-view.ts` already does this for escalations).

## 6. Loading and waiting (renders take time)

- Show the stage: "Reading your website", "Writing the story", "Drawing scene 3 of 6".
- Show a time estimate once there is enough data, never a fake percentage.
- Let the user keep working: previews load per scene, in order, as they finish.
- Cache: a scene that is unchanged appears instantly.

## 7. Trust, safety and approval

- Claims are marked with a badge: "backed by your facts" or "needs your confirmation". Unsupported claims are never hidden.
- Every approval states exactly what is being approved ("Story version 2, 6 scenes, 30 seconds") and what happens next.
- Generated voice and music are labelled "generated". Uploaded files show the user's rights confirmation.
- A visible "Undo" for every change request and a version history for the story and the look.

## 8. Accessibility and responsiveness

- Meet WCAG 2.2 AA: contrast 4.5:1 for text, visible keyboard focus, full keyboard use, labels on every field, no information by colour alone, targets at least 44 px.
- Respect reduced-motion settings in the interface (not in the user's video).
- Captions or a transcript for any preview that has narration.
- Works at 360 px width; the preview player and the storyboard stack vertically on mobile; uploads work from a phone camera roll.
- Text can scale to 200% without breaking layouts.

## 9. How we check the UX is good

- A click-through for each edge case in section 3 (browser tests in the console test suite).
- Time and drop-off per step (logged locally first): target under 5 minutes from start to the story for a user with a website and logo.
- A usability check with 5 real users on the wizard and the gates before release: they must finish without help and be able to say, in their own words, what they approved.
- Plain-language audit: search every user-visible string for the banned words in section 5.

## 10. Audio in the UX

- Intake asks about sound up front: "Narration, music, both, or silent?" and whether the user has a voiceover or music to use.
- Voice choice: 3-4 voice samples to hear (Kokoro voices), each with a play button and name.
- Music: a mood picker with 6-10 second previews; "upload yours" is always an option.
- Every scene preview plays with its sound. A mute toggle, and captions for narration.
- The final review shows loudness and clarity in one plain line ("Voice is clear over the music").
