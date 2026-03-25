import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { MAX_FPS } from './capture/constants.js';
import type {
  CaptureAction,
  CaptureAudioTrack,
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
  NonEmptyArray,
  OutputFormat,
  ScrollAlignment,
  SubtitleFormat,
  SubtitleMode,
  Viewport,
  Vp9Deadline,
  WaitForCondition,
} from './capture/types.js';
import { parseCaptureUrl, validateHideSelector } from './capture/utils.js';
import {
  CliError,
  DEFAULT_DURATION,
  DEFAULT_FPS,
  DEFAULT_MOTION,
  DEFAULT_OUT_FILE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  deriveSidecarPath,
  parseMotion,
  parseViewport,
  parseWaitFor,
  type RenderCliOptions,
} from './options.js';

const DEFAULT_TIMELINE_ACTION_HOLD_SECONDS = 0.4;
const DEFAULT_INTERMEDIATE_VIDEO_ENCODING: CaptureVideoEncodingSettings = {
  preset: 'slow',
  crf: 18,
};
const DEFAULT_FINAL_MP4_VIDEO_ENCODING: Extract<
  FinalVideoEncodingSettings,
  { format: 'mp4' }
> = {
  format: 'mp4',
  preset: 'slow',
  crf: 18,
};
const DEFAULT_FINAL_WEBM_VIDEO_ENCODING: Extract<
  FinalVideoEncodingSettings,
  { format: 'webm' }
> = {
  format: 'webm',
  deadline: 'good',
  crf: 32,
};

interface ProjectDefaults {
  viewport: Viewport;
  fps: number;
  duration: number | 'auto';
  motion: MotionCurve;
  timeoutMs: number;
  waitFor: WaitForCondition;
  hideSelectors: string[];
  holdAfterSeconds: number;
}

export interface ResolvedRenderOutput {
  name: string;
  outPath: string;
  format: OutputFormat;
  manifestPath: string;
  logFilePath: string;
  viewport: Viewport;
  fps: number;
  force: boolean;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  intermediateArtifact: IntermediateArtifactProfile;
  finalVideo: FinalVideoEncodingSettings;
  debugFramesDir?: string;
}

export interface ResolvedRenderProject {
  projectPath: string;
  projectName: string;
  summaryManifestPath: string;
  timeoutMs: number;
  scenes: NonEmptyArray<CaptureScene>;
  outputs: NonEmptyArray<ResolvedRenderOutput>;
}

export async function loadRenderProject(
  options: RenderCliOptions,
): Promise<ResolvedRenderProject> {
  let rawText: string;

  try {
    rawText = await readFile(options.projectPath, 'utf8');
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? `Failed to read project file: ${error.message}`
        : 'Failed to read project file.',
    );
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(rawText);
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? `Project file is not valid JSON: ${error.message}`
        : 'Project file is not valid JSON.',
    );
  }

  if (!isRecord(rawConfig)) {
    throw new CliError(
      'Project file must contain a JSON object at the top level.',
    );
  }

  const schemaVersion = rawConfig.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    throw new CliError(
      `Unsupported project schemaVersion: ${String(schemaVersion)}`,
    );
  }

  const projectDir = dirname(options.projectPath);
  const projectBaseName = basename(options.projectPath).replace(
    /\.project\.json$/u,
    '',
  );
  const defaults = parseDefaults(rawConfig.defaults);
  const scenes = parseScenes(rawConfig.scenes, defaults);
  const outputs = parseOutputs({
    rawOutputs: rawConfig.outputs,
    defaults,
    projectDir,
    projectBaseName:
      projectBaseName === basename(options.projectPath)
        ? basename(options.projectPath, '.json')
        : projectBaseName,
    force: options.force,
  });

  const selectedOutputs =
    options.outputNames.length === 0
      ? outputs
      : outputs.filter((output) => options.outputNames.includes(output.name));

  if (selectedOutputs.length === 0) {
    throw new CliError(
      `No configured outputs matched --output: ${options.outputNames.join(', ')}`,
    );
  }

  return {
    projectPath: options.projectPath,
    projectName:
      rawConfig.name && typeof rawConfig.name === 'string'
        ? rawConfig.name
        : basename(options.projectPath),
    summaryManifestPath: resolve(
      projectDir,
      readOptionalString(rawConfig, 'summaryManifest') ??
        `${projectBaseName}.render-summary.json`,
    ),
    timeoutMs: defaults.timeoutMs,
    scenes,
    outputs: selectedOutputs as NonEmptyArray<ResolvedRenderOutput>,
  };
}

