# Hybrid vs BM25 (Xenova/bge-small-en-v1.5@1)

Embedder: local sentence model Xenova/bge-small-en-v1.5.
Queries: 62 (49 retrieval, 10 negative, 3 missing-knowledge). Split: dev. Hybrid uses RRF k=60 and min_similarity 0.65.

| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 49 | 0.796 | 0.816 | 0.918 | 0.939 | 0.853 | 0.865 | 0.865 | 0.883 | 10/10 / 10/10 |
| collection:directing_principles | 13 | 0.615 | 0.692 | 0.846 | 0.923 | 0.733 | 0.795 | 0.751 | 0.828 | 1/1 / 1/1 |
| collection:ad_playbooks | 7 | 0.857 | 1.000 | 1.000 | 1.000 | 0.929 | 1.000 | 0.947 | 1.000 | 4/4 / 4/4 |
| collection:shot_recipes | 29 | 0.862 | 0.828 | 0.931 | 0.931 | 0.887 | 0.865 | 0.897 | 0.879 | 5/5 / 5/5 |
| collection:platform_specs | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:brand_product_facts | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:approved_examples | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| tag:seed | 10 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0 / 0/0 |
| tag:paraphrase | 12 | 0.500 | 0.667 | 0.750 | 0.833 | 0.634 | 0.742 | 0.647 | 0.761 | 0/0 / 0/0 |
| tag:scene_level | 12 | 0.750 | 0.667 | 1.000 | 1.000 | 0.847 | 0.792 | 0.886 | 0.844 | 0/0 / 0/0 |
| tag:negative | 0 | - | - | - | - | - | - | - | - | 10/10 / 10/10 |
| tag:semantic | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0/0 / 0/0 |

## Sensitivity to min_similarity (overall)

| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |
|---|---|---|---|---|---|
| 0.1 | 0.796 | 0.867 | 0.846 | 0.832 | 1/10 |
| 0.2 | 0.796 | 0.867 | 0.846 | 0.832 | 1/10 |
| 0.3 | 0.796 | 0.867 | 0.846 | 0.832 | 1/10 |
| 0.4 | 0.796 | 0.867 | 0.846 | 0.832 | 1/10 |
| 0.5 | 0.796 | 0.867 | 0.845 | 0.832 | 4/10 |
| 0.6 | 0.775 | 0.847 | 0.831 | 0.814 | 10/10 |
| 0.65 | 0.816 | 0.939 | 0.865 | 0.883 | 10/10 |
| 0.7 | 0.796 | 0.918 | 0.853 | 0.865 | 10/10 |
