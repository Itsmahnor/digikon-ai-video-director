---
id: oversized-cursor-causal-motion
title: Use an oversized cursor to lead the eye and cause the next action
category: saas
topic: motion
scope: editor
funnel_stage: consideration
platform: all
grade: C
status: approved
---
**When to use:** UI demos and scenes that feel static or stale.

**Rule:** a deliberately large pointer comes in from off-screen, leads the viewer's gaze to the next place of interest, triggers the following action with a click, then exits. It is cheap (one element, transform-only) and gives causal motion: the click is why the morph or transition happens. Make it large (an actual-size cursor vanishes at video scale), keep one look per film, and match a recognisable brand pointer when the product has one.

**Example:** cursor travels to "Send reminder", clicks, and the invoice row morphs into its paid state.

**Caution:** only imitate a brand's cursor look when it is the subject of the video.

**Check:** pause on the frame where the click lands; the next effect must begin on that same frame, not a few frames later.

_Condensed and modified adaptation of hyperframes skills and motion doctrines (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
