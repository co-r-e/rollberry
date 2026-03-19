import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface VideoEncoder {
  writeFrame(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
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

      ffmpeg.stdin.end();
      const [exitCode] = (await once(ffmpeg, 'close')) as [number | null];

      if (exitCode !== 0) {
        throw createEncoderError(
          new Error(
            `FFmpeg exited with error (exit code: ${exitCode ?? 'null'})`,
          ),
          stderr,
        );
      }
    },
  };
}

function createEncoderError(error: Error, stderr: string): Error {
  if ('code' in error && error.code === 'ENOENT') {
    return new Error('FFmpeg not found. Please add ffmpeg to your PATH.');
  }

  const detail = stderr.trim();
  return new Error(detail ? `${error.message}\n${detail}` : error.message);
}
