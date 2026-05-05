/**
 * Loose ambient declaration for `@mkkellogg/gaussian-splats-3d`. The library doesn't
 * ship typings, but our adapter only touches `Viewer`, `SceneFormat`, and a few
 * methods; declaring them as `unknown` lets TypeScript stay out of the way while
 * still flagging stray imports.
 */
declare module '@mkkellogg/gaussian-splats-3d' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Viewer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const DropInViewer: any;
  export const SceneFormat: { Ply: number; Splat: number; KSplat: number; Spz: number };
  export const SceneRevealMode: { Default: number; Gradual: number; Instant: number };
  export const RenderMode: Record<string, number>;
  export const SplatRenderMode: Record<string, number>;
  export const LogLevel: Record<string, number>;
  export const WebXRMode: Record<string, number>;
}
