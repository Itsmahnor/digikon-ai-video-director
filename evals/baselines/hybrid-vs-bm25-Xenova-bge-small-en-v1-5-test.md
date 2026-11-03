# Hybrid vs BM25 (Xenova/bge-small-en-v1.5@1)

Embedder: local sentence model Xenova/bge-small-en-v1.5.
Queries: 62 (49 retrieval, 9 negative, 4 missing-knowledge). Split: test. Hybrid uses RRF k=60 and min_similarity 0.65.

| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 49 | 0.816 | 0.816 | 0.878 | 0.857 | 0.854 | 0.852 | 0.852 | 0.842 | 7/9 / 7/9 |
| collection:directing_principles | 9 | 0.778 | 0.889 | 1.000 | 0.889 | 0.870 | 0.917 | 0.903 | 0.889 | 4/5 / 4/5 |
| collection:ad_playbooks | 7 | 0.857 | 0.857 | 0.857 | 0.857 | 0.893 | 0.893 | 0.857 | 0.857 | 0/0 / 0/0 |
| collection:shot_recipes | 33 | 0.818 | 0.788 | 0.849 | 0.849 | 0.841 | 0.826 | 0.837 | 0.826 | 3/4 / 3/4 |
| collection:platform_specs | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:brand_product_facts | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| collection:approved_examples | 0 | - | - | - | - | - | - | - | - | 0/0 / 0/0 |
| tag:seed | 11 | 0.909 | 0.818 | 0.909 | 0.909 | 0.932 | 0.886 | 0.909 | 0.875 | 0/0 / 0/0 |
| tag:paraphrase | 16 | 0.750 | 0.813 | 0.813 | 0.813 | 0.792 | 0.823 | 0.789 | 0.813 | 0/0 / 0/0 |
| tag:scene_level | 12 | 0.750 | 0.750 | 0.917 | 0.833 | 0.826 | 0.819 | 0.844 | 0.803 | 0/0 / 0/0 |
| tag:negative | 0 | - | - | - | - | - | - | - | - | 7/9 / 7/9 |
| tag:semantic | 2 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0/0 / 0/0 |

## Sensitivity to min_similarity (overall)

| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |
|---|---|---|---|---|---|
| 0.1 | 0.857 | 0.918 | 0.895 | 0.893 | 1/9 |
| 0.2 | 0.857 | 0.918 | 0.895 | 0.893 | 1/9 |
| 0.3 | 0.857 | 0.918 | 0.895 | 0.893 | 1/9 |
| 0.4 | 0.857 | 0.918 | 0.894 | 0.893 | 1/9 |
| 0.5 | 0.857 | 0.918 | 0.898 | 0.896 | 6/9 |
| 0.6 | 0.837 | 0.939 | 0.886 | 0.898 | 7/9 |
| 0.65 | 0.816 | 0.857 | 0.852 | 0.842 | 7/9 |
| 0.7 | 0.837 | 0.878 | 0.864 | 0.860 | 7/9 |