function parseDefaults(rawDefaults: unknown): ProjectDefaults {
  if (rawDefaults !== undefined && !isRecord(rawDefaults)) {
    throw new CliError('"defaults" must be an object.');
  }

  const defaults = rawDefaults ?? {};
  const viewport = parseViewportField(
    readOptionalString(defaults, 'viewport') ?? DEFAULT_VIEWPORT,
    'defaults.viewport',
  );
  const fps = parseFps(
    readOptionalNumber(defaults, 'fps') ?? DEFAULT_FPS,
    'defaults.fps',
  );
  const duration = parseDurationField(
    defaults,
    'defaults.duration',
    DEFAULT_DURATION,
  );
  const motion = parseMotionField(
    readOptionalString(defaults, 'motion') ?? DEFAULT_MOTION,
    'defaults.motion',
  );
  const timeoutMs = parsePositiveIntField(
    readOptionalNumber(defaults, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS,
    'defaults.timeoutMs',
  );
  const waitFor = parseWaitForField(
    readOptionalString(defaults, 'waitFor') ?? 'load',
    'defaults.waitFor',
  );
  const hideSelectors = parseHideSelectors(
    defaults.hideSelectors,
    'defaults.hideSelectors',
  );
  const holdAfterSeconds = parseNonNegativeField(
    readOptionalNumber(defaults, 'holdAfterSeconds') ?? 0,
    'defaults.holdAfterSeconds',
  );

  return {
    viewport,
    fps,
    duration,
    motion,
    timeoutMs,
    waitFor,
    hideSelectors,
    holdAfterSeconds,
  };
}

function parseScenes(
  rawScenes: unknown,
  defaults: ProjectDefaults,
): NonEmptyArray<CaptureScene> {
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new CliError('"scenes" must be a non-empty array.');
  }

  const scenes = rawScenes.map((rawScene, index) =>
    parseScene(rawScene, defaults, index),
  );

  return scenes as NonEmptyArray<CaptureScene>;
}

function parseScene(
  rawScene: unknown,
  defaults: ProjectDefaults,
  index: number,
): CaptureScene {
  if (!isRecord(rawScene)) {
    throw new CliError(`scenes[${index}] must be an object.`);
  }

  const urlRaw = readRequiredString(rawScene, 'url', `scenes[${index}].url`);
  const url = parseUrlField(urlRaw, `scenes[${index}].url`);
  const sceneHideSelectors = parseHideSelectors(
    rawScene.hideSelectors,
    `scenes[${index}].hideSelectors`,
  );
  const duration = parseDurationField(
    rawScene,
    `scenes[${index}].duration`,
    defaults.duration,
  );
  const motion = parseMotionField(
    readOptionalString(rawScene, 'motion') ?? defaults.motion,
    `scenes[${index}].motion`,
  );
  const rawWaitFor = readOptionalString(rawScene, 'waitFor');
  const waitFor = rawWaitFor
    ? parseWaitForField(rawWaitFor, `scenes[${index}].waitFor`)
    : defaults.waitFor;

  return {
    name: readOptionalString(rawScene, 'name'),
    url,
    duration,
    motion,
    waitFor,
    hideSelectors: dedupeSelectors([
      ...defaults.hideSelectors,
      ...sceneHideSelectors,
    ]),
    holdAfterSeconds: parseNonNegativeField(
      readOptionalNumber(rawScene, 'holdAfterSeconds') ??
        defaults.holdAfterSeconds,
      `scenes[${index}].holdAfterSeconds`,
    ),
    actions: parseActions(rawScene.actions, `scenes[${index}].actions`),
    timeline: parseTimeline(
      rawScene.timeline,
      {
        duration,
        motion,
      },
      `scenes[${index}].timeline`,
    ),
  };
}

