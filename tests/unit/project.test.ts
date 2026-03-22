import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRenderProject } from '../../src/project.js';

describe('loadRenderProject', () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const cleanup = cleanupTasks.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('loads scenes, actions, and derived output paths from project JSON', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'rollberry-project-'));
    cleanupTasks.push(() => rm(workingDir, { recursive: true, force: true }));

    const projectPath = join(workingDir, 'demo.project.json');
    const audioPath = join(workingDir, 'narration.wav');
    const subtitlePath = join(workingDir, 'captions.vtt');
    await writeFile(audioPath, Buffer.alloc(16));
    await writeFile(
      subtitlePath,
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRollberry\n',
      'utf8',
    );
    await writeFile(
      projectPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          summaryManifest: './artifacts/render-summary.json',
          defaults: {
            viewport: '1280x720',
            fps: 30,
            waitFor: 'selector:body',
            hideSelectors: ['#cookie-banner'],
          },
          scenes: [
            {
              name: 'Home',
              url: 'https://example.com',
              holdAfterSeconds: 1.25,
              actions: [
                { type: 'click', selector: '#open-panel' },
                { type: 'type', selector: '#search-field', text: 'rollberry' },
              ],
              timeline: [
                { type: 'pause', duration: 0.5 },
                { type: 'scroll', by: 600, duration: 0.8 },
                {
                  type: 'click',
                  selector: '#open-panel',
                  holdAfterSeconds: 0.3,
                },
              ],
            },
          ],
          outputs: [
            {
              name: 'desktop',
              out: './artifacts/home.mp4',
              audio: {
                path: './narration.wav',
                volume: 0.8,
              },
              subtitles: {
                path: './captions.vtt',
                mode: 'burn-in',
              },
              transition: {
                type: 'crossfade',
                duration: 0.35,
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
              out: './artifacts/home.webm',
              subtitles: {
                path: './captions.vtt',
              },
              finalVideo: {
                deadline: 'best',
                crf: 28,
              },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const project = await loadRenderProject({
      projectPath,
      outputNames: [],
      force: true,
    });

    expect(project.timeoutMs).toBe(30_000);
    expect(project.summaryManifestPath).toMatch(
      /artifacts\/render-summary\.json$/u,
    );
    expect(project.scenes[0]?.name).toBe('Home');
    expect(project.scenes[0]?.hideSelectors).toEqual(['#cookie-banner']);
    expect(project.scenes[0]?.holdAfterSeconds).toBe(1.25);
    expect(project.scenes[0]?.actions).toHaveLength(2);
    expect(project.scenes[0]?.timeline).toHaveLength(3);
    expect(project.scenes[0]?.timeline[1]).toMatchObject({
      kind: 'scroll',
      duration: 0.8,
    });
    expect(project.outputs[0]?.name).toBe('desktop');
    expect(project.outputs[0]?.outPath).toMatch(/artifacts\/home\.mp4$/u);
    expect(project.outputs[0]?.format).toBe('mp4');
    expect(project.outputs[0]?.manifestPath).toMatch(
      /artifacts\/home\.manifest\.json$/u,
    );
    expect(project.outputs[0]?.viewport).toEqual({ width: 1280, height: 720 });
    expect(project.outputs[0]?.fps).toBe(30);
    expect(project.outputs[0]?.audio?.sourcePath).toMatch(/narration\.wav$/u);
    expect(project.outputs[0]?.subtitles?.sourcePath).toMatch(
      /captions\.vtt$/u,
    );
    expect(project.outputs[0]?.subtitles?.format).toBe('webvtt');
    expect(project.outputs[0]?.subtitles?.mode).toBe('burn-in');
    expect(project.outputs[0]?.transition).toEqual({
      kind: 'crossfade',
      durationSeconds: 0.35,
    });
    expect(project.outputs[0]?.intermediateArtifact).toEqual({
      format: 'mp4',
      extension: '.mp4',
      videoEncoding: {
        preset: 'veryfast',
        crf: 20,
      },
    });
    expect(project.outputs[0]?.finalVideo).toEqual({
      format: 'mp4',
      preset: 'medium',
      crf: 19,
    });
    expect(project.outputs[1]?.format).toBe('webm');
    expect(project.outputs[1]?.subtitles?.format).toBe('webvtt');
    expect(project.outputs[1]?.subtitles?.mode).toBe('soft');
    expect(project.outputs[1]?.intermediateArtifact).toEqual({
      format: 'mp4',
      extension: '.mp4',
      videoEncoding: {
        preset: 'slow',
        crf: 18,
      },
    });
    expect(project.outputs[1]?.finalVideo).toEqual({
      format: 'webm',
      deadline: 'best',
      crf: 28,
    });
  });
});
