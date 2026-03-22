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
  parseCommandArgs,
  VersionRequest,
} from './options.js';
import { runCaptureCommand } from './run-capture.js';
import { runRenderCommand } from './run-render.js';

async function main(): Promise<void> {
  try {
    const command = parseCommandArgs();

    const controller = new AbortController();
    const onSignal = () => {
      controller.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const progress = createProgressReporter();

    try {
      if (command.kind === 'capture') {
        const result = await runCaptureCommand(
          command.options,
          progress,
          controller.signal,
        );

        process.stdout.write(`${result.capture.outPath}\n`);
        process.stderr.write(
          `${formatOutputSummary({
            label: 'Capture complete',
            outPath: result.capture.outPath,
            durationSeconds: result.capture.durationSeconds,
            frameCount: result.capture.frameCount,
            fps: command.options.fps,
            sceneCount: result.capture.pages.length,
            manifestPath: result.manifestPath,
          })}\n`,
        );
      } else {
        const result = await runRenderCommand(
          command.options,
          progress,
          controller.signal,
        );

        process.stdout.write(
          `${result.outputs.map((output) => output.capture.outPath).join('\n')}\n`,
        );

        const blocks = result.outputs.map((output) =>
          formatOutputSummary({
            label: `Render complete: ${output.name}`,
            outPath: output.capture.outPath,
            durationSeconds: output.capture.durationSeconds,
            frameCount: output.capture.frameCount,
            fps: output.fps,
            sceneCount: output.capture.pages.length,
            manifestPath: output.manifestPath,
          }),
        );

        process.stderr.write(
          `\n${blocks.join('\n\n')}\n  Summary:   ${basename(result.summaryManifestPath)}\n`,
        );
      }
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

function formatOutputSummary(input: {
  label: string;
  outPath: string;
  durationSeconds: number;
  frameCount: number;
  fps: number;
  sceneCount: number;
  manifestPath: string;
}): string {
  const fileName = basename(input.outPath);
  let fileSizeStr = '';
  try {
    const stat = statSync(input.outPath);
    fileSizeStr = formatFileSize(stat.size);
  } catch {
    // File size unavailable
  }

  const lines = [
    '',
    `${input.label}: ${fileName}`,
    `  Duration:  ${input.durationSeconds.toFixed(1)}s (${input.frameCount} frames at ${input.fps.toFixed(0)}fps)`,
  ];
  if (fileSizeStr) {
    lines.push(`  File size: ${fileSizeStr}`);
  }
  if (input.sceneCount > 1) {
    lines.push(`  Scenes:    ${input.sceneCount}`);
  }
  lines.push(`  Manifest:  ${basename(input.manifestPath)}`);

  return lines.join('\n');
}

await main();
