import { describe, expect, it } from 'vitest';

import { resolvePlaywrightCliPath } from '../../src/capture/browser-install.js';

describe('resolvePlaywrightCliPath', () => {
  it('resolves the Playwright CLI entrypoint', () => {
    const cliPath = resolvePlaywrightCliPath();

    expect(cliPath).toMatch(/playwright\/cli\.js$/u);
  });
});
