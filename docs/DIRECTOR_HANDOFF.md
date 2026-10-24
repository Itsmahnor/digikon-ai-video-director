# Director handoff and Editor boundary

Status: contracts, validation and tests exist. The Editor agent itself is **not built yet**; this is the interface it will use. Nothing renders. Live Claude behaviour is **unverified** (no API key configured yet).

## Responsibilities

| Part | Owns | Code |
|---|---|---|
| Director agent | Brief, assets, treatment, storyboard, proposed edit plan, both human gates, the handoff | `packages/director` |
| Editor agent (future) | Turns the approved handoff into concrete edit operations; reports conflicts; never changes the approved plan | contract: `packages/contracts/src/editor.ts` |
| Skills | Stable procedures and rules (`skills/*/SKILL.md`) | `packages/director/src/skills.ts` |
| RAG | Reference knowledge, recipes, verified specs, brand facts. Not an agent | `packages/rag` |
| Orchestrator state | The run's brief, plans, versions, approvals | `packages/director/src/graph.ts` |

## Flow

```
Director graph -> gate 1 (storyboard) -> gate 2 (edit plan) -> status "approved"
  -> buildHandoff(state)          refuses unless checkRenderable passes (same guard as rendering)
  -> DirectorHandoff (frozen copy, content-hashed)
  -> checkHandoff(handoff)         Editor side: integrity, approvals vs plans, plan validity, recipe versions
  -> EditorInput -> Editor agent -> EditorOutput
  -> checkEditorOutput(output)     Director side: no silent change to the approved plan
     ready                    -> future renderer (must still pass assertRenderable)
     needs_director_revision  -> Director revision, then the human gates again
     blocked                  -> conflicts shown to the user
```

Console: `GET /api/sessions/:id/handoff` returns the handoff, or 409 `handoff_refused` with every reason.

## `DirectorHandoff` (schema_version 1.1.0)

All fields are mandatory; arrays may be empty. It copies what the Editor needs so the Editor never reads Director graph state.

| Field | Content | Reuses |
|---|---|---|
| `schema_version`, `handoff_id`, `content_hash`, `created_at` | Version of the shape; `ho_` + first 16 hex of the hash; SHA-256 of canonical JSON of everything except these three | `canonicalJson` |
| `run` | `run_id`, configured `model` (`demo`/`scripted` offline), recipe library mode | |
| `project` | Brief and delivery fields as entered | `Project` |
| `treatment`, `storyboard`, `edit_plan` | The approved plans, unchanged | `Treatment`, `ScenePlan`, `EditPlan` |
| `approvals`, `approved` | The two approval records and the version and hash each authorises | `ApprovalRecord` |
| `assets`, `asset_notes` | Only assets the storyboard uses, with measured notes | `Asset`, `AssetNotes` |
| `claims` | Claims a scene uses, each with its approved fact. Unsupported claims are excluded | `Claim`, `BrandFact` |
| `constraints` | Platform, aspect ratio, duration, brand id, verified spec ids (none exist yet) | |
| `qa` | Duration and tolerance, scene spans, whether audio is expected, loudness target (null until a verified spec exists), grounded claim ids | |
| `provenance` | Skills as name@version, skill references, recipes with version and status, every retrieved id with kind, source and grade/status | |

Not duplicated on purpose: timing, audio cues and transitions stay in `storyboard.scenes`; recipe parameters stay in `edit_plan.uses`; the brief stays in `project`.

A content hash that ignores `created_at` means the same approved plans always produce the same hash. Changing any plan after the handoff fails the content hash; re-hashing a tampered handoff still fails, because the plans no longer match their approval hashes.

## Production readiness (handoff 1.2.0)

Added after a real run showed scenes written off as "not realisable" in free text, claims that could not be told from invented facts, and no link between recipes and edit operations. Older (1.0.0, 1.1.0) handoffs and graph checkpoints (`director-graph/2`) are refused, not converted; nothing durable of that age existed.

