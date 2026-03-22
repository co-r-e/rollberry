import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runRenderCommand } from '../../src/run-render.js';
import { startFixtureServer } from '../helpers/local-server.js';

const execFileAsync = promisify(execFile);
const hasFfprobe = isCommandAvailable('ffprobe');

describe('runRenderCommand', () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const cleanup = cleanupTasks.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('renders a project file with timeline actions into multiple outputs', async () => {
    const server = await startFixtureServer();
    cleanupTasks.push(() => server.close());

    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-render-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const audioPath = join(workingDir, 'narration.wav');
    const subtitlePath = join(workingDir, 'captions.vtt');
    await writeSilentWav(audioPath, 8);
    await writeFile(
      subtitlePath,
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:02.000',
        'Rollberry timeline demo',
        '',
        '00:00:02.000 --> 00:00:04.000',
        'Mid-capture actions',
        '',
      ].join('\n'),
      'utf8',
    );

    const projectPath = join(workingDir, 'demo.project.json');
    await writeFile(
      projectPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          name: 'Fixture Demo',
          summaryManifest: './artifacts/render-summary.json',
          defaults: {
            fps: 12,
            timeoutMs: 10_000,
            waitFor: 'selector:body',
            hideSelectors: ['#cookie-banner'],
            duration: 1.2,
          },
          scenes: [
            {
              name: 'home',
              url: server.origin,
              holdAfterSeconds: 0.25,
              actions: [
                { type: 'type', selector: '#search-field', text: 'Rollberry' },
                { type: 'press', key: 'Tab' },
              ],
              timeline: [
                { type: 'pause', duration: 0.25 },
                {
                  type: 'click',
                  selector: '#open-panel',
                  holdAfterSeconds: 0.25,
                },
                { type: 'scroll', by: 720, duration: 0.8 },
                {
                  type: 'scroll',
                  toSelector: '#lazy-loaded',
                  duration: 0.8,
                  block: 'center',
                },
              ],
            },
            {
              name: 'page-2',
              url: `${server.origin}/page2`,
              timeline: [{ type: 'scroll', to: 'bottom', duration: 1.2 }],
            },
          ],
          outputs: [
            {
              name: 'desktop',
              viewport: '960x540',
              out: './artifacts/fixture-desktop.mp4',
              audio: {
                path: './narration.wav',
                volume: 0.7,
                loop: true,
              },
              subtitles: {
                path: './captions.vtt',
                mode: 'burn-in',
              },
              transition: {
                type: 'crossfade',
                duration: 0.2,
              },
              intermediateArtifact: {
                format: 'mp4',
                preset: 'veryfast',
                crf: 20,
              },
              finalVideo: {
                preset: 'medium',
                crf: 19,
              },
            },
            {
              name: 'mobile',
              viewport: '430x932',
              out: './artifacts/fixture-mobile.webm',
              format: 'webm',
              audio: {
                path: './narration.wav',
                volume: 0.5,
                loop: true,
              },
              subtitles: {
                path: './captions.vtt',
              },
              transition: {
                type: 'crossfade',
                duration: 0.2,
              },
              intermediateArtifact: {
                format: 'mp4',
                preset: 'fast',
                crf: 22,
              },
              finalVideo: {
                deadline: 'best',
                crf: 30,
              },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await runRenderCommand({
      projectPath,
      outputNames: [],
      force: true,
    });

    expect(result.outputs).toHaveLength(2);
    expect(result.summaryManifestPath).toMatch(/render-summary\.json$/u);

    const summaryManifest = JSON.parse(
      await readText(result.summaryManifestPath),
    );
    expect(summaryManifest.kind).toBe('render-summary');
    expect(summaryManifest.status).toBe('succeeded');
    expect(summaryManifest.outputs).toHaveLength(2);

    for (const output of result.outputs) {
      const manifest = JSON.parse(await readText(output.manifestPath));
      const logText = await readText(output.logFilePath);

      await expectVideoFile(output.capture.outPath);

      expect(manifest.kind).toBe('render');
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.status).toBe('succeeded');
      expect(manifest).not.toHaveProperty('result');
      expect(manifest.output.name).toBe(output.name);
      expect(manifest.output.format).toBe(output.format);
      expect(manifest.scenes).toHaveLength(2);
      expect(manifest.captureMetrics.frameCount).toBeGreaterThan(0);
      expect(manifest.captureMetrics.durationSeconds).toBeGreaterThan(
        manifest.artifactMetrics.durationSeconds,
      );
      expect(manifest.captureMetrics.scenes).toHaveLength(2);
      expect(manifest.artifactMetrics.videoPath).toBe(output.capture.outPath);
      expect(manifest.scenes[0]?.actions).toHaveLength(2);
      expect(manifest.scenes[0]?.timeline).toHaveLength(4);
      expect(logText).toContain('"event":"scene.action.complete"');
      expect(logText).toContain('"event":"timeline.segment.complete"');
      expect(logText).toContain('"event":"compose.complete"');

      const pageDurationSum = output.capture.pages.reduce(
        (sum, page) => sum + page.durationSeconds,
        0,
      );
      expect(manifest.captureMetrics.durationSeconds).toBeGreaterThanOrEqual(
        pageDurationSum,
      );
      expect(manifest.captureMetrics.durationSeconds).toBeGreaterThan(
        output.capture.durationSeconds,
      );

      if (output.format === 'mp4') {
        expect(manifest.output.audio?.sourcePath).toMatch(/narration\.wav$/u);
        expect(manifest.output.subtitles?.sourcePath).toMatch(
          /captions\.vtt$/u,
        );
        expect(manifest.output.transition).toEqual({
          kind: 'crossfade',
          durationSeconds: 0.2,
        });
        expect(manifest.output.subtitles?.mode).toBe('burn-in');
        expect(manifest.output.subtitles?.format).toBe('webvtt');
        expect(manifest.output.intermediateArtifact).toEqual({
          format: 'mp4',
          extension: '.mp4',
          videoEncoding: {
            preset: 'veryfast',
            crf: 20,
          },
        });
        expect(manifest.output.finalVideo).toEqual({
          format: 'mp4',
          preset: 'medium',
          crf: 19,
        });
      } else {
        expect(manifest.output.subtitles?.mode).toBe('soft');
        expect(manifest.output.subtitles?.format).toBe('webvtt');
        expect(manifest.output.intermediateArtifact).toEqual({
          format: 'mp4',
          extension: '.mp4',
          videoEncoding: {
            preset: 'fast',
            crf: 22,
          },
        });
        expect(manifest.output.finalVideo).toEqual({
          format: 'webm',
          deadline: 'best',
          crf: 30,
        });
      }

      if (hasFfprobe) {
        const probe = await ffprobeJson(output.capture.outPath);
        const subtitleStreams = probe.streams.filter(
          (stream) => stream.codec_type === 'subtitle',
        );
        expect(manifest.artifactMetrics.probe.status).toBe('probed');
        expect(manifest.artifactMetrics.probe.source).toBe('ffprobe');

        if (output.format === 'mp4') {
          expect(subtitleStreams).toHaveLength(0);
        } else {
          expect(subtitleStreams[0]?.codec_name).toBe('webvtt');
        }
      } else {
        expect(manifest.artifactMetrics.probe.source).toBe('estimate');
      }
    }
  });
});

async function ffprobeJson(filePath: string): Promise<{
  format: { duration?: string; format_name: string };
  streams: Array<{ codec_name?: string; codec_type?: string }>;
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

  return JSON.parse(
    typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf8'),
  );
}

async function expectVideoFile(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  expect(fileStat.isFile()).toBe(true);
  expect(fileStat.size).toBeGreaterThan(0);
}

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ['-version'], {
    stdio: 'ignore',
  });

  return result.status === 0;
}

async function writeSilentWav(
  filePath: string,
  durationSeconds: number,
): Promise<void> {
  const sampleRate = 22_050;
  const bitsPerSample = 16;
  const channelCount = 1;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * bytesPerSample * channelCount;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample * channelCount, 28);
  buffer.writeUInt16LE(bytesPerSample * channelCount, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  await writeFile(filePath, buffer);
}
