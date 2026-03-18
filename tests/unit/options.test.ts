import { describe, expect, it } from 'vitest';

import { CliError, parseCliArgs } from '../../src/options.js';

describe('parseCliArgs', () => {
  it('parses localhost capture options', () => {
    const options = parseCliArgs([
      'capture',
      'https://localhost:3000',
      '--out',
      'artifacts/demo.mp4',
      '--viewport',
      '1280x720',
      '--fps',
      '30',
      '--duration',
      '5',
      '--motion',
      'linear',
      '--wait-for',
      'selector:#app',
      '--hide-selector',
      '#cookie-banner',
      '--hide-selector',
      '.chat-widget',
      '--debug-frames-dir',
      'artifacts/frames',
    ]);

    expect(options.urls[0]?.toString()).toBe('https://localhost:3000/');
    expect(options.outPath).toMatch(/artifacts\/demo\.mp4$/u);
    expect(options.manifestPath).toMatch(/artifacts\/demo\.manifest\.json$/u);
    expect(options.logFilePath).toMatch(/artifacts\/demo\.log\.jsonl$/u);
    expect(options.viewport).toEqual({ width: 1280, height: 720 });
    expect(options.fps).toBe(30);
    expect(options.duration).toBe(5);
    expect(options.motion).toBe('linear');
    expect(options.waitFor).toEqual({
      kind: 'selector',
      selector: '#app',
    });
    expect(options.hideSelectors).toEqual(['#cookie-banner', '.chat-widget']);
    expect(options.pageGapSeconds).toBe(0);
    expect(options.debugFramesDir).toMatch(/artifacts\/frames$/u);
  });

  it('rejects unsupported protocols', () => {
    expect(() => parseCliArgs(['capture', 'file:///tmp/demo.html'])).toThrow(
      CliError,
    );
  });

  it('parses multiple URLs', () => {
    const options = parseCliArgs([
      'capture',
      'https://example.com',
      'https://example.com/about',
      'https://example.com/contact',
    ]);

    expect(options.urls).toHaveLength(3);
    expect(options.urls[0]?.toString()).toBe('https://example.com/');
    expect(options.urls[1]?.toString()).toBe('https://example.com/about');
    expect(options.urls[2]?.toString()).toBe('https://example.com/contact');
  });

  it('parses --page-gap option', () => {
    const options = parseCliArgs([
      'capture',
      'https://example.com',
      'https://example.com/about',
      '--page-gap',
      '1.5',
    ]);

    expect(options.pageGapSeconds).toBe(1.5);
  });

  it('rejects negative --page-gap', () => {
    expect(() =>
      parseCliArgs(['capture', 'https://example.com', '--page-gap=-1']),
    ).toThrow(CliError);
  });

  it('allows overriding manifest and log file paths', () => {
    const options = parseCliArgs([
      'capture',
      'http://localhost:3000',
      '--out',
      'artifacts/demo.mp4',
      '--manifest',
      'logs/custom-manifest.json',
      '--log-file',
      'logs/custom-log.jsonl',
    ]);

    expect(options.manifestPath).toMatch(/logs\/custom-manifest\.json$/u);
    expect(options.logFilePath).toMatch(/logs\/custom-log\.jsonl$/u);
  });
});
