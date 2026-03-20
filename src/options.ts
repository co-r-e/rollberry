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

const DEFAULT_OUT_FILE = 'rollberry.mp4';
const DEFAULT_VIEWPORT = '1440x900';
const DEFAULT_FPS = 60;
const DEFAULT_DURATION = 'auto';
const DEFAULT_MOTION: MotionCurve = 'ease-in-out-sine';
const DEFAULT_TIMEOUT_MS = 30_000;

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

export function parseCliArgs(argv = process.argv.slice(2)): CaptureOptions {
  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h') {
    throw new HelpRequest(formatUsage());
  }

  if (command === '--version' || command === '-V') {
    throw new VersionRequest();
  }

  if (!command) {
    throw new CliError(
      'A subcommand is required.\n\nAvailable commands:\n  capture    Capture a scroll video from one or more URLs\n\nRun rollberry --help for more information.',
    );
  }

  if (command !== 'capture') {
    throw new CliError(
      `Unknown subcommand: ${command}\n\nAvailable commands:\n  capture    Capture a scroll video from one or more URLs\n\nRun rollberry --help for more information.`,
    );
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    throw new HelpRequest(formatUsage());
  }

  const parsed = parseArgs({
    args: rest,
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

  const outPath = resolveOutPath(parsed.values.out ?? DEFAULT_OUT_FILE);

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

function toNonEmptyArray<T>(items: T[]): NonEmptyArray<T> {
  if (items.length === 0) {
    throw new CliError('capture requires at least one URL.', true);
  }

  return items as NonEmptyArray<T>;
}

export function formatUsage(): string {
  return [
    `rollberry v${VERSION} — Capture smooth scroll videos from web pages`,
    '',
    'Usage:',
    '  rollberry capture <url...> [options]',
    '  rollberry --help | -h',
    '  rollberry --version | -V',
    '',
    'Options:',
    '  --out <file>                Output MP4 path (default: ./rollberry.mp4)',
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
    'Examples:',
    '  rollberry capture http://localhost:3000',
    '  rollberry capture https://example.com --out demo.mp4 --viewport 1920x1080',
    '  rollberry capture https://example.com --duration 10 --fps 30 --force',
  ].join('\n');
}

function parseWithCliError<T>(
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

function resolveOutPath(path: string): string {
  return resolve(process.cwd(), path);
}

function deriveSidecarPath(path: string, suffix: string): string {
  const extension = /\.([^.]+)$/u.exec(path);
  if (!extension) {
    return `${path}${suffix}`;
  }

  return path.slice(0, -extension[0].length) + suffix;
}

function parseViewport(rawViewport: string): CaptureOptions['viewport'] {
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

function parsePositiveInt(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer (e.g. "60"): ${rawValue}`);
  }

  return value;
}

function parsePositiveNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number (e.g. "5.0"): ${rawValue}`);
  }

  return value;
}

function parseNonNegativeNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Expected a non-negative number (e.g. "0" or "1.5"): ${rawValue}`,
    );
  }

  return value;
}

function parseMotion(rawMotion: string): MotionCurve {
  if (rawMotion === 'ease-in-out-sine' || rawMotion === 'linear') {
    return rawMotion;
  }

  throw new Error(
    `--motion must be "ease-in-out-sine" or "linear": ${rawMotion}`,
  );
}

function parseWaitFor(rawWaitFor: string): WaitForCondition {
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
