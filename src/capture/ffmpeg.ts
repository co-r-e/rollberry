import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CaptureAudioTrack,
  CaptureSubtitleTrack,
  CaptureTransition,
  CaptureVideoEncodingSettings,
  FinalVideoEncodingSettings,
  OutputFormat,
} from './types.js';

const FFMPEG_ABORT_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

interface EncoderCloseResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface VideoEncoder {
  writeFrame(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export interface ComposedVideoClip {
  path: string;
  durationSeconds: number;
}

export interface VideoProbeResult {
  durationSeconds: number;
  frameCount?: number;
}

export interface VideoProbeOutcome {
  status: 'probed' | 'unavailable' | 'failed' | 'invalid';
  result?: VideoProbeResult;
  warning?: string;
}

export async function checkFfmpegAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', ['-version'], (error) => {
      if (error) {
        reject(createFfmpegPreflightError(error));
        return;
      }
      resolve();
    });
  });
}

export async function createVideoEncoder(options: {
  fps: number;
  outPath: string;
  format: OutputFormat;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  videoEncoding?: CaptureVideoEncodingSettings;
}): Promise<VideoEncoder> {
  const ffmpeg = spawn('ffmpeg', buildStreamingFfmpegArgs(options), {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let spawnError: Error | undefined;
  let stderr = '';
  let closeResult: EncoderCloseResult | undefined;

  const closePromise = new Promise<EncoderCloseResult>((resolve) => {
    ffmpeg.once('close', (exitCode, signal) => {
      closeResult = { exitCode, signal };
      resolve(closeResult);
    });
  });

  ffmpeg.on('error', (error) => {
    spawnError = error;
  });

  const STDERR_MAX_LENGTH = 8192;
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > STDERR_MAX_LENGTH) {
      stderr = stderr.slice(-STDERR_MAX_LENGTH);
    }
  });

  return {
    async writeFrame(frame) {
      if (spawnError) {
        throw createEncoderError(spawnError, stderr);
      }

      if (closeResult) {
        throw createEncoderError(
          new Error(
            `FFmpeg exited before encoding completed (${formatCloseResult(closeResult)})`,
          ),
          stderr,
        );
      }

      const stdin = ffmpeg.stdin;
      if (stdin.destroyed) {
        throw createEncoderError(new Error('FFmpeg stdin is closed.'), stderr);
      }

      await new Promise<void>((resolve, reject) => {
        stdin.write(frame, (error) => {
          if (error) {
            reject(createEncoderError(error, stderr));
            return;
          }

          resolve();
        });
      });
    },
    async finish() {
      if (spawnError) {
        throw createEncoderError(spawnError, stderr);
      }

      if (!ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
        ffmpeg.stdin.end();
      }
      const result = closeResult ?? (await closePromise);

      if (result.exitCode !== 0) {
        throw createEncoderError(
          new Error(`FFmpeg exited with error (${formatCloseResult(result)})`),
          stderr,
        );
      }
    },
    async abort() {
      try {
        if (!ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
          ffmpeg.stdin.destroy();
        }
      } catch {
        // stdin may already be closed
      }

      if (closeResult) {
        await closePromise;
        return;
      }

      try {
        ffmpeg.kill('SIGTERM');
      } catch {
        // Process may already be exiting
      }

      const exited = await Promise.race([
        closePromise.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(resolve, FFMPEG_ABORT_TIMEOUT_MS, false);
        }),
      ]);

      if (!exited && !closeResult) {
        try {
          ffmpeg.kill('SIGKILL');
        } catch {
          // Process may already be exiting
        }
        await closePromise;
      }
    },
  };
}

export async function composeVideoClips(options: {
  clips: [ComposedVideoClip, ...ComposedVideoClip[]];
  outPath: string;
  format: OutputFormat;
  fps: number;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  finalVideo: FinalVideoEncodingSettings;
  force: boolean;
}): Promise<void> {
  await runFfmpeg(buildComposeFfmpegArgs(options));
}

