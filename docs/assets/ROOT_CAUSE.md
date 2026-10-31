# Why uploaded images do not reach the video (Phase 1 audit)

Traced from real sessions in `storage/sessions`, not inferred from the code alone. No session was changed.

## Short answer

Uploads are stored correctly. Nothing is lost at upload. Images are lost at five later points. The first is the decisive one: **nothing in the product looks at an image**, so the Director is correctly told it may not trust any of them, and it plans around them.

## Trace

| Stage | Code | State | Verdict |
|---|---|---|---|
| Upload and storage | `apps/console/src/app.ts:265`, `packages/media/src/probe.ts` | Original kept in `storage/sessions/<id>/uploads/<asset_id><ext>`, probed, SHA-256 recorded | Works |
| Asset record | `Asset` in `packages/contracts/src/schemas.ts:33` | Held in session memory; persisted only once a run checkpoint exists | Gap: an upload-only session does not survive a restart |
| Understanding | `packages/media/src/image.ts` | Flat colour, colour count, skin-tone share only. It says "kind", never content | **Root cause 1** |
| Review | `POST /assets/:id/review`, `VisualReview` | Manual only. Nothing in the UI asks for it during normal use | **Root cause 1** |
| Director input | `packages/director/src/nodes.ts:221` | Sends id, type and size. The original filename and any user intent are dropped | **Root cause 2** |
| Storyboard schema | `Scene` in `schemas.ts:76` | `asset_ids` and `required_assets` only: no role, placement, scale, crop, layer, animation, mandatory flag or reason | **Root cause 3** |
| Creative rules | `packages/contracts/src/visual.ts:192` | `visual_with_assets` forbids a drawn scene from carrying an image | **Root cause 4** |
| Renderer | `packages/render/src/composition.ts`, `remotion-compositions/Compositions.jsx` | The scene-composition engine, which draws every modern scene, has no image support at all | **Root cause 4** |
| Scene routing | `packages/render/src/assemble.ts:197` | One scene cannot mix engines, so an FFmpeg image scene with a Remotion camera move becomes a placeholder | **Root cause 5** |
| Delivery checks | `packages/render/src/coverage.ts`, `verify.ts` | "Shown" means an operation carries the asset. FFmpeg image scenes end as `rendered_unverified`. No frame is compared with the uploaded file | **Root cause 5** |

## Root causes with evidence

1. **No semantic understanding.** The only analysis is pixel statistics. Session `9e162fb04248`: the DigiKon logo (`logo.png`, 2084Ã—2084) was stored as "98% flat colour, 3 main colours... What it shows has not been reviewed." Measuring is honest but it is not understanding, and the notes say so.

2. **The Director is told not to use unreviewed images, and almost none are reviewed.** The storyboard prompt says "Never assign a picture to a need that depends on what it shows (people, a product screen, a logo) unless its review says it fits." In `9e162fb04248` the plan drew S05 with `logo:generate_graphics:placeholder`, and S01 notes the "supplied image asset_eaacf677 has not been" reviewed. The logo existed and a typeset name replaced it. In `b2011a4da7c0` all three uploads were left out, with S02 waiting on "If a vision pass shows...". The user's intent about an image also has nowhere to go.

3. **The plan cannot express how an image is used.** A scene can list an id, but not its role, where it goes, how large, or whether it must appear. So "mandatory" cannot exist, and a missing image cannot be reported precisely.

4. **Modern scenes cannot show images.** Once a treatment has art direction, scenes are drawn by `remotion/scene-composition`, which has no image layer, and validation refuses a drawn scene with an asset. The image-capable path is the older `image-caption` template: one image, one caption, no layers, no logo overlay.

5. **Surviving images are fragile, and success is not proven.** Session `9767bc862d34`, S04: `ffmpeg/image-scene` plus `remotion/slow-push-in` gave "its operations need more than one engine", so the uploaded screen became a placeholder. S02 and S06: "it needs a logo ... that this renderer cannot show". S03 did render, but as `rendered_unverified`. Nothing anywhere confirms that the uploaded pixels appear in the output.

## Also found

- The DigiKon logo is transparent (96% of pixels), with the mark filling under 10% of the canvas, and its dark "D" and "SOLUTIONS" would disappear on Deep Teal. Rendering needs a tight, non-destructive crop and a light plate behind a mark that would otherwise vanish.
- `packages/media/src/limits.ts` accepts PNG, JPEG and WebP only. GIF, BMP, TIFF and AVIF are refused at upload.
- A renderer that shows an asset also needs safe paths: the render job carries a raw `uri` and no record of which bytes were loaded.

## Constraints for the fix

- `storyboardHash` covers the parsed scene plan, and `evidenceHash` covers the notes of used assets. New fields must be **optional with no default**, or existing approvals would go stale.
- `approvedEvidence` finds used assets through `scene.asset_ids`, so asset references must stay in step with that list.
- Originals are never rewritten. Thumbnails and normalised copies are separate derived files.

## Available local, free vision

| Need | Option | Status |
|---|---|---|
| Classification | CLIP through `@huggingface/transformers`, already used for Whisper | Local, free |
| Description | ViT-GPT2 captioning through the same library | Local, free, simple sentences |
| OCR | Windows.Media.Ocr, tested here on a dashboard and the logo | Local, free, Windows only |
| OCR elsewhere | Tesseract CLI when installed | Optional |
| Technical | `ffprobe`, `ffmpeg`, `sharp` | Installed |

Models download once from Hugging Face into `storage/models`, as Whisper does. No paid API is required.
