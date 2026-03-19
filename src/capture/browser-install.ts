import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { chromium } from 'playwright';

import type { CaptureLogger } from './logger.js';

const require = createRequire(import.meta.url);

export async function ensureChromiumInstalled(
  logger: CaptureLogger,
): Promise<void> {
  const executablePath = chromium.executablePath();

  if (await hasExecutable(executablePath)) {
    return;
  }

  await logger.warn(
    'browser.install.start',
    'Chromium was not found. Installing Playwright Chromium.',
    { executablePath },
  );

  await installPlaywrightChromium(resolvePlaywrightCliPath());

  if (!(await hasExecutable(executablePath))) {
    throw new Error(
      `Chromium executable not found after installation: ${executablePath}`,
    );
  }

  await logger.info(
    'browser.install.complete',
    'Playwright Chromium installation finished.',
    { executablePath },
  );
}

export function resolvePlaywrightCliPath(): string {
  return join(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

async function hasExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function installPlaywrightChromium(cliPath: string): Promise<void> {
  const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
    env: process.env,
    stdio: 'inherit',
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Playwright Chromium install failed with exit code ${code ?? 'null'}.`,
        ),
      );
    });
  });
}
