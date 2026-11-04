---
id: remotion-scene-graph-mapping
title: Map a digikon scene graph to Remotion
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** a scene is authored as a scene graph and must be drawn by Remotion.

**Mapping:** each graph is validated first, then compiled. Elements (text, shape, image, video, mask, group, chart, cursor) become positioned layers; tracks animate x, y, scale, rotate, opacity and similar properties over time with named easings; timeline times in seconds become frames at the composition's frame rate; one graph exists per aspect ratio because positions are pixels. Groups and masks set the stacking and clipping.

**Rules:** the graph carries data, never code; the flag that enables scene-graph drawing is off by default, so confirm it is on before relying on it; unsupported element or property values are reported, not silently dropped.

**Check:** compare a rendered still against the expected layout at the start, middle and end of the scene.

**Licence warning:** Remotion has its own licence; check remotion.dev/license before commercial use.

_Original Digikon skill (MIT, Copyright (c) 2026 Digikon). Working guidance, not a benchmarked rule: check platform figures against the verified platform_specs before relying on them._
