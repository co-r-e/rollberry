#!/usr/bin/env node

import { CliError, formatUsage, parseCliArgs } from './options.js';
import { runCaptureCommand } from './run-capture.js';

async function main(): Promise<void> {
  try {
    const options = parseCliArgs();
    const result = await runCaptureCommand(options);

    process.stdout.write(`${result.capture.outPath}\n`);
  } catch (error) {
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
