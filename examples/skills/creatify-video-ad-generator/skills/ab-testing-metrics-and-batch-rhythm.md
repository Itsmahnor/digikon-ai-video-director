---
id: ab-testing-metrics-and-batch-rhythm
title: Test metrics and a batch rhythm for ad variants
category: all
topic: testing
scope: director
funnel_stage: conversion
platform: all
grade: C
status: draft
---
**When to use:** the user will run several variants and wants to know what to compare.

**Metrics in order:** hook rate (three-second views over impressions), hold rate (completions over three-second views), then cost per acquisition or return on ad spend, which only mean something at enough spend.

**Rhythm:** write five hook variants over the same body and CTA, run them as separate ad sets with identical targeting, remove the bottom two after about three days, scale the winner after about seven, and write new hooks inspired by the winner. Change one variable at a time.

**Rules of thumb:** enough spend and at least about a thousand impressions per variant for directional data; three to seven days to cover day-of-week variance. These are starting points, not guarantees.

**Claims warning:** report the test design, not a promised lift.

_Condensed adaptation of video-ad-generator (https://github.com/creatify-ai/video-ad-generator), MIT licence, Copyright (c) 2026 Creatify AI. Not a copy; see the source for the full method._
