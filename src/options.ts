import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MAX_FPS } from './capture/constants.js';
import type {
  CaptureOptions,
  MotionCurve,
  NonEmptyArray,
  WaitForCondition,
} from './capture/types.js';
import { parseCaptureUrl, validateHideSelector } from './capture/utils.js';
import { VERSION } from './version.js';

export const DEFAULT_OUT_FILE = 'rollberry.mp4';
export const DEFAULT_VIEWPORT = '1440x900';
export const DEFAULT_FPS = 60;
export const DEFAULT_DURATION = 'auto';
export const DEFAULT_MOTION: MotionCurve = 'ease-in-out-sine';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RenderCliOptions {
  projectPath: string;
  outputNames: string[];
  force: boolean;
}

export type ParsedCliCommand =
  | { kind: 'capture'; options: CaptureOptions }
  | { kind: 'render'; options: RenderCliOptions };

export class CliError extends Error {
  constructor(
    message: string,
    readonly showUsage = false,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class HelpRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelpRequest';
  }
}

export class VersionRequest extends Error {
  readonly version = VERSION;
  constructor() {
    super(VERSION);
    this.name = 'VersionRequest';
  }
}

export function parseCommandArgs(
  argv = process.argv.slice(2),
): ParsedCliCommand {
  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h') {
    throw new HelpRequest(formatUsage());
  }

  if (command === '--version' || command === '-V') {
    throw new VersionRequest();
  }

  if (!command) {
    throw createMissingSubcommandError();
  }

  switch (command) {
    case 'capture':
      return { kind: 'capture', options: parseCaptureArgs(rest) };
    case 'render':
      return { kind: 'render', options: parseRenderArgs(rest) };
    default:
      throw createUnknownSubcommandError(command);
  }
}

export function parseCliArgs(argv = process.argv.slice(2)): CaptureOptions {
  const args = argv[0] === 'capture' ? argv.slice(1) : argv;
  return parseCaptureArgs(args);
}

export function formatUsage(): string {
  return [
    `rollberry v${VERSION} — Capture and render web pages into video`,
    '',
    'Usage:',
    '  rollberry capture <url...> [options]',
    '  rollberry render <project.json> [options]',
    '  rollberry --help | -h',
    '  rollberry --version | -V',
    '',
    'Capture Options:',
    '  --out <file>                Output MP4 path (default: ~/Downloads/rollberry.mp4)',
    '  --viewport <WxH>           Viewport size (default: 1440x900)',
    `  --fps <n>                  Frames per second (default: 60, max: ${MAX_FPS})`,
    '  --duration <seconds|auto>  Capture duration (default: auto)',
    '  --motion <curve>           ease-in-out-sine | linear (default: ease-in-out-sine)',
    '  --timeout <ms>             Navigation timeout (default: 30000)',
    '  --wait-for <mode>          load | selector:<css> | ms:<n> (default: load)',
    '  --hide-selector <css>      Hide CSS selector before capture (repeatable)',
    '  --force                    Overwrite output file if it already exists',
    '  --debug-frames-dir <dir>   Save raw PNG frames for debugging',
    '  --page-gap <seconds>       Pause between pages (default: 0)',
    '  --manifest <file>          Manifest JSON path (default: <out>.manifest.json)',
    '  --log-file <file>          Log JSONL path (default: <out>.log.jsonl)',
    '',
    'Render Options:',
    '  --output <name>            Render only the named output (repeatable)',
    '  --force                    Overwrite configured output files',
    '',
    'Examples:',
    '  rollberry capture http://localhost:3000',
    '  rollberry capture https://example.com --out demo.mp4 --viewport 1920x1080',
    '  rollberry render ./rollberry.project.json --output mobile',
  ].join('\n');
}

export function parseWithCliError<T>(
  rawValue: string,
  parser: (value: string) => T,
): T {
  try {
    return parser(rawValue);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw new CliError(
      error instanceof Error ? error.message : 'Failed to parse arguments.',
    );
  }
}

export function resolveOutPath(path: string): string {
  return resolve(process.cwd(), path);
}

export function resolveDefaultOutPath(filename: string): string {
  return resolve(homedir(), 'Downloads', filename);
}

export function deriveSidecarPath(path: string, suffix: string): string {
  const extension = /\.([^.]+)$/u.exec(path);
  if (!extension) {
    return `${path}${suffix}`;
  }

  return path.slice(0, -extension[0].length) + suffix;
}

export function parseViewport(rawViewport: string): CaptureOptions['viewport'] {
  const match = /^(?<width>\d+)x(?<height>\d+)$/u.exec(rawViewport);

  if (!match?.groups) {
    throw new Error(
      `--viewport must be in "WxH" format (e.g. "1440x900"): ${rawViewport}`,
    );
  }

  const width = Number(match.groups.width);
  const height = Number(match.groups.height);

  if (width <= 0 || height <= 0) {
    throw new Error(
      `--viewport dimensions must be positive (e.g. "1440x900"): ${rawViewport}`,
    );
  }

  return { width, height };
}

export function parsePositiveInt(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer (e.g. "60"): ${rawValue}`);
  }

  return value;
}

export function parsePositiveNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number (e.g. "5.0"): ${rawValue}`);
  }

  return value;
}

