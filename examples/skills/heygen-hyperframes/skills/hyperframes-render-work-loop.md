---
id: hyperframes-render-work-loop
title: Check, look at frames, then render
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: approved
---
**When to use:** building or editing a video as HTML rendered frame by frame.

**Principles:** every frame is a pure function of timeline time, so renders are identical. Timed elements declare start and duration in seconds; each scene builds one paused timeline; no wall-clock time, unseeded randomness, network fetches or looping timers. Keep the project editable: one scene per sub-composition, copy and brand colours as variables, content inside the action-safe box and captions inside the title-safe box. Run the checker and fix reported violations, look at actual frames at the start, middle and end of each scene, then render.

**Caution:** fonts must be bundled or declared; grades and blurs on footage go through the media treatment tool, not ad-hoc CSS filters.

**Check:** a passing checker is necessary, not sufficient; look at frames from the start, middle and end of each scene before rendering.

_Condensed and modified adaptation of hyperframes skills and motion doctrines (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
