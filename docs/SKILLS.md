# Skills library

Production skills are short pieces of craft guidance (how a SaaS demo is structured, how to cut on the beat, what to ask when the logo is missing). The Director reads them when planning and the Editor when turning an approved plan into operations. They are reference data: a skill never supports a claim, only approved brand facts do.

## Where they are

`examples/skills/<source>/` : one folder per source, each with `skills-source.json` (repo, URL, licence, attribution), the source's `LICENSE`, and `skills/*.md`. Every file has frontmatter:

| field | values |
|---|---|
| `category` | the kind of video: `saas`, `ecommerce`, `general-promo`, or `all` (applies to any) |
| `topic` | the concept: `hook`, `structure`, `pacing`, `text-captions`, `cta-offer`, `brand`, `claims-safety`, `platform-rules`, `video-type-playbook`, `motion`, `renderer`, ... |
| `scope` | who reads it: `director`, `editor` or `both` |
| `funnel_stage`, `platform`, `grade` | awareness / consideration / conversion / retention / all; platforms; free-text grade |
| `status` | `draft`, `reviewed`, `approved`, `retired` |

A query for a category returns that category **and** `all`, never another specific category.

## Importing

`npm run skills -- import examples/skills [--dry-run]` runs: licence gate (MIT, Apache-2.0, BSD, CC0, CC-BY with attribution; anything else, or a missing licence, refuses the whole source and says why) -> normalise -> drop near-duplicates -> embed -> store. Without `DATABASE_URL` it uses an in-memory store (a check only). A repeat import changes nothing.

## Status and review

Everything starts as `draft`. `docs/SKILL_REVIEW.md` is the checklist; `npm run skills:review [-- --apply]` applies it and writes `examples/skills/REVIEW.md` and `REVIEW.json`. Passing skills become `reviewed`; **`approved` is for a human**. The first review was done by the agent that wrote the skills, so it needs a human spot-check. Skills whose source was only skimmed stay `draft`.

`reviewed` skills are retrieved by default. `draft` skills are hidden unless `SKILLS_INCLUDE_DRAFT=1` (demos, development). That switch only widens what may be read; no approval gate or render gate looks at it.

## Retrieval

The Director's treatment and storyboard steps and the Editor's knowledge step retrieve skills for the project's `video_category` (set in the console form; unset means only `all` skills). The ids used are recorded as citations and appear in the handoff provenance.

- With `DATABASE_URL` set the console reads skills from Postgres and ranks with hybrid retrieval (BM25 + pgvector); otherwise it uses BM25 over the files. Both use the off-topic floor in `packages/rag/src/skills-defaults.ts`: a query that matches no distinctive word returns nothing.
- `npm run eval:skills` benchmarks BM25 against hybrid, with and without the floor, on two query sets (`evals/skills-benchmark.json`, written alongside the skills, and `evals/skills-benchmark-independent.json`, written from the taxonomy without reading skill text). The floor is tuned on the dev half of the independent set only; results and caveats are in `evals/baselines/skills-hybrid-vs-bm25-*.md`.
- `npm run skills:demo` runs the Director per category with the stub model and prints the skills cited.

## Not proven

Database behaviour was tested on PGlite (Postgres compiled to WebAssembly, with pgvector), not on a Postgres server. The demos used the stub model, not Claude. The benchmark queries were written by the same agent that wrote the skills.
