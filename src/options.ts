import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type {
  CaptureOptions,
  MotionCurve,
  NonEmptyArray,
  WaitForCondition,
} from './capture/types.js';
import { parseCaptureUrl } from './capture/utils.js';

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

export function parseCliArgs(argv = process.argv.slice(2)): CaptureOptions {
  const [command, ...rest] = argv;

  if (!command) {
    throw new CliError('サブコマンドが必要です。', true);
  }

  if (command !== 'capture') {
    throw new CliError(`未知のサブコマンドです: ${command}`, true);
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
    },
    strict: true,
  });

  if (parsed.positionals.length === 0) {
    throw new CliError('capture にはURLが必要です。', true);
  }

  const urls = parsed.positionals.map((raw) =>
    parseWithCliError(raw, parseCaptureUrl),
  );

  const durationOption = parsed.values.duration ?? DEFAULT_DURATION;
  if (durationOption !== 'auto' && Number.isNaN(Number(durationOption))) {
    throw new CliError(
      `--duration は "auto" または数値で指定してください: ${durationOption}`,
    );
  }

  const outPath = resolveOutPath(parsed.values.out ?? DEFAULT_OUT_FILE);

  const pageGapSeconds = parseWithCliError(
    parsed.values['page-gap'] ?? '0',
    parseNonNegativeNumber,
  );

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
    fps: parseWithCliError(
      parsed.values.fps ?? String(DEFAULT_FPS),
      parsePositiveInt,
    ),
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
    hideSelectors: parsed.values['hide-selector'] ?? [],
    pageGapSeconds,
    debugFramesDir: parsed.values['debug-frames-dir']
      ? resolveOutPath(parsed.values['debug-frames-dir'])
      : undefined,
  };
}

function toNonEmptyArray<T>(items: T[]): NonEmptyArray<T> {
  if (items.length === 0) {
    throw new CliError('capture にはURLが必要です。', true);
  }

  return items as NonEmptyArray<T>;
}

export function formatUsage(): string {
  return [
    'Usage:',
    '  rollberry capture <url...> [options]',
    '',
    'Options:',
    '  --out <file>                Output MP4 path (default: ./rollberry.mp4)',
    '  --viewport <WxH>           Viewport size (default: 1440x900)',
    '  --fps <n>                  Frames per second (default: 60)',
    '  --duration <seconds|auto>  Capture duration (default: auto)',
    '  --motion <curve>           ease-in-out-sine | linear',
    '  --timeout <ms>             Navigation timeout (default: 30000)',
    '  --wait-for <mode>          load | selector:<css> | ms:<n>',
    '  --hide-selector <css>      Hide CSS selector before capture',
    '  --debug-frames-dir <dir>   Save raw PNG frames for debugging',
    '  --page-gap <seconds>       Pause between pages (default: 0)',
    '  --manifest <file>          Manifest JSON path (default: <out>.manifest.json)',
    '  --log-file <file>          Log JSONL path (default: <out>.log.jsonl)',
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
      error instanceof Error ? error.message : '引数の解析に失敗しました。',
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
      `--viewport は "1440x900" の形式で指定してください: ${rawViewport}`,
    );
  }

  const width = Number(match.groups.width);
  const height = Number(match.groups.height);

  if (width <= 0 || height <= 0) {
    throw new Error(`--viewport の値が不正です: ${rawViewport}`);
  }

  return { width, height };
}

function parsePositiveInt(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`正の整数を指定してください: ${rawValue}`);
  }

  return value;
}

function parsePositiveNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`正の数値を指定してください: ${rawValue}`);
  }

  return value;
}

function parseNonNegativeNumber(rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`0以上の数値を指定してください: ${rawValue}`);
  }

  return value;
}

function parseMotion(rawMotion: string): MotionCurve {
  if (rawMotion === 'ease-in-out-sine' || rawMotion === 'linear') {
    return rawMotion;
  }

  throw new Error(
    `--motion は ease-in-out-sine または linear です: ${rawMotion}`,
  );
}

function parseWaitFor(rawWaitFor: string): WaitForCondition {
  if (rawWaitFor === 'load') {
    return { kind: 'load' };
  }

  if (rawWaitFor.startsWith('selector:')) {
    const selector = rawWaitFor.slice('selector:'.length).trim();
    if (!selector) {
      throw new Error('--wait-for selector:<css> の CSS セレクタが空です。');
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
    `--wait-for は load / selector:<css> / ms:<n> のいずれかです: ${rawWaitFor}`,
  );
}
