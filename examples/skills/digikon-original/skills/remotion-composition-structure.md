---
id: remotion-composition-structure
title: Remotion composition structure: root, compositions and sequences
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** planning or reviewing a Remotion video project.

**Structure:** a root registers one or more compositions, each with an id, width, height, frame rate and duration in frames. A composition is a React component that renders the frame for the current time. Scenes are laid out as sequences, each with a start frame and a length; a child component sees time relative to its own sequence start.

**Practice:** one component per scene, props for copy, colours and media so the same scene can be reused; keep a theme file for colours and fonts; keep the composition thin and move scenes into their own files as it grows.

**In this project:** scenes are described as scene graphs and compiled to a composition, so author scene content as data (elements, tracks, timelines) rather than hand-written components where possible.

**Licence warning:** Remotion has its own licence; check remotion.dev/license before commercial use.

_Original Digikon skill (MIT, Copyright (c) 2026 Digikon). Working guidance, not a benchmarked rule: check platform figures against the verified platform_specs before relying on them._
