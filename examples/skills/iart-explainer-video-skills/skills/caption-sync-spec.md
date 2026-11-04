---
id: caption-sync-spec
title: Caption sync: line, length and timing limits
category: all
topic: text-captions
scope: editor
funnel_stage: all
platform: all
grade: C
status: reviewed
---
**When to use:** adding captions to a narrated video.

**Spec:** captions are on by default, since many plays are muted. Keep at most two lines, about 42 characters per line, each cue on screen for at least 1.0 s and gone before the next begins. Key the cue list to the voice-over, and drive captions and scene cuts from the same timing data so they never drift.

**Format:** a standard subtitle file (SRT or VTT) with start and end times is the working format; keep a copy as the accessibility transcript.

**Check:** read a sample of cues aloud against the audio at the start, middle and end.

_Condensed adaptation of explainer-video-skills (https://github.com/iart-ai/explainer-video-skills), MIT licence, Copyright (c) 2026 iart.ai. Not a copy; see the source for the full method._
