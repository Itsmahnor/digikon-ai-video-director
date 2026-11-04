# Skill review checklist

A skill starts as `draft`. It may be promoted to `reviewed` only when it passes every check below. `approved` is a human act: it is set with `npm run skills:review -- --apply --approve "<who>, <YYYY-MM-DD>, <basis>"`, which records who approved and when in `examples/skills/REVIEW.json` and `REVIEW.md`. **Digikon approved the 111 skills that passed the checks on 2026-11-04 (their messages in the project thread); the 6 skimmed-source skills stay `draft`.** Approval covers the text as it was on that date: a skill that is edited and then fails a check goes back to `draft` the next time the script runs.
`npm run skills:review` applies the checks and writes `examples/skills/REVIEW.json` and `examples/skills/REVIEW.md`; `npm run skills:review -- --apply` also sets `status: reviewed` in the files of the skills that pass.

**Who reviewed these.** The checks were run by the same agent that wrote the skills. The mechanical checks (C1, C2, C3, C5, C6, C7) are scripted and repeatable; C4 is a scripted flag plus a judgement; C8 is the author's own account of how closely a source was read. A human (Digikon) then approved the result on 2026-11-04. That approval is the owner's decision, not an independent line-by-line review.

| # | Check | How it is checked | Fails when |
|---|---|---|---|
| C1 | Licence and attribution | The source folder has a `LICENSE` file whose detected licence equals the manifest's licence; the licence is on the allow-list; an attribution line is present; the source URL is present. | any missing or mismatching |
| C2 | No long verbatim copy | Every run of words in the skill body is compared with every text file of the cloned source repos (`--sources`, default `D:\skills-src`). | a run of 12 or more consecutive words appears verbatim in a source. If the sources are not available the check is "not checked" and the skill is not promoted |
| C3 | Claims safety | Skills that give advice on what a video says (playbooks, hooks, CTA and offer, funnel, structure, platform rules, claims, testing, brief, quality) must carry a claims or caution line. | none present |
| C4 | No invented statistics | Percentages, money amounts and counts that look like facts are flagged; each must sit in a sentence that marks it as typical, approximate, a default, a creator or source figure, or an example. | an unmarked figure |
| C5 | Platform numbers are defaults | Skills with `platform-rules` topic, and any skill naming platform lengths or sizes, must say to confirm against the verified platform specs or call the figures defaults. | no such statement |
| C6 | Director format | Every skill has `When to use`. Video-type playbooks written by Digikon also have `Structure`, `Scene beats`, `Pacing` and `Asset needs`. Every other skill has at least two further labelled sections besides `When to use`, `Example` and the caution lines. Originals 150 to 350 words; adaptations 80 to 350. | a section missing, or length outside the range |
| C7 | Provenance line | Adapted skills end with a line naming the source URL, the licence and the copyright holder, and say they are condensed adaptations. Originals say they are original. | missing |
| C8 | Source read closely | Skills whose source the author read only in outline stay `draft`. This is recorded by hand in `scripts/skill-review-notes.json`, with the reason. | listed as skimmed |

Retrieval: `reviewed` and `approved` skills are returned with `SKILLS_INCLUDE_DRAFT` off; `draft` skills only when it is on.