export async function probeVideoFile(
  filePath: string,
): Promise<VideoProbeOutcome> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const parsed = JSON.parse(formatExecBuffer(stdout)) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        nb_frames?: string;
        duration?: string;
      }>;
    };

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const durationSeconds = parseFiniteNumber(
      parsed.format?.duration ?? videoStream?.duration,
    );

    if (durationSeconds === undefined) {
      return {
        status: 'invalid',
        warning: `ffprobe did not return a usable duration for: ${filePath}`,
      };
    }

    return {
      status: 'probed',
      result: {
        durationSeconds,
        frameCount: parseFrameCount(videoStream?.nb_frames),
      },
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {
        status: 'unavailable',
        warning:
          'ffprobe is not available on PATH; falling back to estimated metrics.',
      };
    }

    return {
      status: 'failed',
      warning:
        error instanceof Error
          ? `ffprobe failed for ${filePath}: ${error.message}`
          : `ffprobe failed for ${filePath}.`,
    };
  }
}

function buildStreamingFfmpegArgs(options: {
  fps: number;
  outPath: string;
  format: OutputFormat;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  videoEncoding?: CaptureVideoEncodingSettings;
}): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(options.fps),
    '-c:v',
    'png',
    '-i',
    'pipe:0',
  ];

  let nextInputIndex = 1;
  let audioInputIndex: number | undefined;
  let subtitleInputIndex: number | undefined;

  if (options.audio) {
    if (options.audio.loop) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', options.audio.sourcePath);
    audioInputIndex = nextInputIndex;
    nextInputIndex += 1;
  }

  if (options.subtitles?.mode === 'soft') {
    args.push('-i', options.subtitles.sourcePath);
    subtitleInputIndex = nextInputIndex;
  }

  args.push('-map', '0:v:0');
  if (audioInputIndex !== undefined) {
    args.push('-map', `${audioInputIndex}:a:0`);
  }
  if (subtitleInputIndex !== undefined) {
    args.push('-map', `${subtitleInputIndex}:s:0`);
  }

  if (options.audio) {
    args.push('-af', buildAudioFilter(options.audio));
    args.push('-shortest');
  } else {
    args.push('-an');
  }

  args.push('-vf', buildVideoFilter(options.subtitles, options.transition));
  args.push(
    ...buildIntermediateFormatArgs(
      options.format,
      options.audio,
      options.subtitles,
      options.videoEncoding,
    ),
  );
  args.push(options.outPath);

  return args;
}

function buildComposeFfmpegArgs(options: {
  clips: [ComposedVideoClip, ...ComposedVideoClip[]];
  outPath: string;
  format: OutputFormat;
  fps: number;
  audio?: CaptureAudioTrack;
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
  finalVideo: FinalVideoEncodingSettings;
  force: boolean;
}): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    options.force ? '-y' : '-n',
  ];

  for (const clip of options.clips) {
    args.push('-i', clip.path);
  }

  let nextInputIndex = options.clips.length;
  let audioInputIndex: number | undefined;
  let subtitleInputIndex: number | undefined;

  if (options.audio) {
    if (options.audio.loop) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', options.audio.sourcePath);
    audioInputIndex = nextInputIndex;
    nextInputIndex += 1;
  }

  if (options.subtitles?.mode === 'soft') {
    args.push('-i', options.subtitles.sourcePath);
    subtitleInputIndex = nextInputIndex;
  }

  const filterComplex = buildComposeFilterComplex({
    clips: options.clips,
    subtitles: options.subtitles,
    transition: options.transition,
  });

  args.push('-filter_complex', filterComplex, '-map', '[video_out]');

  if (audioInputIndex !== undefined) {
    const audio = options.audio;
    if (!audio) {
      throw new Error('Audio input index was set without an audio track.');
    }
    args.push('-map', `${audioInputIndex}:a:0`);
    args.push('-af', buildAudioFilter(audio));
    args.push('-shortest');
  } else {
    args.push('-an');
  }

  if (subtitleInputIndex !== undefined) {
    args.push('-map', `${subtitleInputIndex}:s:0`);
  }

  args.push('-r', String(options.fps));
  args.push(
    ...buildFinalFormatArgs(
      options.format,
      options.audio,
      options.subtitles,
      options.finalVideo,
    ),
  );
  args.push(options.outPath);

  return args;
}

