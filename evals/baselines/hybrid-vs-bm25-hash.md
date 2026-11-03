# Hybrid vs BM25 (hash-features@1)

Embedder: hash embedder (wording only; no sentence model was asked for).
Queries: 124 (98 retrieval, 19 negative, 7 missing-knowledge). Hybrid uses RRF k=60 and min_similarity 0.2, fixed in advance, not tuned on this set.

| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 98 | 0.806 | 0.806 | 0.898 | 0.888 | 0.853 | 0.852 | 0.859 | 0.854 | 17/19 / 17/19 |
| collection:directing_principles | 22 | 0.682 | 0.727 | 0.909 | 0.909 | 0.789 | 0.812 | 0.813 | 0.830 | 5/6 / 5/6 |
| collection:ad_playbooks | 14 | 0.857 | 0.857 | 0.929 | 0.929 | 0.911 | 0.911 | 0.902 | 0.902 | 4/4 / 4/4 |
| collection:shot_recipes | 62 | 0.839 | 0.823 | 0.887 | 0.871 | 0.863 | 0.853 | 0.865 | 0.851 | 8/9 / 8/9 |
| collection:platform_specs | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:brand_product_facts | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:approved_examples | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| tag:seed | 21 | 0.952 | 0.952 | 0.952 | 0.952 | 0.964 | 0.964 | 0.952 | 0.952 | 0/0 / 0/0 |
| tag:paraphrase | 28 | 0.643 | 0.679 | 0.786 | 0.786 | 0.724 | 0.742 | 0.728 | 0.742 | 0/0 / 0/0 |
| tag:scene_level | 24 | 0.750 | 0.708 | 0.958 | 0.917 | 0.837 | 0.813 | 0.865 | 0.829 | 0/0 / 0/0 |
| tag:negative | 0 | - | - | - | - | - | - | - | - | 17/19 / 17/19 |
| tag:semantic | 6 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0/0 / 0/0 |

## Sensitivity to min_similarity (overall)

| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |
|---|---|---|---|---|---|
| 0.1 | 0.775 | 0.847 | 0.827 | 0.818 | 13/19 |
| 0.2 | 0.806 | 0.888 | 0.852 | 0.854 | 17/19 |
| 0.3 | 0.816 | 0.898 | 0.858 | 0.863 | 17/19 |
| 0.4 | 0.806 | 0.898 | 0.853 | 0.859 | 17/19 |
| 0.5 | 0.806 | 0.898 | 0.853 | 0.859 | 17/19 |

The hash embedder matches wording, spelling and word forms, not meaning. It cannot be expected to recover paraphrases that share no words with the document; a real sentence-embedding model has to be downloaded and approved before this comparison says anything about semantic retrieval.
