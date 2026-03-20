#!/usr/bin/env node

import { statSync } from 'node:fs';
import { basename } from 'node:path';

import { AbortError } from './capture/capture.js';
import { createProgressReporter } from './capture/progress.js';
import { formatFileSize } from './capture/utils.js';
import {
  CliError,
  formatUsage,
  HelpRequest,
  parseCliArgs,
  VersionRequest,
} from './options.js';
import { runCaptureCommand } from './run-capture.js';

async function main(): Promise<void> {
  try {
    const options = parseCliArgs();

    const controller = new AbortController();
    const onSignal = () => {
      controller.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const progress = createProgressReporter();

    try {
      const result = await runCaptureCommand(
        options,
        progress,
        controller.signal,
      );

      process.stdout.write(`${result.capture.outPath}\n`);

      const fileName = basename(result.capture.outPath);
      let fileSizeStr = '';
      try {
        const stat = statSync(result.capture.outPath);
        fileSizeStr = formatFileSize(stat.size);
      } catch {
        // File size unavailable
      }

      const lines = [
        '',
        `Capture complete: ${fileName}`,
        `  Duration:  ${result.capture.durationSeconds.toFixed(1)}s (${result.capture.frameCount} frames at ${options.fps}fps)`,
      ];
      if (fileSizeStr) {
        lines.push(`  File size: ${fileSizeStr}`);
      }
      if (result.capture.pages.length > 1) {
        lines.push(`  Pages:     ${result.capture.pages.length}`);
      }
      lines.push(`  Manifest:  ${basename(result.manifestPath)}`);

      process.stderr.write(`${lines.join('\n')}\n`);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  } catch (error) {
    if (error instanceof HelpRequest) {
      process.stdout.write(`${error.message}\n`);
      return;
    }

    if (error instanceof VersionRequest) {
      process.stdout.write(`${error.version}\n`);
      return;
    }

    if (error instanceof AbortError) {
      process.stderr.write('\nCapture cancelled.\n');
      process.exitCode = 130;
      return;
    }

    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      if (error.showUsage) {
        process.stderr.write(`\n${formatUsage()}\n`);
      }
      process.exitCode = 1;
      return;
    }

    process.stderr.write(
      `${error instanceof Error ? error.message : 'An unexpected error occurred.'}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
