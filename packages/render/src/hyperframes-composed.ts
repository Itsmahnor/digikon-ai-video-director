import type { ComposedScene, Move } from "./web-composed.js";
import { WEB_FONT_FAMILY } from "./web-scenes.js";

/**
 * The HyperFrames composition for composed scenes (a camera move on a supplied picture, an animated text entrance, an end card). It draws the same
 * planned numbers as the Remotion composition, with its own means: HTML and CSS keyframes that HyperFrames seeks frame by frame. The animation
 * clock is each scene's own (HyperFrames seeks a scene's animations from the scene's first frame, measured by rendering a film whose later scenes carry delays), so each animation starts at its own planned delay. A move or an entrance is described by
 * sampled stops with a linear timing function, so its easing is exactly the planned curve and not the browser's approximation of it.
 */

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sec = (frames: number, fps: number) => String(Number((frames / fps).toPrecision(12)));
const num = (n: number) => String(Number(n.toFixed(5)));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number, kind: string) => (kind === "ease_in_out" ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : t);
const STOPS = 20;

/** The CSS transform of the picture at progress t (0 to 1) of its move. */
export function moveTransform(m: Move, t: number, width: number, height: number): string {
  if (m.kind === "punch" || m.kind === "crop") throw new Error(`the ${m.kind} camera move is implemented by Remotion only; no HyperFrames template carries it out`);
  if (m.kind === "zoom") return `scale(${num(lerp(m.from, m.to, ease(t, m.easing)))})`;
  return `translate(${num(lerp(m.dx0, m.dx1, t) * width)}px, ${num(lerp(m.dy0, m.dy1, t) * height)}px) scale(${num(m.scale)})`;
}

/** Keyframes that follow the move exactly at STOPS+1 points. */
export function moveKeyframes(name: string, m: Move, width: number, height: number): string {
  const stops: string[] = [];
  for (let k = 0; k <= STOPS; k++) stops.push(`${num((k / STOPS) * 100)}%{transform:${moveTransform(m, k / STOPS, width, height)}}`);
  return `@keyframes ${name}{${stops.join("")}}`;
}

export function buildComposedComposition(scenes: readonly ComposedScene[], width: number, height: number, fps: number, totalFrames: number): string {
  const css: string[] = [], body: string[] = [];
  scenes.forEach((sc, i) => {
    const at = (frames: number) => num(frames / fps); // animation clocks are per scene: 0 is the scene's first frame
    const tx = sc.text;
    const parts: string[] = [];
    if (sc.image) {
      // the last frame of the scene is the end state of the move
      css.push(`${moveKeyframes(`mv${i}`, sc.image.move, width, height)}#s${i} .pic img{animation:mv${i} ${sec(Math.max(1, sc.frames - 1), fps)}s linear 0s both}`);
      parts.push(`<div class="pic"><img src="img${i}${sc.image.ext}" alt=""/></div>`);
    }
    if (tx && tx.strip) {
      css.push(`#s${i} .strip{left:0;width:100%;top:${(tx.y * 100).toFixed(2)}%;height:${num(tx.lines.length * tx.font_px * 1.2 + 48)}px;transform:translateY(-50%);background:rgba(0,0,0,.8)}`);
      parts.push(`<div class="strip"></div>`);
    }
    if (tx) {
      const box = `left:${(((1 - tx.w) / 2) * 100).toFixed(2)}%;width:${(tx.w * 100).toFixed(2)}%;top:${(tx.y * 100).toFixed(2)}%;font-size:${tx.font_px}px;color:${tx.color}${tx.strip ? ";background:rgba(0,0,0,.55);padding:18px 0" : ""}`;
      if (tx.mode === "stagger") {
        css.push(`#s${i} .tx{${box};transform:translateY(-50%)}#s${i} .w{display:inline-block;margin-right:.3em;animation:sw ${sec(tx.word_frames, fps)}s linear both}`);
        parts.push(`<div class="tx">${tx.words.map((w, k) => `<span class="w" style="animation-delay:${at(tx.delay_frames + k * tx.stagger_frames)}s">${esc(w)}</span>`).join("")}</div>`);
      } else {
        css.push(`@keyframes fu${i}{from{opacity:0;transform:translateY(calc(-50% + ${num(tx.distance_px)}px))}to{opacity:1;transform:translateY(-50%)}}#s${i} .tx{${box};animation:fu${i} ${sec(tx.duration_frames, fps)}s linear ${at(tx.delay_frames)}s both}`);
        parts.push(`<div class="tx">${esc(tx.text)}</div>`);
      }
    }
    if (sc.end_card && tx) {
      css.push(`@keyframes bar${i}{from{opacity:0}to{opacity:1}}#s${i} .bar{left:40%;width:20%;top:72%;height:6px;background:${sc.end_card.accent};animation:bar${i} ${sec(tx.duration_frames, fps)}s linear ${at(tx.delay_frames)}s both}`);
      parts.push(`<div class="bar"></div>`);
    }
    body.push(`<div id="s${i}" class="scene clip" data-start="${sec(sc.from_frame, fps)}" data-duration="${sec(sc.frames, fps)}" data-track-index="0" style="background:${sc.background}">${parts.join("")}</div>`);
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${width}, height=${height}"/>
<style>
@font-face{font-family:${WEB_FONT_FAMILY};src:url(font.ttf)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000}
.scene{position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;font-family:${WEB_FONT_FAMILY},sans-serif}
.pic{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden}
.pic img{width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
.tx{position:absolute;text-align:center;line-height:1.2;overflow-wrap:anywhere}
.strip,.bar{position:absolute}
@keyframes sw{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
${css.join("\n")}
</style></head><body>
<div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${sec(totalFrames, fps)}" data-width="${width}" data-height="${height}" data-fps="${fps}">
${body.join("\n")}
</div></body></html>
`;
}
