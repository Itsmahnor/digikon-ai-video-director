import React from "react";
import { Composition, registerRoot } from "remotion";
import { CompositionScenes } from "./Compositions.jsx";

// The scene-composition project. It is separate from remotion-project/ on purpose: the validation evidence of the plain and composed scenes
// is fingerprinted over that folder, and this template has its own evidence (capabilities/visual). The composition is a pure function of its
// input props: the size, frame rate, length and scenes the adapter validated. Nothing here reads a file, the network or the clock.
const Root = () => (
  <Composition
    id="Compositions"
    component={CompositionScenes}
    width={640}
    height={360}
    fps={30}
    durationInFrames={30}
    defaultProps={{ width: 640, height: 360, fps: 30, total_frames: 30, font: "font.ttf", scenes: [] }}
    calculateMetadata={({ props }) => ({ width: props.width, height: props.height, fps: props.fps, durationInFrames: props.total_frames })}
  />
);

registerRoot(Root);