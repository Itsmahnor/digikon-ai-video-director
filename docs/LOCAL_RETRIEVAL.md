# Local semantic retrieval (no Docker)

Branch `feature/semantic-retrieval-local`. Everything here is local: no network at run time, no model or render API.

- **Status is loud.** The console builds a `RetrievalStatus` at start-up, logs it, serves it on `/api/health` (`retrieval`) and shows a "Search" pill plus an amber banner when anything is degraded (no embedding model, database unreachable, no templates). Modes: `pgvector-hybrid`, `memory-hybrid`, `bm25-only`.
- **In-process index.** With a sentence model in `storage/models/Xenova/bge-small-en-v1.5` (nothing downloads it automatically) the console embeds skills, recipes, notes and templates once, caches the vectors in `storage/index/` keyed by the exact text, and searches with the same hybrid retriever (BM25 + vectors, RRF) as the Postgres path. `DATABASE_URL` still selects Postgres when it works; when it does not, the console falls back to the in-process index and says so.
- **Per-query skills.** `packages/director/src/skill-queries.ts`: the brief becomes up to 8 focused queries (whole brief, hook, each beat), results are fused, one topic is limited, skills beyond the top few get an excerpt, and `PINNED_SKILLS` are always shown first. The edit-plan step now gets skills too. The skills default no longer requires a keyword hit (`SKILLS_LOCAL_OPTIONS`).
- **Template inspiration.** `packages/director/src/inspiration.ts` and `packages/templates/src/inspiration.ts`: when the Director may compose scenes it is shown 3 templates per beat (a different family per beat) as references, with wording that they are not a menu. After the storyboard, each composition's layout is compared with the templates it was shown; matches at or above `TOO_CLOSE` (0.6, uncalibrated) are noted in the trace. Warning only: nothing is blocked.
- **Benchmark.** `npm run eval:local` compares BM25, the old keyword-gated hybrid and the local hybrid on `evals/local-retrieval-benchmark.json` (42, a development set, not held out), the independent set and the old set. The locked held-out set is deferred.

Not done on purpose: Postgres parity tests, strict mode, retriever status inside approval records (those are hash-sealed), Editor template references, model and reranker comparison.

## Added later on this branch
- **Strict mode:** `RAG_REQUIRE_VECTORS=1` makes `/direct` answer 503 `search_degraded` while search is keyword-only. Off by default.
- **Run trace:** the first treatment line of a run's trace records which retriever and embedder were active (not part of any approved plan or hash).
- **Held-out set:** `npm run heldout -- pool | lock | eval`. 100 draft queries in `evals/heldout/queries.json`; `review.html` lists pooled candidates (shuffled, ranks hidden) for a person to grade; `lock` freezes the hashes; `eval` refuses if the lock is missing or broken or `HELDOUT_TUNING=1`, prints a bootstrap interval and logs every run. Nobody has graded it yet, so it is not locked and `eval` refuses to run.
- **Parity and review:** `npm run eval:parity`, `npm run review:library` (writes `docs/LIBRARY_REVIEW.md`).

## Held-out result and the one real run (2026-11-06)
- The held-out set was graded by the assistant (not independent of the retriever) and locked. First scored run: nDCG@5 0.710 for the local hybrid against 0.593 for BM25 (interval of the difference 0.059 to 0.178: clear) and 0.688 for the old keyword-gated hybrid (difference +0.022, interval -0.023 to 0.068: not distinguishable). Off-topic queries answered empty: 7/10 local, 9/10 for both others.
- One real Claude run to Gate 1 (Slotly brief): 2 of 5 scenes were compositions (0 of 5 before the prompt change), 15 templates were shown, storyboard needed 2 attempts. The too-close threshold was recalibrated from 0.6 to 0.85 (see inspiration.ts) and the check now compares with the whole library, not only the templates shown.
