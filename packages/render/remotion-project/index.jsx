import React from "react";
import { Composition, registerRoot } from "remotion";
import { Scenes } from "./Scenes.jsx";

// The composition is a pure function of its input props: the size, frame rate, length and scenes the adapter validated.
// Nothing here reads a file, the network or the clock.
const Root = () => (
  <Composition
    id="Scenes"
    component={Scenes}
    width={640}
    height={360}
    fps={30}
    durationInFrames={30}
    defaultProps={{ width: 640, height: 360, fps: 30, total_frames: 30, font: "font.ttf", badge: "", scenes: [] }}
    calculateMetadata={({ props }) => ({ width: props.width, height: props.height, fps: props.fps, durationInFrames: props.total_frames })}
  />
);

registerRoot(Root);