function buildComposeFilterComplex(options: {
  clips: [ComposedVideoClip, ...ComposedVideoClip[]];
  subtitles?: CaptureSubtitleTrack;
  transition?: CaptureTransition;
}): string {
  const segments: string[] = [];
  const crossfade =
    options.transition?.kind === 'crossfade' && options.clips.length > 1
      ? options.transition
      : undefined;

  let currentLabel: string;

  if (crossfade) {
    validateCrossfadeDuration(options.clips, crossfade.durationSeconds);

    for (const [index] of options.clips.entries()) {
      segments.push(`[${index}:v:0]format=yuv420p,setsar=1[v${index}]`);
    }

    currentLabel = '[v0]';
    let accumulatedDuration = options.clips[0].durationSeconds;
    for (let index = 1; index < options.clips.length; index += 1) {
      const outputLabel = `[xfade${index}]`;
      const offset = accumulatedDuration - crossfade.durationSeconds * index;
      segments.push(
        `${currentLabel}[v${index}]xfade=transition=fade:duration=${formatFilterNumber(
          crossfade.durationSeconds,
        )}:offset=${formatFilterNumber(offset)}${outputLabel}`,
      );
      currentLabel = outputLabel;
      accumulatedDuration += options.clips[index].durationSeconds;
    }
  } else if (options.clips.length > 1) {
    currentLabel = '[concat_video]';
    segments.push(
      `${options.clips
        .map((_, index) => `[${index}:v:0]`)
        .join('')}concat=n=${options.clips.length}:v=1:a=0${currentLabel}`,
    );
  } else {
    currentLabel = '[0:v:0]';
  }

  const postFilters: string[] = ['pad=ceil(iw/2)*2:ceil(ih/2)*2'];

  if (options.subtitles?.mode === 'burn-in') {
    postFilters.push(buildBurnInSubtitleFilter(options.subtitles));
  }

  if (options.transition?.kind === 'fade-in') {
    postFilters.push(
      `fade=t=in:st=0:d=${formatFilterNumber(
        options.transition.durationSeconds,
      )}`,
    );
  }

  segments.push(`${currentLabel}${postFilters.join(',')}[video_out]`);
  return segments.join(';');
}

function buildVideoFilter(
  subtitles?: CaptureSubtitleTrack,
  transition?: CaptureTransition,
): string {
  const filters = ['pad=ceil(iw/2)*2:ceil(ih/2)*2'];

  if (subtitles?.mode === 'burn-in') {
    filters.push(buildBurnInSubtitleFilter(subtitles));
  }

  if (transition?.kind === 'fade-in') {
    filters.push(
      `fade=t=in:st=0:d=${formatFilterNumber(transition.durationSeconds)}`,
    );
  }

  return filters.join(',');
}

function buildBurnInSubtitleFilter(subtitles: CaptureSubtitleTrack): string {
  return `subtitles=filename='${escapeFfmpegFilterString(subtitles.sourcePath)}'`;
}

function buildAudioFilter(audio: CaptureAudioTrack): string {
  return `volume=${audio.volume.toFixed(3)},apad`;
}