- **Scene** gains `end_time` and `production_method` (both set by code: `graphics`, `supplied_footage` or `mixed`), `voiceover` (exact words; music and effects stay in `audio_cues`), `required_assets` and `unresolved`. Animation is carried by the edit plan's recipe uses, not by a scene field.
- **Timing contract** (`validatePlan`): scenes are listed in play order, run back to back from 0 without gap or overlap, have positive durations and consistent end times, and add up to the requested runtime within 0.05 s. The 30 s, 16:9 explainer has six scenes of 4, 5, 4, 6, 6 and 5 seconds.
- **Asset feasibility** (`assetFeasibility`): each requirement is `supplied` (a project file of the right media type), `generate_graphics` (the graphics workflow can build it; a logo, product screen or image that was not supplied is allowed only as a labelled `placeholder`, and live footage or audio never is), `needs_external` (blocks until supplied) or `missing_blocking`. Graphics-led scenes without footage are not blocked. Blockers also stop `assertRenderable` and the handoff.
- **Claims audit** (`auditClaims`): every treatment claim is `supported` (an approved fact), `illustrative` (a proposed feature or concept, shown as a concept and never as a verified fact) or `unsupported` (factual, no evidence). The model proposes `kind`, but wording with figures, prices, rankings or guarantees cannot be illustrative. Unsupported claims stay in the audit with an explanation and a safe alternative; scenes may not show them. The approvals' evidence hash covers every fact any claim points to.
- **Recipes** declare an `operation_type`, limited by `RECIPE_OPERATIONS` (shot and camera_move: `trim_clip`; transition: `concat` or `mix_audio`; animation: `overlay_text` or `render_graphics_scene`; sound_cue: `mix_audio`) and must name a renderer they list. `reviewed` needs a `review` record (reviewer, date, evidence); all 19 shipped recipes are `draft`. `checkEditorOutput` enforces the operation type.
- **Handoff** adds `claims_audit`, `asset_feasibility`, `required_operations` (each use as an operation with its recipe version, status, type, implementation and evidence) and `readiness` (`production_ready`, `blockers`, `warnings`). `checkHandoff` recomputes all four. Draft recipes always appear as blockers, so a plan is never called production-ready without review evidence.
- **Privacy**: the project record in a handoff has no `owner_id`; a handoff containing something that looks like an API key, a private key or the configured key is refused without repeating it. Asset paths and original file names are still included, because the Editor needs the files.

## Editor boundary (schema_version 1.0.0)

The Editor's skills are written but not yet loaded by any agent: see [skills/editor/README.md](../skills/editor/README.md).

- `EditorInput`: the handoff, the Editor's skills, and `retrieval_scope: "editor"`.
- `EditorOutput`: bound to `handoff_id`, `content_hash` and approved versions; `status` (`ready`, `needs_director_revision`, `blocked`); `operations` (the existing `EditOperation` plus `source_use_id`, `recipe_id`, `recipe_version`, `asset_ids`, `timing`, `caption`, `audio_cues`); `validation`; `conflicts` (missing information, unsupported operation, infeasible, conflicts with approved plan, knowledge missing, knowledge conflict); `revision_requests` (always `requires_reapproval: true`); `provenance` with retrieval records.
- The schema refuses `ready` when there are conflicts, revision requests or failed validation.
- `checkEditorOutput` refuses: operations on unknown scenes or uses, a different recipe or version, assets not approved for that scene, timing outside the scene, caption text other than the approved overlay, parameters different from the approved use without a revision request, and any approved use that is neither implemented nor reported.

Operations are data. No shell command, code or filter string is ever built from model text; a future renderer must map `recipe_id` to a reviewed template (`implementation_ref`).

## Retrieval scopes

One index and one retriever (`KeywordRetriever`) serve both agents. `ScopedRetriever` (`packages/rag/src/scopes.ts`) narrows it per agent:

- Director: all six collections; strategy, claims, cinematography and the editing topics it needs to propose an edit plan.
- Editor: `directing_principles`, `shot_recipes`, `platform_specs`, `approved_examples`; editing, transitions, audio, motion and text topics. No ad playbooks and no brand facts: grounded claims arrive in the handoff.
- Draft recipes and notes marked `status: draft` are excluded unless the scoped retriever is created in development mode; a caller cannot opt in alone. Unverified platform specs are never returned. `min_grade` filters by source quality.
- `retrieveOrReport` returns an explicit "no knowledge" message instead of an empty or unrelated answer.
- Every query is recorded (`RetrievalRecord`: agent, collection, query, filter applied, ids returned) and can be replayed.

The Director graph still uses its existing per-step topic filters (`STEP_TOPICS`); a test checks they all fall inside the Director scope.

## Configuration (no secrets in this file)

