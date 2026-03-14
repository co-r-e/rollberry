import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { captureVideo } from '../../src/capture/capture.js';
import { createCaptureLogger } from '../../src/capture/logger.js';
import type { CaptureOptions } from '../../src/capture/types.js';
import { runCaptureCommand } from '../../src/run-capture.js';
import { startFixtureServer } from '../helpers/local-server.js';

const execFileAsync = promisify(execFile);

describe('captureVideo', () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const cleanup = cleanupTasks.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('captures an MP4 from localhost HTTP and hides selectors', async () => {
    const server = await startFixtureServer();
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-http-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const result = await captureVideo(
      createOptions({
        url: new URL(server.origin),
        outPath: join(workingDir, 'http.mp4'),
        debugFramesDir: join(workingDir, 'frames'),
      }),
      createCaptureLogger(join(workingDir, 'http.log.jsonl')),
    );

    expect(result.outPath).toBe(join(workingDir, 'http.mp4'));
    expect(result.frameCount).toBeGreaterThan(0);
    expect(result.finalScrollHeight).toBeGreaterThan(2_880);

    const probe = await ffprobeJson(result.outPath);
    expect(probe.streams[0]?.codec_name).toBe('h264');
  });

  it('captures an MP4 from localhost HTTPS with a self-signed certificate', async () => {
    const server = await startFixtureServer({ secure: true });
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-https-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const result = await captureVideo(
      createOptions({
        url: new URL(server.origin),
        outPath: join(workingDir, 'https.mp4'),
      }),
      createCaptureLogger(join(workingDir, 'https.log.jsonl')),
    );

    expect(result.frameCount).toBeGreaterThan(0);

    const probe = await ffprobeJson(result.outPath);
    expect(probe.format.format_name).toContain('mov,mp4');
  });

  it('writes manifest and log sidecars on success', async () => {
    const server = await startFixtureServer();
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-sidecars-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const run = await runCaptureCommand(
      createOptions({
        url: new URL(server.origin),
        outPath: join(workingDir, 'success.mp4'),
      }),
    );

    const manifest = JSON.parse(await readText(run.manifestPath));
    const logs = (await readText(run.logFilePath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });

    expect(manifest.status).toBe('succeeded');
    expect(manifest.artifacts.videoCreated).toBe(true);
    expect(manifest.result.frameCount).toBeGreaterThan(0);
    expect(logs.some((entry) => entry.event === 'capture.complete')).toBe(true);
  });

  it('writes failure manifest and log sidecars when capture fails', async () => {
    const server = await startFixtureServer();
    const targetUrl = new URL(server.origin);
    await server.close();

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-failure-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    await expect(
      runCaptureCommand(
        createOptions({
          url: targetUrl,
          outPath: join(workingDir, 'failure.mp4'),
          timeoutMs: 1_200,
        }),
      ),
    ).rejects.toThrow();

    const manifest = JSON.parse(
      await readText(join(workingDir, 'failure.manifest.json')),
    );
    const logs = await readText(join(workingDir, 'failure.log.jsonl'));

    expect(manifest.status).toBe('failed');
    expect(manifest.artifacts.videoCreated).toBe(false);
    expect(logs).toContain('"event":"capture.failed"');
  });
});

function createOptions(
  overrides: Pick<CaptureOptions, 'url' | 'outPath'> &
    Partial<Omit<CaptureOptions, 'url' | 'outPath'>>,
): CaptureOptions {
  return {
    url: overrides.url,
    outPath: overrides.outPath,
    manifestPath:
      overrides.manifestPath ??
      join(
        dirname(overrides.outPath),
        `${basenameWithoutExtension(overrides.outPath)}.manifest.json`,
      ),
    logFilePath:
      overrides.logFilePath ??
      join(
        dirname(overrides.outPath),
        `${basenameWithoutExtension(overrides.outPath)}.log.jsonl`,
      ),
    viewport: overrides.viewport ?? {
      width: 960,
      height: 540,
    },
    fps: overrides.fps ?? 10,
    duration: overrides.duration ?? 1.2,
    motion: overrides.motion ?? 'linear',
    timeoutMs: overrides.timeoutMs ?? 10_000,
    waitFor: overrides.waitFor ?? { kind: 'load' },
    hideSelectors: overrides.hideSelectors ?? ['#cookie-banner'],
    debugFramesDir: overrides.debugFramesDir,
  };
}

async function ffprobeJson(filePath: string): Promise<{
  format: { format_name: string };
  streams: Array<{ codec_name: string }>;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  return JSON.parse(stdout);
}

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function basenameWithoutExtension(filePath: string): string {
  return basename(filePath, '.mp4');
}
