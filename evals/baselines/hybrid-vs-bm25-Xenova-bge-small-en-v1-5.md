# Hybrid vs BM25 (Xenova/bge-small-en-v1.5@1)

Embedder: local sentence model Xenova/bge-small-en-v1.5.
Queries: 124 (98 retrieval, 19 negative, 7 missing-knowledge). Split: all. Hybrid uses RRF k=60 and min_similarity 0.65.

| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 98 | 0.806 | 0.816 | 0.898 | 0.898 | 0.853 | 0.859 | 0.859 | 0.863 | 17/19 / 17/19 |
| collection:directing_principles | 22 | 0.682 | 0.773 | 0.909 | 0.909 | 0.789 | 0.845 | 0.813 | 0.853 | 5/6 / 5/6 |
| collection:ad_playbooks | 14 | 0.857 | 0.929 | 0.929 | 0.929 | 0.911 | 0.946 | 0.902 | 0.929 | 4/4 / 4/4 |
| collection:shot_recipes | 62 | 0.839 | 0.806 | 0.887 | 0.887 | 0.863 | 0.844 | 0.865 | 0.851 | 8/9 / 8/9 |
| collection:platform_specs | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:brand_product_facts | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:approved_examples | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| tag:seed | 21 | 0.952 | 0.905 | 0.952 | 0.952 | 0.964 | 0.941 | 0.952 | 0.935 | 0/0 / 0/0 |
| tag:paraphrase | 28 | 0.643 | 0.750 | 0.786 | 0.821 | 0.724 | 0.788 | 0.728 | 0.790 | 0/0 / 0/0 |
| tag:scene_level | 24 | 0.750 | 0.708 | 0.958 | 0.917 | 0.837 | 0.806 | 0.865 | 0.823 | 0/0 / 0/0 |
| tag:negative | 0 | - | - | - | - | - | - | - | - | 17/19 / 17/19 |
| tag:semantic | 6 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 0/0 / 0/0 |

## Sensitivity to min_similarity (overall)

| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |
|---|---|---|---|---|---|
| 0.1 | 0.827 | 0.893 | 0.871 | 0.862 | 2/19 |
| 0.2 | 0.827 | 0.893 | 0.871 | 0.862 | 2/19 |
| 0.3 | 0.827 | 0.893 | 0.871 | 0.862 | 2/19 |
| 0.4 | 0.827 | 0.893 | 0.870 | 0.862 | 2/19 |
| 0.5 | 0.827 | 0.893 | 0.871 | 0.864 | 10/19 |
| 0.6 | 0.806 | 0.893 | 0.859 | 0.856 | 17/19 |
| 0.65 | 0.816 | 0.898 | 0.859 | 0.863 | 17/19 |
| 0.7 | 0.816 | 0.898 | 0.858 | 0.863 | 17/19 |
