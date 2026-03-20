import { execFile, spawn } from 'node:child_process';

const FFMPEG_ABORT_TIMEOUT_MS = 1_000;

interface EncoderCloseResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface VideoEncoder {
  writeFrame(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
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
}): Promise<VideoEncoder> {
  const ffmpeg = spawn(
    'ffmpeg',
    [
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
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-movflags',
      '+faststart',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      options.outPath,
    ],
    {
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );

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

  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk) => {
    stderr += chunk;
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
