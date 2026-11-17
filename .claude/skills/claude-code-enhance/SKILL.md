---
name: claude-code-enhance
description: Rewrite a rough or broad request into a precise, scoped, verifiable engineering prompt before any work starts. Use when the user asks to enhance/improve a prompt, then run the enhanced version.
---

# claude-code-enhance

1. Restate the goal in one sentence (outcome, not activity).
2. Add missing context from the repo (stack, branch, docs the user pasted) instead of asking, where it can be read.
3. Split into ordered, checkable tasks: reproduce -> measure -> diagnose -> propose -> (only then) change.
4. Demand evidence: every claim of "root cause" must cite file/line, log, or a measured output.
5. State constraints: do not change approved safety gates; no secrets in output; confirm before destructive or costly actions (paid API calls, installs).
6. Define deliverables and format (report, diagrams, prioritized fixes with reasons and trade-offs).
7. Output the enhanced prompt, then execute it.
