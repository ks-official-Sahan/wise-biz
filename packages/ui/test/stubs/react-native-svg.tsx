/**
 * Test stub for react-native-svg. jsdom cannot load its native entry (it imports react-native APIs that
 * react-native-web lacks). Tabler icons only need the element components, so each one renders nothing and
 * <Svg> renders a bare <svg> with its size. Native SVG rendering is checked in the gallery on device.
 */
import { createElement } from "react";

import type { ReactNode } from "react";

export function Svg(props: {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly children?: ReactNode;
}) {
  return createElement("svg", { width: props.width, height: props.height }, props.children);
}

const NOTHING = (): null => null;

export const Animate = NOTHING;
export const Circle = NOTHING;
export const ClipPath = NOTHING;
export const Defs = NOTHING;
export const Desc = NOTHING;
export const Ellipse = NOTHING;
export const FeBlend = NOTHING;
export const FeColorMatrix = NOTHING;
export const FeComponentTransfer = NOTHING;
export const FeComposite = NOTHING;
export const FeConvolveMatrix = NOTHING;
export const FeDiffuseLighting = NOTHING;
export const FeDisplacementMap = NOTHING;
export const FeDistantLight = NOTHING;
export const FeDropShadow = NOTHING;
export const FeFlood = NOTHING;
export const FeFuncA = NOTHING;
export const FeFuncB = NOTHING;
export const FeFuncG = NOTHING;
export const FeFuncR = NOTHING;
export const FeGaussianBlur = NOTHING;
export const FeImage = NOTHING;
export const FeMerge = NOTHING;
export const FeMergeNode = NOTHING;
export const FeMorphology = NOTHING;
export const FeOffset = NOTHING;
export const FePointLight = NOTHING;
export const FeSpecularLighting = NOTHING;
export const FeSpotLight = NOTHING;
export const FeTile = NOTHING;
export const FeTurbulence = NOTHING;
export const Filter = NOTHING;
export const ForeignObject = NOTHING;
export const G = NOTHING;
export const Image = NOTHING;
export const Line = NOTHING;
export const LinearGradient = NOTHING;
export const Marker = NOTHING;
export const Mask = NOTHING;
export const Metadata = NOTHING;
export const Path = NOTHING;
export const Pattern = NOTHING;
export const Polygon = NOTHING;
export const Polyline = NOTHING;
export const RadialGradient = NOTHING;
export const Rect = NOTHING;
export const Stop = NOTHING;
export const Switch = NOTHING;
export const Symbol = NOTHING;
export const Text = NOTHING;
export const TextPath = NOTHING;
export const Tspan = NOTHING;
export const Use = NOTHING;
export const View = NOTHING;
