export { captureSceneVideo, captureVideo } from './capture/capture.js';
export type {
  CaptureAction,
  CaptureAudioTrack,
  CaptureJob,
  CaptureOptions,
  CaptureResult,
  CaptureScene,
  CaptureSubtitleTrack,
  CaptureTimelineScrollTarget,
  CaptureTimelineSegment,
  CaptureTransition,
  CaptureVideoEncodingSettings,
  FinalVideoEncodingSettings,
  H264Preset,
  IntermediateArtifactProfile,
  MotionCurve,
  OutputFormat,
  PageCaptureResult,
  Viewport,
  Vp9Deadline,
  WaitForCondition,
} from './capture/types.js';
export {
  DEFAULT_DURATION,
  DEFAULT_FPS,
  DEFAULT_MOTION,
  DEFAULT_OUT_FILE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  formatUsage,
  type ParsedCliCommand,
  parseCliArgs,
  parseCommandArgs,
  type RenderCliOptions,
} from './options.js';
export {
  loadRenderProject,
  type ResolvedRenderOutput,
  type ResolvedRenderProject,
} from './project.js';
export {
  buildArtifactMetrics,
  buildCaptureMetrics,
  buildComposedCaptureResult,
  buildProbeWarningEvent,
  buildSceneCaptureArtifact,
  buildSceneClipProbeFailureMessage,
  collectProbeWarnings,
  createRenderPlan,
  type PlannedComposition,
  type PlannedSceneCapture,
  type RenderArtifactMetrics,
  type RenderCaptureMetrics,
  type RenderPlan,
  type SceneCaptureArtifact,
  shouldFailOnSceneClipProbe,
} from './render-plan.js';
export { runCaptureCommand } from './run-capture.js';
export {
  type RenderCommandResult,
  type RenderOutputResult,
  runRenderCommand,
} from './run-render.js';