- `ANTHROPIC_API_KEY` goes in `.env` at the repo root (copy `.env.example`). `.env` is git-ignored and read only by the server and CLI (`process.loadEnvFile`). The browser never receives it.
- `ANTHROPIC_MODEL` is optional (default in `packages/director/src/llm.ts`).
- Without a key the console starts; planning needs a key, or demo mode (`npm run console:demo`).

## Storage (`packages/director/src/store.ts`)

```
storage/sessions/<session id>/runs/<run id>/approvals/000001.json   one gate decision per file, in order
storage/sessions/<session id>/runs/<run id>/handoff.json            latest verified handoff
```

- Each file is `{ format, format_version: 1, run_id, ... }` around a schema-checked record. Writes go to a `.tmp` file, are flushed, then moved into place; approval files are linked into place and never overwritten. Leftover `.tmp` files are ignored.
- The gate node writes the decision before it takes effect. If the write fails, the decision is not applied (the console answers 503) and the gate stays open.
- Loading fails closed: invalid JSON, an unknown format version, a record for another run, a wrong sequence number, a gap in the sequence, or a record that fails its schema makes every stored approval for that run untrusted.
- `verifyHandoffWithStore` compares the handoff's two approval records field by field with the latest stored ones, then runs `checkHandoff`. The console verifies before saving or serving a handoff, and `GET /api/sessions/:id/runs/:runId/handoff` re-verifies a saved handoff after a restart.
- Uploads get a SHA-256 of their bytes while being written (`metadata.sha256`, covered by the evidence hash). At handoff time a file whose size matches is hashed once and compared.
- Trust boundary: this protects against crashes, partial writes, accidental edits and handoffs edited outside the store. Anyone with write access to the storage folder can still change a plan and its stored approval together. Nothing here is a signature.
- `runs/<run id>/checkpoint.json` (graph version `director-graph/2`) holds the state where the run last stopped: waiting at a gate, approved or escalated. The console writes it after every run step and every decision, and reports `checkpoint.saved: false` when the write fails.
- `POST /api/sessions/:id/runs/:runId/resume` restores it into a new graph after a restart (`restoreRun`). It first requires: a readable checkpoint of this format and graph version, for this run and session; an approval history equal to the stored approval files; no already-approved version reappearing as waiting; at gate 2, a storyboard approval matching the current storyboard and evidence hashes; valid plans; and unchanged files. Then it places the state just before the gate and runs into the gate's pause. It never approves, and it never restarts a run from the beginning; any failure is 409 with reasons.
- A checkpoint saved while a model step is running is impossible by design; a crash mid-step loses only that step since the last gate.

## Known limitations

- Both approval records carry `evidence_hash` (since handoff schema 1.1.0): the full Asset records the storyboard uses (id, uri, media type, duration, dimensions, audio tracks, probe metadata including `bytes`), their analysis notes, and the id, text and source of every fact behind a claim a scene shows. A change to any of these after approval blocks `assertRenderable`, `buildHandoff` and `checkHandoff`. Re-hashing the handoff cannot fix that.
- At handoff time every used asset must exist, sit inside the session's storage folder (console), and have the byte size the probe recorded. Size is a cheap identity check, not a content hash; a same-size replacement file is not detected.
- No hash is a signature or proves who approved. A handoff edited outside the store is caught by comparison with the stored approvals; someone who can write to the storage folder can still change both.
- Hashing at handoff time is synchronous and reads the whole file once; a large video blocks the server while it is read.
- Records without `evidence_hash` still parse but cannot authorise a render or handoff. Handoffs with schema 1.0.0 are refused (none were persisted).
- `assertRenderable` is enforced where a handoff is built and shown in the console; no render entry point exists to enforce it on.
- The Director graph does not yet use `ScopedRetriever`, so its retrievals are recorded as ids only, not full query records. Editor revision requests are only flagged; nothing yet re-enters the Director graph.

- The Editor agent, its prompts and its own skill file do not exist yet. `skills/editing-director` is the Director's edit-plan skill.
- Knowledge is thin: 14 notes, no verified platform specs, no approved examples, no editor-only notes. The Editor would currently report most knowledge as missing.
- No semantic detection of conflicting knowledge; the contract has a `knowledge_conflict` kind for the agent to report.
- Handoffs and runs are in memory in the console; nothing is persisted.
- Mode C (`edit_existing`) routing still exists in the router and console and was left unchanged.
