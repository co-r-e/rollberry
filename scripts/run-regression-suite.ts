import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseCliArgs } from '../src/options.js';
import { runCaptureCommand } from '../src/run-capture.js';

interface RegressionCaseConfig {
  name: string;
  url: string;
  viewport?: string;
  fps?: number;
  duration?: number | 'auto';
  motion?: 'ease-in-out-sine' | 'linear';
  timeout?: number;
  waitFor?: string;
  hideSelectors?: string[];
  debugFrames?: boolean;
}

interface RegressionSuiteConfig {
  outputDir?: string;
  cases: RegressionCaseConfig[];
}

interface RegressionCaseSummary {
  name: string;
  url: string;
  status: 'succeeded' | 'failed';
  outPath: string;
  manifestPath: string;
  logFilePath: string;
  error?: string;
}

async function main(): Promise<void> {
  const rawArgs =
    process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
  const parsed = parseArgs({
    args: rawArgs,
    allowPositionals: false,
    options: {
      config: {
        type: 'string',
      },
    },
    strict: true,
  });

  const configPath = parsed.values.config
    ? resolve(process.cwd(), parsed.values.config)
    : resolve(process.cwd(), 'regression.sample.json');
  const config = await loadConfig(configPath);
  const outputDir = resolve(
    process.cwd(),
    config.outputDir ?? './artifacts/regression',
  );

  await mkdir(outputDir, { recursive: true });

  const summaries: RegressionCaseSummary[] = [];

  for (const testCase of config.cases) {
    const safeName = sanitizeName(testCase.name);
    const outPath = join(outputDir, `${safeName}.mp4`);
    const args = buildCaptureArgs(testCase, outPath);
    const options = parseCliArgs(args);

    try {
      const result = await runCaptureCommand(options);
      summaries.push({
        name: testCase.name,
        url: testCase.url,
        status: 'succeeded',
        outPath: result.capture.outPath,
        manifestPath: result.manifestPath,
        logFilePath: result.logFilePath,
      });
      process.stderr.write(`PASS ${testCase.name}\n`);
    } catch (error) {
      summaries.push({
        name: testCase.name,
        url: testCase.url,
        status: 'failed',
        outPath: options.outPath,
        manifestPath: options.manifestPath,
        logFilePath: options.logFilePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      process.stderr.write(`FAIL ${testCase.name}\n`);
    }
  }

  const summaryPath = join(outputDir, 'summary.json');
  await writeFile(
    summaryPath,
    `${JSON.stringify(summaries, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${summaryPath}\n`);

  if (summaries.some((summary) => summary.status === 'failed')) {
    process.exitCode = 1;
  }
}

async function loadConfig(path: string): Promise<RegressionSuiteConfig> {
  const file = await readFile(path, 'utf8');
  const parsed = JSON.parse(file) as RegressionSuiteConfig;

  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Regression config is missing "cases": ${path}`);
  }

  return parsed;
}

function buildCaptureArgs(
  testCase: RegressionCaseConfig,
  outPath: string,
): string[] {
  const args = ['capture', testCase.url, '--out', outPath];

  if (testCase.viewport) {
    args.push('--viewport', testCase.viewport);
  }

  if (typeof testCase.fps === 'number') {
    args.push('--fps', String(testCase.fps));
  }

  if (testCase.duration !== undefined) {
    args.push('--duration', String(testCase.duration));
  }

  if (testCase.motion) {
    args.push('--motion', testCase.motion);
  }

  if (typeof testCase.timeout === 'number') {
    args.push('--timeout', String(testCase.timeout));
  }

  if (testCase.waitFor) {
    args.push('--wait-for', testCase.waitFor);
  }

  for (const selector of testCase.hideSelectors ?? []) {
    args.push('--hide-selector', selector);
  }

  if (testCase.debugFrames) {
    args.push(
      '--debug-frames-dir',
      join(dirname(outPath), `${basename(outPath, '.mp4')}-frames`),
    );
  }

  return args;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

await main();
