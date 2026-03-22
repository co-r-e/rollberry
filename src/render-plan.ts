import { join } from 'node:path';

import type { VideoProbeOutcome } from './capture/ffmpeg.js';
import type {
  CaptureJob,
  CaptureResult,
  CaptureScene,
  FinalVideoEncodingSettings,
  IntermediateArtifactProfile,
  NonEmptyArray,
  PageCaptureResult,
} from './capture/types.js';
import type { ResolvedRenderOutput } from './project.js';

export interface PlannedSceneCapture {
  sceneIndex: number;
  scene: CaptureScene;
  clipPath: string;
  debugFramesDir?: string;
  job: CaptureJob;
}

export interface PlannedComposition {
  outPath: string;
  format: ResolvedRenderOutput['format'];
  fps: number;
  audio: ResolvedRenderOutput['audio'];
  subtitles: ResolvedRenderOutput['subtitles'];
  transition: ResolvedRenderOutput['transition'];
  finalVideo: FinalVideoEncodingSettings;
  force: boolean;
}

export interface CompositionCapabilities {
  requiresPreciseClipTiming: boolean;
  timingRequirementSources: string[];
}

export interface RenderPlan {
  output: ResolvedRenderOutput;
  tempDir: string;
  sceneCaptures: NonEmptyArray<PlannedSceneCapture>;
  composition: PlannedComposition;
  capabilities: CompositionCapabilities;
}

export interface SceneCaptureArtifact {
  captureMetrics: CaptureResult;
  clip: {
    path: string;
    durationSeconds: number;
    frameCount?: number;
  };
  probe: VideoProbeOutcome;
}

export interface RenderCaptureMetrics {
  frameCount: number;
  durationSeconds: number;
  truncated: boolean;
  scenes: PageCaptureResult[];
}

export interface RenderArtifactMetrics {
  videoPath: string;
  frameCount: number;
  durationSeconds: number;
  truncated: boolean;
  probe: {
    status: VideoProbeOutcome['status'];
    source: 'ffprobe' | 'estimate';
    warning?: string;
  };
}

export function createRenderPlan(input: {
  output: ResolvedRenderOutput;
  scenes: NonEmptyArray<CaptureScene>;
  timeoutMs: number;
  tempDir: string;
}): RenderPlan {
  const { output, scenes, timeoutMs, tempDir } = input;
  const sceneCaptures = scenes.map((scene, sceneIndex) => {
    const clipPath = join(
      tempDir,
      `scene-${String(sceneIndex + 1).padStart(3, '0')}${output.intermediateArtifact.extension}`,
    );
    const debugFramesDir = output.debugFramesDir
      ? join(
          output.debugFramesDir,
          `scene-${String(sceneIndex + 1).padStart(3, '0')}`,
        )
      : undefined;

    return {
      sceneIndex,
      scene,
      clipPath,
      debugFramesDir,
      job: {
        scenes: [scene],
        outPath: clipPath,
        format: output.intermediateArtifact.format,
        viewport: output.viewport,
        fps: output.fps,
        timeoutMs,
        debugFramesDir,
        videoEncoding: output.intermediateArtifact.videoEncoding,
        includeHoldAfterFinalScene: sceneIndex < scenes.length - 1,
        force: true,
      },
    };
  }) as unknown as NonEmptyArray<PlannedSceneCapture>;

  return {
    output,
    tempDir,
    sceneCaptures,
    composition: {
      outPath: output.outPath,
      format: output.format,
      fps: output.fps,
      audio: output.audio,
      subtitles: output.subtitles,
      transition: output.transition,
      finalVideo: output.finalVideo,
      force: output.force,
    },
    capabilities: resolveCompositionCapabilities({
      transition: output.transition,
      intermediateArtifact: output.intermediateArtifact,
    }),
  };
}

export function buildSceneCaptureArtifact(input: {
  rawCapture: CaptureResult;
  clipPath: string;
  probe: VideoProbeOutcome;
}): SceneCaptureArtifact {
  const durationSeconds =
    input.probe.result?.durationSeconds ?? input.rawCapture.durationSeconds;
  const frameCount =
    input.probe.result?.frameCount ?? input.rawCapture.frameCount;

  return {
    captureMetrics: input.rawCapture,
    clip: {
      path: input.clipPath,
      durationSeconds,
      frameCount,
    },
    probe: input.probe,
  };
}