function parseOutputs(input: {
  rawOutputs: unknown;
  defaults: ProjectDefaults;
  projectDir: string;
  projectBaseName: string;
  force: boolean;
}): NonEmptyArray<ResolvedRenderOutput> {
  const { rawOutputs, defaults, projectDir, projectBaseName, force } = input;
  if (rawOutputs === undefined) {
    return [
      {
        name: 'default',
        outPath: resolve(projectDir, DEFAULT_OUT_FILE),
        format: 'mp4',
        manifestPath: resolve(
          projectDir,
          deriveSidecarPath(DEFAULT_OUT_FILE, '.manifest.json'),
        ),
        logFilePath: resolve(
          projectDir,
          deriveSidecarPath(DEFAULT_OUT_FILE, '.log.jsonl'),
        ),
        viewport: defaults.viewport,
        fps: defaults.fps,
        intermediateArtifact: buildDefaultIntermediateArtifactProfile(),
        finalVideo: { ...DEFAULT_FINAL_MP4_VIDEO_ENCODING },
        force,
      },
    ];
  }

  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    throw new CliError('"outputs" must be a non-empty array when provided.');
  }

  const outputs = rawOutputs.map((rawOutput, index) =>
    parseOutput({
      rawOutput,
      index,
      defaults,
      projectDir,
      projectBaseName,
      force,
      totalOutputs: rawOutputs.length,
    }),
  );

  const names = new Set<string>();
  for (const output of outputs) {
    if (names.has(output.name)) {
      throw new CliError(
        `Duplicate output name in project file: ${output.name}`,
      );
    }
    names.add(output.name);
  }

  return outputs as NonEmptyArray<ResolvedRenderOutput>;
}

function parseOutput(input: {
  rawOutput: unknown;
  index: number;
  defaults: ProjectDefaults;
  projectDir: string;
  projectBaseName: string;
  force: boolean;
  totalOutputs: number;
}): ResolvedRenderOutput {
  const {
    rawOutput,
    index,
    defaults,
    projectDir,
    projectBaseName,
    force,
    totalOutputs,
  } = input;
  if (!isRecord(rawOutput)) {
    throw new CliError(`outputs[${index}] must be an object.`);
  }

  const name =
    readOptionalString(rawOutput, 'name') ??
    (totalOutputs === 1 ? 'default' : `output-${index + 1}`);
  const configuredOutPath = readOptionalString(rawOutput, 'out');
  const format = parseOutputFormat(
    readOptionalString(rawOutput, 'format'),
    configuredOutPath,
    `outputs[${index}].format`,
  );
  const derivedOutName =
    name === 'default'
      ? `${projectBaseName}.${format}`
      : `${projectBaseName}-${name}.${format}`;
  const outPath = resolve(projectDir, configuredOutPath ?? derivedOutName);
  const manifestPath = resolve(
    projectDir,
    readOptionalString(rawOutput, 'manifest') ??
      deriveSidecarPath(configuredOutPath ?? derivedOutName, '.manifest.json'),
  );
  const logFilePath = resolve(
    projectDir,
    readOptionalString(rawOutput, 'logFile') ??
      deriveSidecarPath(configuredOutPath ?? derivedOutName, '.log.jsonl'),
  );
  const debugFramesDir = readOptionalString(rawOutput, 'debugFramesDir');
  const audio = parseAudioTrack(
    rawOutput.audio,
    projectDir,
    `outputs[${index}].audio`,
  );
  const subtitles = parseSubtitleTrack(
    rawOutput.subtitles,
    projectDir,
    `outputs[${index}].subtitles`,
  );
  const transition = parseTransition(
    rawOutput.transition,
    `outputs[${index}].transition`,
  );
  const intermediateArtifact = parseIntermediateArtifactProfile(
    rawOutput,
    `outputs[${index}]`,
  );
  const finalVideo = parseFinalVideoEncoding(
    rawOutput.finalVideo,
    format,
    `outputs[${index}].finalVideo`,
  );
  const rawViewport = readOptionalString(rawOutput, 'viewport');
  const viewport = rawViewport
    ? parseViewportField(rawViewport, `outputs[${index}].viewport`)
    : defaults.viewport;

  return {
    name,
    outPath,
    format,
    manifestPath,
    logFilePath,
    viewport,
    fps: parseFps(
      readOptionalNumber(rawOutput, 'fps') ?? defaults.fps,
      `outputs[${index}].fps`,
    ),
    debugFramesDir: debugFramesDir
      ? resolve(projectDir, debugFramesDir)
      : undefined,
    audio,
    subtitles,
    transition,
    intermediateArtifact,
    finalVideo,
    force,
  };
}

