---
id: real-captures-not-mock-ui
title: Use genuine captures; do not hand-build fake UI
category: saas
topic: claims-safety
scope: director
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** any scene that shows the product.

**Rule:** reproduce existing pages from real screenshots or recordings. Hand-built mock UI is allowed only where nothing real is being reproduced and only if it meets quality. Data shown in a capture follows risk rules: no personal data, no real customer names, no invented metrics.

**Technical note:** when a flat page is placed in a 3D perspective, rasterise it at native resolution; blurry text usually comes from the texture chain, not the camera.

**Ask first:** if the user has not supplied captures or confirmed that screens are genuine, ask rather than fabricate.

_Condensed and modified adaptation of video-shotcraft (https://github.com/Vincentwei1021/video-shotcraft), Apache-2.0, Copyright 2026 Wei Yihao. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
