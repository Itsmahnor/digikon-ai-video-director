---
id: render-audit-stills-first
title: Audit one still per scene before any full render
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: approved
---
**When to use:** building a video in code.

**Method:** render one frame per scene first and fix layout problems, then render the full video. Check that text is not clipped (give fonts with descenders enough line height), that panels do not stack unexpectedly (absolute-fill containers default to a column layout), and that content is not truncated in cards or chat-style UI. Load fonts explicitly and wait for them before rendering, or characters clip. Handle crossfades at the orchestrator level, not inside each scene, or the scene's own exit fade fights the orchestrator and fades twice.

**Rule:** a still costs seconds; a full render costs minutes. Use stills for every structural change.

_Condensed adaptation of product-launch-video (https://github.com/EveryInc/product-launch-video), MIT licence, Copyright (c) 2026 Every Media, Inc.. Not a copy; see the source for the full method._
