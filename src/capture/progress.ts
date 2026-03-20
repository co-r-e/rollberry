export interface ProgressReporter {
  onPageStart(pageIndex: number, totalPages: number, url: string): void;
  onFrameRendered(frameIndex: number, totalFrames: number): void;
  onPageComplete(pageIndex: number): void;
  onEncodeComplete(): void;
}

export function createProgressReporter(): ProgressReporter {
  const isTTY = process.stderr.isTTY === true;
  let lastUpdateTime = 0;
  let lastReportedMilestone = -1;

  function clearLine(): void {
    if (isTTY) {
      process.stderr.write('\r\x1b[K');
    }
  }

  return {
    onPageStart(pageIndex, totalPages, url) {
      clearLine();
      lastReportedMilestone = -1;
      const displayUrl = url.length > 60 ? `${url.slice(0, 57)}...` : url;
      process.stderr.write(
        `Capturing page ${pageIndex + 1}/${totalPages}: ${displayUrl}\n`,
      );
    },

    onFrameRendered(frameIndex, totalFrames) {
      const now = Date.now();
      const isLast = frameIndex + 1 === totalFrames;
      if (!isLast && now - lastUpdateTime < 100) {
        return;
      }
      lastUpdateTime = now;

      const progress = (frameIndex + 1) / totalFrames;
      const percent = Math.round(progress * 100);

      if (isTTY) {
        const barWidth = 20;
        const filled = Math.round(barWidth * progress);
        const bar = '#'.repeat(filled) + '-'.repeat(barWidth - filled);
        process.stderr.write(
          `\r  [${bar}] ${percent}% (${frameIndex + 1}/${totalFrames} frames)`,
        );
        if (isLast) {
          process.stderr.write('\n');
        }
      } else {
        const milestone = Math.floor(percent / 25) * 25;
        if (isLast || (milestone > lastReportedMilestone && milestone > 0)) {
          lastReportedMilestone = milestone;
          process.stderr.write(
            `  Progress: ${percent}% (${frameIndex + 1}/${totalFrames} frames)\n`,
          );
        }
      }
    },

    onPageComplete(_pageIndex) {
      // Line already advanced after last frame render
    },

    onEncodeComplete() {
      // Summary is printed by cli.ts
    },
  };
}
