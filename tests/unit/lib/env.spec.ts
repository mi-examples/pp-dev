import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPPDevEnv } from '../../../src/lib/env.js';

describe('loadPPDevEnv', () => {
  let rootA: string;
  let rootB: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-env-a-'));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-env-b-'));

    for (const key of ['MI_BACKEND_URL', 'MI_ACCESS_TOKEN', 'UNRELATED_VALUE']) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(rootA, { force: true, recursive: true });
    fs.rmSync(rootB, { force: true, recursive: true });

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('does not leak MI_ values from one project root into the next', () => {
    fs.writeFileSync(path.join(rootA, '.env'), 'MI_BACKEND_URL=https://a.example.com\nMI_ACCESS_TOKEN=token-a\n');
    fs.writeFileSync(path.join(rootB, '.env'), 'MI_BACKEND_URL=https://b.example.com\n');

    loadPPDevEnv('development', rootA);

    expect(process.env.MI_BACKEND_URL).toBe('https://a.example.com');
    expect(process.env.MI_ACCESS_TOKEN).toBe('token-a');

    loadPPDevEnv('development', rootB);

    expect(process.env.MI_BACKEND_URL).toBe('https://b.example.com');
    expect(process.env.MI_ACCESS_TOKEN).toBeUndefined();
  });

  it('drops a key that disappears from the env file on reload without touching unrelated process.env values', () => {
    process.env.UNRELATED_VALUE = 'keep-me';

    fs.writeFileSync(path.join(rootA, '.env'), 'MI_BACKEND_URL=https://a.example.com\nMI_ACCESS_TOKEN=token-a\n');
    loadPPDevEnv('development', rootA);
    expect(process.env.MI_ACCESS_TOKEN).toBe('token-a');

    fs.writeFileSync(path.join(rootA, '.env'), 'MI_BACKEND_URL=https://a.example.com\n');
    loadPPDevEnv('development', rootA);

    expect(process.env.MI_ACCESS_TOKEN).toBeUndefined();
    expect(process.env.MI_BACKEND_URL).toBe('https://a.example.com');
    expect(process.env.UNRELATED_VALUE).toBe('keep-me');
  });

  it('keeps MI_ values set in the real environment across loads (e.g. MI_ACCESS_TOKEN in CI)', () => {
    process.env.MI_ACCESS_TOKEN = 'from-ci';
    fs.writeFileSync(path.join(rootA, '.env'), 'MI_BACKEND_URL=https://a.example.com\n');

    loadPPDevEnv('development', rootA);
    loadPPDevEnv('development', rootA);
    loadPPDevEnv('development', rootB);

    expect(process.env.MI_ACCESS_TOKEN).toBe('from-ci');
    expect(process.env.MI_BACKEND_URL).toBeUndefined();
  });

  it('lets the real environment win over an env file', () => {
    process.env.MI_ACCESS_TOKEN = 'from-ci';
    fs.writeFileSync(path.join(rootA, '.env'), 'MI_ACCESS_TOKEN=from-file\n');

    loadPPDevEnv('development', rootA);
    loadPPDevEnv('development', rootA);

    expect(process.env.MI_ACCESS_TOKEN).toBe('from-ci');
  });
});