export function parseNonNegativeNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Expected a non-negative number (e.g. "0" or "1.5"): ${rawValue}`,
    );
  }

  return value;
}

export function parseMotion(rawMotion: string): MotionCurve {
  if (rawMotion === 'ease-in-out-sine' || rawMotion === 'linear') {
    return rawMotion;
  }

  throw new Error(
    `--motion must be "ease-in-out-sine" or "linear": ${rawMotion}`,
  );
}

export function parseWaitFor(rawWaitFor: string): WaitForCondition {
  if (rawWaitFor === 'load') {
    return { kind: 'load' };
  }

  if (rawWaitFor.startsWith('selector:')) {
    const selector = rawWaitFor.slice('selector:'.length).trim();
    if (!selector) {
      throw new Error(
        '--wait-for selector:<css> requires a non-empty CSS selector.',
      );
    }

    return {
      kind: 'selector',
      selector,
    };
  }

  if (rawWaitFor.startsWith('ms:')) {
    return {
      kind: 'delay',
      ms: parsePositiveInt(rawWaitFor.slice('ms:'.length)),
    };
  }

  throw new Error(
    `--wait-for must be "load", "selector:<css>", or "ms:<n>": ${rawWaitFor}`,
  );
}

function parseCaptureArgs(args: string[]): CaptureOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new HelpRequest(formatUsage());
  }

  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: {
        type: 'string',
      },
      viewport: {
        type: 'string',
      },
      fps: {
        type: 'string',
      },
      duration: {
        type: 'string',
      },
      motion: {
        type: 'string',
      },
      timeout: {
        type: 'string',
      },
      'wait-for': {
        type: 'string',
      },
      'hide-selector': {
        type: 'string',
        multiple: true,
      },
      'debug-frames-dir': {
        type: 'string',
      },
      'page-gap': {
        type: 'string',
      },
      manifest: {
        type: 'string',
      },
      'log-file': {
        type: 'string',
      },
      force: {
        type: 'boolean',
      },
    },
    strict: true,
  });

  if (parsed.positionals.length === 0) {
    throw new CliError('capture requires at least one URL.', true);
  }

  const urls = parsed.positionals.map((raw) =>
    parseWithCliError(raw, parseCaptureUrl),
  );

  const durationOption = parsed.values.duration ?? DEFAULT_DURATION;
  if (durationOption !== 'auto' && Number.isNaN(Number(durationOption))) {
    throw new CliError(
      `--duration must be "auto" or a positive number (e.g. --duration 5): ${durationOption}`,
    );
  }

  const outPath = parsed.values.out
    ? resolveOutPath(parsed.values.out)
    : resolveDefaultOutPath(DEFAULT_OUT_FILE);
  const pageGapSeconds = parseWithCliError(
    parsed.values['page-gap'] ?? '0',
    parseNonNegativeNumber,
  );

  const hideSelectors = parsed.values['hide-selector'] ?? [];
  for (const selector of hideSelectors) {
    parseWithCliError(selector, validateHideSelector);
  }

  const fps = parseWithCliError(
    parsed.values.fps ?? String(DEFAULT_FPS),
    parsePositiveInt,
  );

  if (fps > MAX_FPS) {
    throw new CliError(`--fps must be at most ${MAX_FPS}: ${fps}`);
  }

  return {
    urls: toNonEmptyArray(urls),
    outPath,
    manifestPath: parsed.values.manifest
      ? resolveOutPath(parsed.values.manifest)
      : deriveSidecarPath(outPath, '.manifest.json'),
    logFilePath: parsed.values['log-file']
      ? resolveOutPath(parsed.values['log-file'])
      : deriveSidecarPath(outPath, '.log.jsonl'),
    viewport: parseWithCliError(
      parsed.values.viewport ?? DEFAULT_VIEWPORT,
      parseViewport,
    ),
    fps,
    duration:
      durationOption === 'auto'
        ? 'auto'
        : parseWithCliError(durationOption, parsePositiveNumber),
    motion: parseWithCliError(
      parsed.values.motion ?? DEFAULT_MOTION,
      parseMotion,
    ),
    timeoutMs: parseWithCliError(
      parsed.values.timeout ?? String(DEFAULT_TIMEOUT_MS),
      parsePositiveInt,
    ),
    waitFor: parseWithCliError(
      parsed.values['wait-for'] ?? 'load',
      parseWaitFor,
    ),
    hideSelectors,
    pageGapSeconds,
    debugFramesDir: parsed.values['debug-frames-dir']
      ? resolveOutPath(parsed.values['debug-frames-dir'])
      : undefined,
    force: parsed.values.force === true,
  };
}

function parseRenderArgs(args: string[]): RenderCliOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new HelpRequest(formatUsage());
  }

  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: {
        type: 'string',
        multiple: true,
      },
      force: {
        type: 'boolean',
      },
    },
    strict: true,
  });

  if (parsed.positionals.length === 0) {
    throw new CliError('render requires a project JSON path.', true);
  }

  if (parsed.positionals.length > 1) {
    throw new CliError(
      `render accepts exactly one project JSON path: ${parsed.positionals.slice(1).join(', ')}`,
      true,
    );
  }

  return {
    projectPath: resolveOutPath(parsed.positionals[0]),
    outputNames: parsed.values.output ?? [],
    force: parsed.values.force === true,
  };
}

function toNonEmptyArray<T>(items: T[]): NonEmptyArray<T> {
  if (items.length === 0) {
    throw new CliError('capture requires at least one URL.', true);
  }

  return items as NonEmptyArray<T>;
}

function createMissingSubcommandError(): CliError {
  return new CliError(
    [
      'A subcommand is required.',
      '',
      'Available commands:',
      '  capture    Capture a scroll video from one or more URLs',
      '  render     Render a project JSON file into one or more videos',
      '',
      'Run rollberry --help for more information.',
    ].join('\n'),
  );
}

function createUnknownSubcommandError(command: string): CliError {
  return new CliError(
    [
      `Unknown subcommand: ${command}`,
      '',
      'Available commands:',
      '  capture    Capture a scroll video from one or more URLs',
      '  render     Render a project JSON file into one or more videos',
      '',
      'Run rollberry --help for more information.',
    ].join('\n'),
  );
}