function parseActions(rawActions: unknown, fieldPath: string): CaptureAction[] {
  if (rawActions === undefined) {
    return [];
  }

  if (!Array.isArray(rawActions)) {
    throw new CliError(`"${fieldPath}" must be an array.`);
  }

  return rawActions.map((rawAction, index) =>
    parseAction(rawAction, `${fieldPath}[${index}]`, {
      allowWait: true,
    }),
  );
}

function parseTimeline(
  rawTimeline: unknown,
  defaults: {
    duration: number | 'auto';
    motion: MotionCurve;
  },
  fieldPath: string,
): CaptureTimelineSegment[] {
  if (rawTimeline === undefined) {
    return [];
  }

  if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) {
    throw new CliError(`"${fieldPath}" must be a non-empty array.`);
  }

  return rawTimeline.map((rawStep, index) =>
    parseTimelineSegment(rawStep, defaults, `${fieldPath}[${index}]`),
  );
}

function parseTimelineSegment(
  rawStep: unknown,
  defaults: {
    duration: number | 'auto';
    motion: MotionCurve;
  },
  fieldPath: string,
): CaptureTimelineSegment {
  if (!isRecord(rawStep)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  const type = readRequiredString(rawStep, 'type', `${fieldPath}.type`);

  if (type === 'pause') {
    return {
      kind: 'pause',
      durationSeconds: parsePositiveNumberField(
        readRequiredNumber(rawStep, 'duration', `${fieldPath}.duration`),
        `${fieldPath}.duration`,
      ),
    };
  }

  if (type === 'wait') {
    return {
      kind: 'pause',
      durationSeconds:
        parsePositiveIntField(
          readRequiredNumber(rawStep, 'ms', `${fieldPath}.ms`),
          `${fieldPath}.ms`,
        ) / 1000,
    };
  }

  if (type === 'scroll') {
    return {
      kind: 'scroll',
      duration: parseDurationField(
        rawStep,
        `${fieldPath}.duration`,
        defaults.duration,
      ),
      motion: parseMotionField(
        readOptionalString(rawStep, 'motion') ?? defaults.motion,
        `${fieldPath}.motion`,
      ),
      target: parseTimelineScrollTarget(rawStep, fieldPath),
    };
  }

  const action = parseAction(rawStep, fieldPath, {
    allowWait: false,
  });

  if (action.kind === 'wait') {
    throw new CliError(
      `"${fieldPath}.type" cannot use "wait" here. Use "pause" or "ms".`,
    );
  }

  return {
    kind: 'action',
    action,
    holdAfterSeconds: parseNonNegativeField(
      readOptionalNumber(rawStep, 'holdAfterSeconds') ??
        DEFAULT_TIMELINE_ACTION_HOLD_SECONDS,
      `${fieldPath}.holdAfterSeconds`,
    ),
  };
}

function parseTimelineScrollTarget(
  rawStep: Record<string, unknown>,
  fieldPath: string,
): CaptureTimelineScrollTarget {
  const hasTo = Object.hasOwn(rawStep, 'to');
  const hasBy = Object.hasOwn(rawStep, 'by');
  const hasToSelector = Object.hasOwn(rawStep, 'toSelector');
  const targetCount = Number(hasTo) + Number(hasBy) + Number(hasToSelector);

  if (targetCount !== 1) {
    throw new CliError(
      `"${fieldPath}" must define exactly one of "to", "by", or "toSelector".`,
    );
  }

  if (hasTo) {
    const to = rawStep.to;
    if (to === 'bottom') {
      return { kind: 'bottom' };
    }

    if (typeof to !== 'number') {
      throw new CliError(`"${fieldPath}.to" must be a number or "bottom".`);
    }

    return {
      kind: 'absolute',
      top: parseNonNegativeField(to, `${fieldPath}.to`),
    };
  }

  if (hasBy) {
    const by = rawStep.by;
    if (typeof by !== 'number' || !Number.isFinite(by)) {
      throw new CliError(`"${fieldPath}.by" must be a number.`);
    }

    return {
      kind: 'relative',
      delta: by,
    };
  }

  return {
    kind: 'selector',
    selector: readRequiredString(
      rawStep,
      'toSelector',
      `${fieldPath}.toSelector`,
    ),
    block: parseScrollAlignment(
      readOptionalString(rawStep, 'block') ?? 'center',
      `${fieldPath}.block`,
    ),
  };
}

function parseAction(
  rawAction: unknown,
  fieldPath: string,
  options: {
    allowWait: boolean;
  },
): CaptureAction {
  if (!isRecord(rawAction)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  const type = readRequiredString(rawAction, 'type', `${fieldPath}.type`);

  switch (type) {
    case 'wait':
      if (!options.allowWait) {
        throw new CliError(
          `Unsupported action type at ${fieldPath}.type: ${type}`,
        );
      }
      return {
        kind: 'wait',
        ms: parsePositiveIntField(
          readRequiredNumber(rawAction, 'ms', `${fieldPath}.ms`),
          `${fieldPath}.ms`,
        ),
      };

    case 'click':
      return {
        kind: 'click',
        selector: readRequiredString(
          rawAction,
          'selector',
          `${fieldPath}.selector`,
        ),
      };

    case 'hover':
      return {
        kind: 'hover',
        selector: readRequiredString(
          rawAction,
          'selector',
          `${fieldPath}.selector`,
        ),
      };

    case 'press':
      return {
        kind: 'press',
        key: readRequiredString(rawAction, 'key', `${fieldPath}.key`),
      };

    case 'type':
      return {
        kind: 'type',
        selector: readRequiredString(
          rawAction,
          'selector',
          `${fieldPath}.selector`,
        ),
        text: readRequiredString(rawAction, 'text', `${fieldPath}.text`),
        clear: typeof rawAction.clear === 'boolean' ? rawAction.clear : true,
      };

    case 'scroll-to':
      return {
        kind: 'scroll-to',
        selector: readRequiredString(
          rawAction,
          'selector',
          `${fieldPath}.selector`,
        ),
        block: parseScrollAlignment(
          readOptionalString(rawAction, 'block') ?? 'center',
          `${fieldPath}.block`,
        ),
      };

    default:
      throw new CliError(
        `Unsupported action type at ${fieldPath}.type: ${type}`,
      );
  }
}

function parseViewportField(rawValue: string, fieldPath: string): Viewport {
  try {
    return parseViewport(rawValue);
  } catch (error) {
    throw new CliError(
      `${fieldPath} is invalid: ${error instanceof Error ? error.message : 'invalid viewport'}`,
    );
  }
}

function parseDurationField(
  rawObject: Record<string, unknown>,
  fieldPath: string,
  fallback: number | 'auto',
): number | 'auto' {
  if (!Object.hasOwn(rawObject, 'duration')) {
    return fallback;
  }

  const value = rawObject.duration;
  if (value === 'auto') {
    return 'auto';
  }

  if (typeof value !== 'number') {
    throw new CliError(`"${fieldPath}" must be "auto" or a positive number.`);
  }

  return parsePositiveNumberField(value, fieldPath);
}

function parseMotionField(rawValue: string, fieldPath: string): MotionCurve {
  try {
    return parseMotion(rawValue);
  } catch (error) {
    throw new CliError(
      `${fieldPath} is invalid: ${error instanceof Error ? error.message : 'invalid motion'}`,
    );
  }
}

function parseWaitForField(
  rawValue: string,
  fieldPath: string,
): WaitForCondition {
  try {
    return parseWaitFor(rawValue);
  } catch (error) {
    throw new CliError(
      `${fieldPath} is invalid: ${error instanceof Error ? error.message : 'invalid waitFor'}`,
    );
  }
}

function parseUrlField(rawValue: string, fieldPath: string): URL {
  try {
    return parseCaptureUrl(rawValue);
  } catch (error) {
    throw new CliError(
      `${fieldPath} is invalid: ${error instanceof Error ? error.message : 'invalid URL'}`,
    );
  }
}

function parseHideSelectors(rawValue: unknown, fieldPath: string): string[] {
  if (rawValue === undefined) {
    return [];
  }

  if (!Array.isArray(rawValue)) {
    throw new CliError(`"${fieldPath}" must be an array of CSS selectors.`);
  }

  return rawValue.map((value, index) => {
    if (typeof value !== 'string') {
      throw new CliError(`"${fieldPath}[${index}]" must be a string.`);
    }

    try {
      validateHideSelector(value);
    } catch (error) {
      throw new CliError(
        `${fieldPath}[${index}] is invalid: ${error instanceof Error ? error.message : 'invalid selector'}`,
      );
    }

    return value;
  });
}

function parsePositiveIntField(value: number, fieldPath: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(
      `${fieldPath} is invalid: Expected a positive integer (e.g. "60"): ${value}`,
    );
  }
  return value;
}

function parsePositiveNumberField(value: number, fieldPath: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(
      `${fieldPath} is invalid: Expected a positive number (e.g. "5.0"): ${value}`,
    );
  }
  return value;
}

