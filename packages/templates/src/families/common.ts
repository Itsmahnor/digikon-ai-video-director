import type { Ctx, Enter } from "../kit.js";

/** A size as a share of the frame's short edge, in pixels. */
export const z = (c: Ctx, k: number): number => Math.round(c.f.short * k);

/** x of a thing of width `rw` inside a block at (x, w), following the style's alignment. */
export const ox = (c: Ctx, x: number, w: number, rw: number): number => (c.s.align === "left" ? x : c.s.align === "right" ? x + w - rw : Math.round(x + (w - rw) / 2));

/** The grow enter that matches the alignment, so a rule grows away from the edge it is anchored to. */
export const grow = (c: Ctx): "grow_x" | "grow_x_c" | "grow_x_r" => (c.s.align === "left" ? "grow_x" : c.s.align === "right" ? "grow_x_r" : "grow_x_c");

/** Enter that follows alignment for sideways motion: from the left for left-aligned, from the right for right-aligned. */
export const side = (c: Ctx): Enter => (c.s.align === "right" ? "right" : c.s.align === "left" ? "left" : "rise");

/** A spacer for Ctx.block. */
export const gap = (c: Ctx, k: number) => ({ h: z(c, k), make() { /* space only */ } });
