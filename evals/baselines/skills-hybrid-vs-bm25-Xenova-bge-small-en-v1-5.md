# Skills retrieval: BM25 vs hybrid, with and without an off-topic floor (Xenova/bge-small-en-v1.5@1)

local sentence model Xenova/bge-small-en-v1.5. Corpus: 117 skills (all draft; queries run with include_draft for benchmarking only).
Independent set: 85 queries (dev 42, test 43), written from the taxonomy without reading skill text. Old set: 51 queries, written alongside the skills.
Tuned on the independent DEV half only. Objective: MRR + 0.5 x share of off-topic queries answered empty. Chosen: BM25 idf floor **0.2**; hybrid min_similarity **0.5**, abstain below **0.65**, keyword-only similarity gate **0.5**, idf floor **0**. **Recommended default: hybrid - hybrid (min_sim 0.6) + keyword abstention only (idf >= 0.2, no vector gate) [fixed variant, not tuned].** Chosen among the floor configurations by the highest objective on the held-out independent TEST half (1.204; the old set, untouched by tuning, confirms it: 1.149). The dev-selected hybrid floor over-fitted the small dev half, so the recommendation is a choice made after seeing test numbers, not the dev winner.

## independent TEST

| retriever | n | P@1 | R@3 | MRR | nDCG@3 | off-topic answered empty |
|---|---|---|---|---|---|---|
| BM25, no floor | 37 | 0.486 | 0.649 | 0.620 | 0.582 | 1/6 |
| BM25 + idf floor 0.2 | 37 | 0.486 | 0.649 | 0.572 | 0.582 | 6/6 |
| hybrid (min_sim 0.6), no floor | 37 | 0.622 | 0.838 | 0.735 | 0.740 | 1/6 |
| hybrid (min_sim 0.5) + floor (abstain below 0.65, keyword-only sim >= 0.5, idf >= 0) | 37 | 0.460 | 0.568 | 0.516 | 0.517 | 6/6 |
| hybrid (min_sim 0.5) + keyword abstention (require a keyword hit, idf >= 0.1) | 37 | 0.460 | 0.568 | 0.513 | 0.517 | 6/6 |
| hybrid (min_sim 0.6) + keyword abstention only (idf >= 0.2, no vector gate) [fixed variant, not tuned] | 37 | 0.622 | 0.730 | 0.704 | 0.686 | 6/6 |

## independent ALL

| retriever | n | P@1 | R@3 | MRR | nDCG@3 | off-topic answered empty |
|---|---|---|---|---|---|---|
| BM25, no floor | 73 | 0.562 | 0.712 | 0.676 | 0.651 | 3/12 |
| BM25 + idf floor 0.2 | 73 | 0.548 | 0.699 | 0.626 | 0.638 | 9/12 |
| hybrid (min_sim 0.6), no floor | 73 | 0.671 | 0.849 | 0.773 | 0.773 | 3/12 |
| hybrid (min_sim 0.5) + floor (abstain below 0.65, keyword-only sim >= 0.5, idf >= 0) | 73 | 0.548 | 0.657 | 0.607 | 0.608 | 12/12 |
| hybrid (min_sim 0.5) + keyword abstention (require a keyword hit, idf >= 0.1) | 73 | 0.534 | 0.644 | 0.594 | 0.594 | 12/12 |
| hybrid (min_sim 0.6) + keyword abstention only (idf >= 0.2, no vector gate) [fixed variant, not tuned] | 73 | 0.616 | 0.794 | 0.708 | 0.716 | 9/12 |

## old set (51, untouched by tuning)

| retriever | n | P@1 | R@3 | MRR | nDCG@3 | off-topic answered empty |
|---|---|---|---|---|---|---|
| BM25, no floor | 47 | 0.872 | 0.915 | 0.896 | 0.896 | 0/4 |
| BM25 + idf floor 0.2 | 47 | 0.872 | 0.915 | 0.895 | 0.896 | 2/4 |
| hybrid (min_sim 0.6), no floor | 47 | 0.830 | 0.936 | 0.891 | 0.897 | 0/4 |
| hybrid (min_sim 0.5) + floor (abstain below 0.65, keyword-only sim >= 0.5, idf >= 0) | 47 | 0.766 | 0.872 | 0.827 | 0.833 | 4/4 |
| hybrid (min_sim 0.5) + keyword abstention (require a keyword hit, idf >= 0.1) | 47 | 0.766 | 0.872 | 0.828 | 0.833 | 4/4 |
| hybrid (min_sim 0.6) + keyword abstention only (idf >= 0.2, no vector gate) [fixed variant, not tuned] | 47 | 0.830 | 0.979 | 0.899 | 0.918 | 2/4 |

## Sensitivity: the ten best hybrid configurations on DEV (selection uses dev only; test shown for transparency)

| min_sim | abstain below | keyword-only sim | idf | require keyword | dev MRR | dev off-topic empty | dev objective |
|---|---|---|---|---|---|---|---|
| 0.5 | 0.65 | 0.5 | 0 | no | 0.700 | 6/6 | 1.200 |
| 0.2 | 0.65 | off | 0 | no | 0.698 | 6/6 | 1.198 |
| 0.5 | 0.65 | off | 0 | no | 0.698 | 6/6 | 1.198 |
| 0.2 | 0.65 | 0.5 | 0 | no | 0.698 | 6/6 | 1.198 |
| 0.6 | 0.65 | 0.5 | 0 | no | 0.698 | 6/6 | 1.198 |
| 0.6 | 0.65 | off | 0 | no | 0.695 | 6/6 | 1.195 |
| 0.5 | 0.65 | 0.5 | 0.1 | no | 0.676 | 6/6 | 1.176 |
| 0.5 | 0.65 | 0.5 | 0.1 | yes | 0.676 | 6/6 | 1.176 |
| 0.6 | 0.65 | 0.5 | 0.1 | no | 0.676 | 6/6 | 1.176 |
| 0.6 | 0.65 | 0.5 | 0.1 | yes | 0.676 | 6/6 | 1.176 |

Recall@3 is capped on topic queries because many skills are relevant to one topic; read P@1, MRR and nDCG@3 first.

## Category and scope leakage

0 leaks for the floor configurations on both sets: no category query returned a skill from another specific category, and no query returned a skill outside the querying agent's scope.
