import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
        urls: [new URL(server.origin)],
        outPath: join(workingDir, 'http.mp4'),
        debugFramesDir: join(workingDir, 'frames'),
      }),
      createCaptureLogger(join(workingDir, 'http.log.jsonl')),
    );

    expect(result.outPath).toBe(join(workingDir, 'http.mp4'));
    expect(result.frameCount).toBeGreaterThan(0);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.scrollHeight).toBeGreaterThan(2_880);

    const probe = await ffprobeJson(result.outPath);
    expect(probe.streams[0]?.codec_name).toBe('h264');
    expect(Number(probe.streams[0]?.nb_read_frames)).toBe(result.frameCount);
  });

  it('captures an MP4 from localhost HTTPS with a self-signed certificate', async () => {
    const server = await startFixtureServer({ secure: true });
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-https-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const result = await captureVideo(
      createOptions({
        urls: [new URL(server.origin)],
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
        urls: [new URL(server.origin)],
        outPath: join(workingDir, 'success.mp4'),
      }),
    );

    const manifest = JSON.parse(await readText(run.manifestPath));
    const logs = (await readText(run.logFilePath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.status).toBe('succeeded');
    expect(manifest.options.urls).toEqual([new URL(server.origin).toString()]);
    expect(manifest.options.pageGapSeconds).toBe(0);
    expect(manifest.artifacts.videoCreated).toBe(true);
    expect(manifest.result.frameCount).toBeGreaterThan(0);
    expect(manifest.result.pages).toHaveLength(1);
    expect(logs.some((entry) => entry.event === 'capture.complete')).toBe(true);
  });

  it('captures multiple pages into a single MP4', async () => {
    const server = await startFixtureServer();
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-multi-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const url1 = new URL(server.origin);
    const url2 = new URL(`${server.origin}/page2`);

    const result = await captureVideo(
      createOptions({
        urls: [url1, url2],
        outPath: join(workingDir, 'multi.mp4'),
      }),
      createCaptureLogger(join(workingDir, 'multi.log.jsonl')),
    );

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]!.url).toBe(url1.toString());
    expect(result.pages[1]!.url).toBe(url2.toString());
    expect(result.frameCount).toBe(
      result.pages[0]!.frameCount + result.pages[1]!.frameCount,
    );

    const probe = await ffprobeJson(result.outPath);
    expect(probe.streams[0]?.codec_name).toBe('h264');
    expect(Number(probe.streams[0]?.nb_read_frames)).toBe(result.frameCount);
  });

  it('captures multiple pages with page gap', async () => {
    const server = await startFixtureServer();
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-gap-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const url1 = new URL(server.origin);
    const url2 = new URL(`${server.origin}/page2`);
    const gapSeconds = 0.5;
    const fps = 10;

    const result = await captureVideo(
      createOptions({
        urls: [url1, url2],
        outPath: join(workingDir, 'gap.mp4'),
        pageGapSeconds: gapSeconds,
        fps,
        debugFramesDir: join(workingDir, 'frames'),
      }),
      createCaptureLogger(join(workingDir, 'gap.log.jsonl')),
    );

    const expectedGapFrames = Math.round(fps * gapSeconds);
    expect(result.frameCount).toBe(
      result.pages[0]!.frameCount +
        expectedGapFrames +
        result.pages[1]!.frameCount,
    );

    const probe = await ffprobeJson(result.outPath);
    expect(probe.streams[0]?.codec_name).toBe('h264');
    expect(Number(probe.streams[0]?.nb_read_frames)).toBe(result.frameCount);

    const debugFrames = (await readdir(join(workingDir, 'frames'))).filter((file) =>
      file.endsWith('.png'),
    );
    expect(debugFrames).toHaveLength(result.frameCount);
  });

  it('rejects capture when no URLs are provided programmatically', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-empty-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    await expect(
      captureVideo(
        createOptions({
          urls: [] as unknown as CaptureOptions['urls'],
          outPath: join(workingDir, 'empty.mp4'),
        }),
        createCaptureLogger(join(workingDir, 'empty.log.jsonl')),
      ),
    ).rejects.toThrow('少なくとも1つのURLを指定してください。');
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
          urls: [targetUrl],
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
  overrides: Pick<CaptureOptions, 'urls' | 'outPath'> &
    Partial<Omit<CaptureOptions, 'urls' | 'outPath'>>,
): CaptureOptions {
  return {
    urls: overrides.urls,
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
    pageGapSeconds: overrides.pageGapSeconds ?? 0,
    debugFramesDir: overrides.debugFramesDir,
  };
}

async function ffprobeJson(filePath: string): Promise<{
  format: { format_name: string };
  streams: Array<{ codec_name: string; nb_read_frames?: string }>;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-count_frames',
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
