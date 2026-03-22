export type MotionCurve = 'ease-in-out-sine' | 'linear';
export type NonEmptyArray<T> = [T, ...T[]];
export type ScrollAlignment = 'start' | 'center' | 'end';
export type OutputFormat = 'mp4' | 'webm';
export type SubtitleFormat = 'srt' | 'webvtt';
export type SubtitleMode = 'soft' | 'burn-in';
export type H264Preset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'
  | 'placebo';
export type Vp9Deadline = 'best' | 'good' | 'realtime';

export type WaitForCondition =
  | { kind: 'load' }
  | { kind: 'selector'; selector: string }
  | { kind: 'delay'; ms: number };

export interface Viewport {
  width: number;
  height: number;
}

export interface CaptureOptions {
  urls: NonEmptyArray<URL>;
  outPath: string;
  manifestPath: string;
  logFilePath: string;
  viewport: Viewport;
  fps: number;
  duration: number | 'auto';
  motion: MotionCurve;
  timeoutMs: number;
  waitFor: WaitForCondition;
  hideSelectors: string[];
  pageGapSeconds: number;
  debugFramesDir?: string;
  force: boolean;
}

export type CaptureAction =
  | { kind: 'wait'; ms: number }
  | { kind: 'click'; selector: string }
  | { kind: 'hover'; selector: string }
  | { kind: 'press'; key: string }
  | { kind: 'type'; selector: string; text: string; clear: boolean }
  | { kind: 'scroll-to'; selector: string; block: ScrollAlignment };

export type CaptureTimelineScrollTarget =
  | { kind: 'bottom' }
  | { kind: 'absolute'; top: number }
  | { kind: 'relative'; delta: number }
  | { kind: 'selector'; selector: string; block: ScrollAlignment };

export type CaptureTimelineSegment =
  | {
      kind: 'scroll';
      duration: number | 'auto';
      motion: MotionCurve;
      target: CaptureTimelineScrollTarget;
    }
  | {
      kind: 'pause';
      durationSeconds: number;
    }
  | {
      kind: 'action';
      action: Exclude<CaptureAction, { kind: 'wait' }>;
      holdAfterSeconds: number;
    };

export interface CaptureScene {
  name?: string;
  url: URL;
  duration: number | 'auto';
  motion: MotionCurve;
  waitFor: WaitForCondition;
  hideSelectors: string[];
  holdAfterSeconds: number;
  actions: CaptureAction[];
  timeline: CaptureTimelineSegment[];
}

export interface CaptureJob {
  scenes: NonEmptyArray<CaptureScene>;
  outPath: string;
  format: OutputFormat;
  viewport: Viewport;
  fps: number;
  timeoutMs: number;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  videoEncoding?: CaptureVideoEncodingSettings;
  debugFramesDir?: string;
  includeHoldAfterFinalScene?: boolean;
  force: boolean;
}

export interface CaptureVideoEncodingSettings {
  preset: H264Preset;
  crf: number;
}

export interface IntermediateArtifactProfile {
  format: 'mp4';
  extension: '.mp4';
  videoEncoding: CaptureVideoEncodingSettings;
}

export interface CaptureAudioTrack {
  sourcePath: string;
  volume: number;
  loop: boolean;
}

export interface CaptureSubtitleTrack {
  sourcePath: string;
  format: SubtitleFormat;
  mode: SubtitleMode;
}

export type CaptureTransition =
  | {
      kind: 'fade-in';
      durationSeconds: number;
    }
  | {
      kind: 'crossfade';
      durationSeconds: number;
    };

export type FinalVideoEncodingSettings =
  | {
      format: 'mp4';
      preset: H264Preset;
      crf: number;
    }
  | {
      format: 'webm';
      deadline: Vp9Deadline;
      crf: number;
    };

export interface ResolvedCaptureOptions extends CaptureOptions {
  durationSeconds: number;
}

export interface PageMetrics {
  scrollHeight: number;
  viewportHeight: number;
  maxScroll: number;
}

export interface PreflightResult extends PageMetrics {
  truncated: boolean;
}

export interface PageCaptureResult {
  name?: string;
  url: string;
  frameCount: number;
  durationSeconds: number;
  scrollHeight: number;
  truncated: boolean;
}

export interface CaptureResult {
  outPath: string;
  frameCount: number;
  durationSeconds: number;
  pages: PageCaptureResult[];
  truncated: boolean;
}

export interface CaptureRunResult {
  capture: CaptureResult;
  manifestPath: string;
  logFilePath: string;
}

export interface CaptureManifest {
  schemaVersion: 2;
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  options: {
    urls: string[];
    viewport: Viewport;
    fps: number;
    duration: number | 'auto';
    motion: MotionCurve;
    timeoutMs: number;
    waitFor: WaitForCondition;
    hideSelectors: string[];
    pageGapSeconds: number;
  };
  artifacts: {
    videoPath: string;
    manifestPath: string;
    logFilePath: string;
    debugFramesDir?: string;
    videoCreated: boolean;
  };
  result?: CaptureResult;
  warnings: string[];
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}