function parseNonNegativeField(value: number, fieldPath: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError(
      `${fieldPath} is invalid: Expected a non-negative number (e.g. "0" or "1.5"): ${value}`,
    );
  }
  return value;
}

function parseFps(value: number, fieldPath: string): number {
  const fps = parsePositiveIntField(value, fieldPath);
  if (fps > MAX_FPS) {
    throw new CliError(`${fieldPath} must be at most ${MAX_FPS}.`);
  }

  return fps;
}

function parseOutputFormat(
  rawFormat: string | undefined,
  configuredOutPath: string | undefined,
  fieldPath: string,
): OutputFormat {
  const inferredFormat = configuredOutPath
    ? inferOutputFormatFromPath(configuredOutPath)
    : undefined;
  const format = rawFormat ?? inferredFormat ?? 'mp4';

  if (format === 'mp4' || format === 'webm') {
    return format;
  }

  throw new CliError(`${fieldPath} must be "mp4" or "webm".`);
}

function inferOutputFormatFromPath(path: string): OutputFormat | undefined {
  if (path.endsWith('.webm')) {
    return 'webm';
  }

  if (path.endsWith('.mp4')) {
    return 'mp4';
  }

  return undefined;
}

function parseAudioTrack(
  rawAudio: unknown,
  projectDir: string,
  fieldPath: string,
): CaptureAudioTrack | undefined {
  if (rawAudio === undefined) {
    return undefined;
  }

  if (!isRecord(rawAudio)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  return {
    sourcePath: resolve(
      projectDir,
      readRequiredString(rawAudio, 'path', `${fieldPath}.path`),
    ),
    volume: parseNonNegativeField(
      readOptionalNumber(rawAudio, 'volume') ?? 1,
      `${fieldPath}.volume`,
    ),
    loop: typeof rawAudio.loop === 'boolean' ? rawAudio.loop : true,
  };
}

function parseSubtitleTrack(
  rawSubtitles: unknown,
  projectDir: string,
  fieldPath: string,
): CaptureSubtitleTrack | undefined {
  if (rawSubtitles === undefined) {
    return undefined;
  }

  if (!isRecord(rawSubtitles)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  const sourcePath = resolve(
    projectDir,
    readRequiredString(rawSubtitles, 'path', `${fieldPath}.path`),
  );

  return {
    sourcePath,
    format: parseSubtitleFormat(sourcePath, `${fieldPath}.path`),
    mode: parseSubtitleMode(
      readOptionalString(rawSubtitles, 'mode') ?? 'soft',
      `${fieldPath}.mode`,
    ),
  };
}

function parseTransition(
  rawTransition: unknown,
  fieldPath: string,
): CaptureTransition | undefined {
  if (rawTransition === undefined) {
    return undefined;
  }

  if (!isRecord(rawTransition)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  const type = readRequiredString(rawTransition, 'type', `${fieldPath}.type`);
  if (type !== 'fade-in' && type !== 'crossfade') {
    throw new CliError(`${fieldPath}.type must be "fade-in" or "crossfade".`);
  }

  return {
    kind: type,
    durationSeconds: parsePositiveNumberField(
      readRequiredNumber(rawTransition, 'duration', `${fieldPath}.duration`),
      `${fieldPath}.duration`,
    ),
  };
}

function parseIntermediateVideoEncoding(
  rawIntermediateVideo: unknown,
  fieldPath: string,
): CaptureVideoEncodingSettings {
  if (rawIntermediateVideo === undefined) {
    return { ...DEFAULT_INTERMEDIATE_VIDEO_ENCODING };
  }

  if (!isRecord(rawIntermediateVideo)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  return {
    preset: parseH264Preset(
      readOptionalString(rawIntermediateVideo, 'preset') ??
        DEFAULT_INTERMEDIATE_VIDEO_ENCODING.preset,
      `${fieldPath}.preset`,
    ),
    crf: parseH264Crf(
      readOptionalNumber(rawIntermediateVideo, 'crf') ??
        DEFAULT_INTERMEDIATE_VIDEO_ENCODING.crf,
      `${fieldPath}.crf`,
    ),
  };
}

function parseIntermediateArtifactProfile(
  rawOutput: Record<string, unknown>,
  fieldPath: string,
): IntermediateArtifactProfile {
  if (
    Object.hasOwn(rawOutput, 'intermediateArtifact') &&
    Object.hasOwn(rawOutput, 'intermediateVideo')
  ) {
    throw new CliError(
      `${fieldPath} cannot define both "intermediateArtifact" and "intermediateVideo".`,
    );
  }

  const rawIntermediateArtifact = rawOutput.intermediateArtifact;
  if (rawIntermediateArtifact === undefined) {
    return {
      format: 'mp4',
      extension: '.mp4',
      videoEncoding: parseIntermediateVideoEncoding(
        rawOutput.intermediateVideo,
        `${fieldPath}.intermediateVideo`,
      ),
    };
  }

  if (!isRecord(rawIntermediateArtifact)) {
    throw new CliError(
      `"${fieldPath}.intermediateArtifact" must be an object.`,
    );
  }

  const format = readOptionalString(rawIntermediateArtifact, 'format') ?? 'mp4';
  if (format !== 'mp4') {
    throw new CliError(
      `${fieldPath}.intermediateArtifact.format must currently be "mp4".`,
    );
  }

  return {
    format: 'mp4',
    extension: '.mp4',
    videoEncoding: parseIntermediateVideoEncoding(
      rawIntermediateArtifact,
      `${fieldPath}.intermediateArtifact`,
    ),
  };
}

function parseFinalVideoEncoding(
  rawFinalVideo: unknown,
  format: OutputFormat,
  fieldPath: string,
): FinalVideoEncodingSettings {
  if (rawFinalVideo === undefined) {
    return format === 'mp4'
      ? { ...DEFAULT_FINAL_MP4_VIDEO_ENCODING }
      : { ...DEFAULT_FINAL_WEBM_VIDEO_ENCODING };
  }

  if (!isRecord(rawFinalVideo)) {
    throw new CliError(`"${fieldPath}" must be an object.`);
  }

  if (format === 'mp4') {
    if (Object.hasOwn(rawFinalVideo, 'deadline')) {
      throw new CliError(
        `${fieldPath}.deadline is only supported for "webm" outputs.`,
      );
    }

    return {
      format: 'mp4',
      preset: parseH264Preset(
        readOptionalString(rawFinalVideo, 'preset') ??
          DEFAULT_FINAL_MP4_VIDEO_ENCODING.preset,
        `${fieldPath}.preset`,
      ),
      crf: parseH264Crf(
        readOptionalNumber(rawFinalVideo, 'crf') ??
          DEFAULT_FINAL_MP4_VIDEO_ENCODING.crf,
        `${fieldPath}.crf`,
      ),
    };
  }

  if (Object.hasOwn(rawFinalVideo, 'preset')) {
    throw new CliError(
      `${fieldPath}.preset is only supported for "mp4" outputs.`,
    );
  }

  return {
    format: 'webm',
    deadline: parseVp9Deadline(
      readOptionalString(rawFinalVideo, 'deadline') ??
        DEFAULT_FINAL_WEBM_VIDEO_ENCODING.deadline,
      `${fieldPath}.deadline`,
    ),
    crf: parseVp9Crf(
      readOptionalNumber(rawFinalVideo, 'crf') ??
        DEFAULT_FINAL_WEBM_VIDEO_ENCODING.crf,
      `${fieldPath}.crf`,
    ),
  };
}

function parseSubtitleFormat(
  sourcePath: string,
  fieldPath: string,
): SubtitleFormat {
  const normalizedPath = sourcePath.toLowerCase();

  if (normalizedPath.endsWith('.srt')) {
    return 'srt';
  }

  if (normalizedPath.endsWith('.vtt') || normalizedPath.endsWith('.webvtt')) {
    return 'webvtt';
  }

  throw new CliError(
    `${fieldPath} must point to a .srt, .vtt, or .webvtt subtitle file.`,
  );
}

function parseSubtitleMode(value: string, fieldPath: string): SubtitleMode {
  if (value === 'soft' || value === 'burn-in') {
    return value;
  }

  throw new CliError(`${fieldPath} must be "soft" or "burn-in".`);
}

function parseH264Preset(value: string, fieldPath: string): H264Preset {
  switch (value) {
    case 'ultrafast':
    case 'superfast':
    case 'veryfast':
    case 'faster':
    case 'fast':
    case 'medium':
    case 'slow':
    case 'slower':
    case 'veryslow':
    case 'placebo':
      return value;
    default:
      throw new CliError(
        `${fieldPath} must be one of: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow, placebo.`,
      );
  }
}

function parseH264Crf(value: number, fieldPath: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CliError(`${fieldPath} must be an integer between 0 and 51.`);
  }

  if (value < 0 || value > 51) {
    throw new CliError(`${fieldPath} must be between 0 and 51.`);
  }

  return value;
}

function parseVp9Deadline(value: string, fieldPath: string): Vp9Deadline {
  if (value === 'best' || value === 'good' || value === 'realtime') {
    return value;
  }

  throw new CliError(`${fieldPath} must be one of: best, good, realtime.`);
}

function parseVp9Crf(value: number, fieldPath: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CliError(`${fieldPath} must be an integer between 0 and 63.`);
  }

  if (value < 0 || value > 63) {
    throw new CliError(`${fieldPath} must be between 0 and 63.`);
  }

  return value;
}

function buildDefaultIntermediateArtifactProfile(): IntermediateArtifactProfile {
  return {
    format: 'mp4',
    extension: '.mp4',
    videoEncoding: { ...DEFAULT_INTERMEDIATE_VIDEO_ENCODING },
  };
}

function parseScrollAlignment(
  value: string,
  fieldPath: string,
): ScrollAlignment {
  if (value === 'start' || value === 'center' || value === 'end') {
    return value;
  }

  throw new CliError(`${fieldPath} must be one of: start, center, end.`);
}

function dedupeSelectors(selectors: string[]): string[] {
  return [...new Set(selectors)];
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }

  if (typeof candidate !== 'string') {
    throw new CliError(`"${key}" must be a string.`);
  }

  return candidate;
}

function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }

  if (typeof candidate !== 'number') {
    throw new CliError(`"${key}" must be a number.`);
  }

  return candidate;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  fieldPath: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new CliError(`"${fieldPath}" must be a non-empty string.`);
  }

  return candidate;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
  fieldPath: string,
): number {
  const candidate = value[key];
  if (typeof candidate !== 'number') {
    throw new CliError(`"${fieldPath}" must be a number.`);
  }

  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
