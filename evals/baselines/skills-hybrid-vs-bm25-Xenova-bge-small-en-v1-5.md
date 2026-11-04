# Skills retrieval: hybrid vs BM25 (Xenova/bge-small-en-v1.5@1)

local sentence model Xenova/bge-small-en-v1.5. Corpus: 117 skills (all draft; queries run with include_draft for benchmarking only). Queries: 51 (dev 24, test 27). min_similarity chosen on dev: **0.75**; reported on the test split.

| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |
|---|---|---|---|---|---|---|---|---|---|---|
| test:overall | 25 | 0.840 | 0.800 | 0.920 | 0.920 | 0.880 | 0.860 | 0.885 | 0.871 | 0/2 / 0/2 |
| test:category:saas | 11 | 0.727 | 0.636 | 0.909 | 0.909 | 0.814 | 0.769 | 0.830 | 0.796 | 0/1 / 0/1 |
| test:category:ecommerce | 6 | 0.833 | 0.833 | 0.833 | 0.833 | 0.842 | 0.842 | 0.833 | 0.833 | 0/0 / 0/0 |
| test:category:general-promo | 8 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0/1 / 0/1 |
| test:tag:paraphrase | 10 | 0.800 | 0.800 | 1.000 | 1.000 | 0.883 | 0.883 | 0.913 | 0.913 | 0/0 / 0/0 |
| test:tag:scene_level | 5 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0 / 0/0 |
| test:tag:cross_cutting | 7 | 0.714 | 0.571 | 0.714 | 0.714 | 0.739 | 0.668 | 0.714 | 0.662 | 0/0 / 0/0 |
| test:tag:editor_scope | 3 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0 / 0/0 |
| all:overall | 47 | 0.851 | 0.872 | 0.915 | 0.936 | 0.885 | 0.907 | 0.889 | 0.910 | 0/4 / 0/4 |

## Dev sweep (min_similarity chosen on dev only)

| min_similarity | P@1 | R@3 | MRR | negatives empty |
|---|---|---|---|---|
| 0.2 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.3 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.4 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.5 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.55 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.6 | 0.864 | 0.909 | 0.899 | 0/2 |
| 0.65 | 0.909 | 0.909 | 0.923 | 0/2 |
| 0.7 | 0.909 | 1.000 | 0.947 | 0/2 |
| 0.75 | 0.955 | 0.955 | 0.960 | 0/2 |
| 0.8 | 0.864 | 0.909 | 0.891 | 0/2 |
| 0.85 | 0.864 | 0.909 | 0.891 | 0/2 |

## Category and scope leakage

0 leaks over 51 queries for BM25 and hybrid: no category query returned a skill from another specific category, and no Editor-scope query returned a Director-only skill.