export function buildCaptureMetrics(
  sceneArtifacts: SceneCaptureArtifact[],
): RenderCaptureMetrics {
  return {
    frameCount: sceneArtifacts.reduce(
      (sum, artifact) => sum + artifact.captureMetrics.frameCount,
      0,
    ),
    durationSeconds: sceneArtifacts.reduce(
      (sum, artifact) => sum + artifact.captureMetrics.durationSeconds,
      0,
    ),
    truncated: sceneArtifacts.some(
      (artifact) => artifact.captureMetrics.truncated,
    ),
    scenes: sceneArtifacts.flatMap((artifact) => artifact.captureMetrics.pages),
  };
}

export function buildArtifactMetrics(input: {
  captureResult: CaptureResult;
  probe: VideoProbeOutcome;
}): RenderArtifactMetrics {
  return {
    videoPath: input.captureResult.outPath,
    frameCount: input.captureResult.frameCount,
    durationSeconds: input.captureResult.durationSeconds,
    truncated: input.captureResult.truncated,
    probe: {
      status: input.probe.status,
      source: input.probe.status === 'probed' ? 'ffprobe' : 'estimate',
      warning: input.probe.warning,
    },
  };
}

export function collectProbeWarnings(
  sceneArtifacts: SceneCaptureArtifact[],
  finalProbe: VideoProbeOutcome,
): string[] {
  const warnings = new Set<string>();

  for (const artifact of sceneArtifacts) {
    if (artifact.probe.status !== 'probed') {
      warnings.add(`scene_clip_probe_${artifact.probe.status}`);
    }
  }

  if (finalProbe.status !== 'probed') {
    warnings.add(`output_probe_${finalProbe.status}`);
  }

  return [...warnings];
}

export function shouldFailOnSceneClipProbe(input: {
  probe: VideoProbeOutcome;
  capabilities: CompositionCapabilities;
}): boolean {
  return (
    input.probe.status !== 'probed' &&
    input.capabilities.requiresPreciseClipTiming
  );
}

export function buildSceneClipProbeFailureMessage(input: {
  sceneIndex: number;
  probe: VideoProbeOutcome;
  capabilities: CompositionCapabilities;
}): string {
  return `Scene clip probe failed for scene ${input.sceneIndex + 1} (${input.probe.status}). Precise clip timing is required by: ${input.capabilities.timingRequirementSources.join(', ')}. ${input.probe.warning ?? ''}`.trim();
}

export function buildProbeWarningEvent(input: {
  target: 'scene-clip' | 'output';
  index?: number;
  probe: VideoProbeOutcome;
}): {
  event: string;
  message: string;
  metadata: Record<string, unknown>;
} | null {
  if (input.probe.status === 'probed') {
    return null;
  }

  return {
    event: 'probe.warning',
    message:
      input.target === 'scene-clip'
        ? 'Scene clip probe warning'
        : 'Output probe warning',
    metadata: {
      target: input.target,
      index: input.index,
      status: input.probe.status,
      warning: input.probe.warning,
    },
  };
}

export function resolveCompositionCapabilities(input: {
  transition?: ResolvedRenderOutput['transition'];
  intermediateArtifact: IntermediateArtifactProfile;
}): CompositionCapabilities {
  const timingRequirementSources: string[] = [];

  if (input.transition?.kind === 'crossfade') {
    timingRequirementSources.push('transition:crossfade');
  }

  return {
    requiresPreciseClipTiming: timingRequirementSources.length > 0,
    timingRequirementSources,
  };
}

export function buildComposedCaptureResult(input: {
  outPath: string;
  fps: number;
  sceneArtifacts: SceneCaptureArtifact[];
  transition?: ResolvedRenderOutput['transition'];
  probe: VideoProbeOutcome;
}): CaptureResult {
  const pages = input.sceneArtifacts.flatMap(
    (artifact) => artifact.captureMetrics.pages,
  );
  const totalClipDurationSeconds = input.sceneArtifacts.reduce(
    (sum, artifact) => sum + artifact.clip.durationSeconds,
    0,
  );
  const transitionOverlapSeconds =
    input.transition?.kind === 'crossfade'
      ? input.transition.durationSeconds * Math.max(0, pages.length - 1)
      : 0;
  const estimatedDurationSeconds = Math.max(
    0,
    totalClipDurationSeconds - transitionOverlapSeconds,
  );
  const durationSeconds =
    input.probe.result?.durationSeconds ?? estimatedDurationSeconds;

  return {
    outPath: input.outPath,
    frameCount:
      input.probe.result?.frameCount ??
      Math.max(1, Math.round(durationSeconds * input.fps)),
    durationSeconds,
    pages,
    truncated: input.sceneArtifacts.some(
      (artifact) => artifact.captureMetrics.truncated,
    ),
  };
}