function buildIntermediateFormatArgs(
  format: OutputFormat,
  audio: CaptureAudioTrack | undefined,
  subtitles: CaptureSubtitleTrack | undefined,
  videoEncoding?: CaptureVideoEncodingSettings,
): string[] {
  switch (format) {
    case 'mp4': {
      const args = [
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        videoEncoding?.preset ?? 'slow',
        '-crf',
        String(videoEncoding?.crf ?? 18),
        '-movflags',
        '+faststart',
      ];

      if (audio) {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }

      if (subtitles?.mode === 'soft') {
        args.push('-c:s', 'mov_text');
      }

      return args;
    }

    case 'webm': {
      const args = [
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-crf',
        '32',
        '-b:v',
        '0',
      ];

      if (audio) {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      }

      if (subtitles?.mode === 'soft') {
        args.push('-c:s', 'webvtt');
      }

      return args;
    }
  }
}

function buildFinalFormatArgs(
  format: OutputFormat,
  audio: CaptureAudioTrack | undefined,
  subtitles: CaptureSubtitleTrack | undefined,
  videoEncoding: FinalVideoEncodingSettings,
): string[] {
  switch (format) {
    case 'mp4': {
      if (videoEncoding.format !== 'mp4') {
        throw new Error('Final video settings do not match mp4 output format.');
      }

      const args = [
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        videoEncoding.preset,
        '-crf',
        String(videoEncoding.crf),
        '-movflags',
        '+faststart',
      ];

      if (audio) {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }

      if (subtitles?.mode === 'soft') {
        args.push('-c:s', 'mov_text');
      }

      return args;
    }

    case 'webm': {
      if (videoEncoding.format !== 'webm') {
        throw new Error(
          'Final video settings do not match webm output format.',
        );
      }

      const args = [
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-row-mt',
        '1',
        '-deadline',
        videoEncoding.deadline,
        '-crf',
        String(videoEncoding.crf),
        '-b:v',
        '0',
      ];

      if (audio) {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      }

      if (subtitles?.mode === 'soft') {
        args.push('-c:s', 'webvtt');
      }

      return args;
    }
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', args);
  } catch (error) {
    if (error instanceof Error) {
      const stderr = 'stderr' in error ? formatExecBuffer(error.stderr) : '';
      throw createEncoderError(error, stderr);
    }

    throw error;
  }
}

function validateCrossfadeDuration(
  clips: [ComposedVideoClip, ...ComposedVideoClip[]],
  durationSeconds: number,
): void {
  for (let index = 0; index < clips.length - 1; index += 1) {
    const left = clips[index];
    const right = clips[index + 1];
    const maxDuration = Math.min(left.durationSeconds, right.durationSeconds);

    if (durationSeconds >= maxDuration) {
      throw new Error(
        `Crossfade duration ${durationSeconds.toFixed(3)}s is too long for scene pair ${index + 1}-${index + 2}. Each adjacent scene must be longer than the crossfade.`,
      );
    }
  }
}

function escapeFfmpegFilterString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
}

function formatFilterNumber(value: number): string {
  return value.toFixed(3);
}

function formatExecBuffer(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').trim();
  }

  return '';
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFrameCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function createFfmpegPreflightError(
  error: Error & { code?: string | number | null },
): Error {
  if (error.code === 'ENOENT') {
    return new Error(
      [
        'FFmpeg is required but was not found in PATH.',
        '  macOS:   brew install ffmpeg',
        '  Ubuntu:  sudo apt install ffmpeg',
        '  Windows: winget install ffmpeg',
      ].join('\n'),
    );
  }

  return new Error(`Failed to execute FFmpeg: ${error.message}`);
}

function createEncoderError(error: Error, stderr: string): Error {
  if ('code' in error && error.code === 'ENOENT') {
    return new Error('FFmpeg not found. Please add ffmpeg to your PATH.');
  }

  const detail = stderr.trim();
  return new Error(detail ? `${error.message}\n${detail}` : error.message);
}

function formatCloseResult(result: EncoderCloseResult): string {
  if (result.signal) {
    return `signal: ${result.signal}`;
  }

  return `exit code: ${result.exitCode ?? 'null'}`;
}
