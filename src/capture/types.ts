export type MotionCurve = 'ease-in-out-sine' | 'linear';
export type NonEmptyArray<T> = [T, ...T[]];

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
