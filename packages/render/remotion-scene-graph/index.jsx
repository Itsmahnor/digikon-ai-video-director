import React from "react";
import { Composition, registerRoot } from "remotion";
import { SceneGraphScene } from "./SceneGraph.jsx";

// The scene-graph project: separate from remotion-project/ and remotion-compositions/ on purpose, so the evidence of those templates is untouched.
// The composition is a pure function of its props: the compiled graph's canvas, the graph itself and the palette. Nothing here reads a file, the
// network or the clock. It is used only when SCENE_GRAPH=on.
const Root = () => (
  <Composition
    id="SceneGraph"
    component={SceneGraphScene}
    width={640}
    height={360}
    fps={30}
    durationInFrames={30}
    defaultProps={{ graph: null, palette: { background: "#000000", surface: "#111111", text: "#ffffff", muted: "#aaaaaa", accent: "#ffcc00", accent_2: "#66ccff" }, font_family: "sans-serif" }}
    calculateMetadata={({ props }) => ({ width: props.graph.canvas.width, height: props.graph.canvas.height, fps: props.graph.canvas.fps, durationInFrames: Math.max(1, Math.round(props.graph.duration_s * props.graph.canvas.fps)) })}
  />
);

registerRoot(Root);
