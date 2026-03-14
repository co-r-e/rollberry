export type MotionCurve = 'ease-in-out-sine' | 'linear';

export type WaitForCondition =
  | { kind: 'load' }
  | { kind: 'selector'; selector: string }
  | { kind: 'delay'; ms: number };

export interface Viewport {
  width: number;
  height: number;
}

export interface CaptureOptions {
  url: URL;
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
  debugFramesDir?: string;
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

export interface CaptureResult {
  outPath: string;
  frameCount: number;
  durationSeconds: number;
  finalScrollHeight: number;
  truncated: boolean;
}

export interface CaptureRunResult {
  capture: CaptureResult;
  manifestPath: string;
  logFilePath: string;
}

export interface CaptureManifest {
  schemaVersion: 1;
  status: 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  options: {
    url: string;
    viewport: Viewport;
    fps: number;
    duration: number | 'auto';
    motion: MotionCurve;
    timeoutMs: number;
    waitFor: WaitForCondition;
    hideSelectors: string[];
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
