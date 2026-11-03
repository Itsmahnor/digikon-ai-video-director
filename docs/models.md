# Local models

Weights live under `storage/models/` (git-ignored, never committed). Code loads them with `local_files_only`; nothing downloads at runtime.

## Xenova/bge-small-en-v1.5 (sentence embeddings for hybrid retrieval)

| field | value |
|---|---|
| source | https://huggingface.co/Xenova/bge-small-en-v1.5 (ONNX conversion of BAAI/bge-small-en-v1.5) |
| revision | `ea104dacec62c0de699686887e3f920caeb4f3e3` |
| licence | MIT (BAAI/bge-small-en-v1.5; the Xenova card does not restate it) |
| dtype used | q8 (`onnx/model_quantized.onnx`), same as the whisper and CLIP folders |
| dimensions | 384, CLS pooling, normalised; queries get the bge query instruction, documents do not |

Files in `storage/models/Xenova/bge-small-en-v1.5/`:

| file | bytes |
|---|---|
| onnx/model_quantized.onnx | 34,014,426 |
| tokenizer.json | 711,396 |
| vocab.txt | 231,508 |
| tokenizer_config.json | 366 |
| special_tokens_map.json | 125 |
| config.json | 683 |
| README.md | 3,134 |

To reproduce: fetch those files from the revision above (`https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/<revision>/<file>`) into that folder.

### Retrieval settings (tuned on the dev split only)

The benchmark is split by a hash of the query id (even = dev, 62 queries; odd = test, 62 queries). `npm run eval:hybrid -- --embedder auto --split dev --tune` grid-searched min_similarity 0.3-0.7 and RRF k in {20, 40, 60, 100} on dev only. Best on dev: min_similarity 0.65 (all four k values tied, so k stays at 60). Results are in `evals/baselines/hybrid-vs-bm25-Xenova-bge-small-en-v1-5-{dev,test}.md` and the whole set in `...-v1-5.md`.

Honest reading: with this model hybrid is about level with BM25 on the held-out test split (P@1 0.816 vs 0.816, MRR 0.852 vs 0.854); it helps paraphrases and hurts the near-verbatim seed queries slightly. The 62-query dev split is small, so 0.65 is a noisy optimum, not a settled value.
