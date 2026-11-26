import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ejs from 'ejs';
import {
  envVariableSuffix,
  normalizePPDevConfig,
  resolveMiEnvironment,
  validatePPDevConfig,
  type PPDevConfig,
} from '../../../src/lib/pp-dev-config.js';
import { applyEnvOption, applyPPConfigOption, cleanOptions, lastFlagValue } from '../../../src/lib/cli-options.js';
import { onProxyCacheInvalidate, useMiEnvironment } from '../../../src/lib/proxy-cache.middleware.js';
import { describeTokenSettings } from '../../../src/shared/mi-environments.js';

/**
 * PP-4840: several named MI environments (server URL, app id, token), chosen with `--env` / `MI_ENV`.
 * The top-level `mi` and `app` settings are the `default` one.
 */

const CONFIG: PPDevConfig = {
  mi: { url: 'https://dev.mi.example.com', token: 'DEV-TOKEN' },
  app: { id: 7 },
  envs: {
    staging: { url: 'https://staging.mi.example.com', appId: 42 },
    'customer-eu': { appId: 9 },
  },
};

describe('MI environments', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MI_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('resolveMiEnvironment', () => {
    it('is the top-level settings without --env, MI_ENV or defaultEnv', () => {
      expect(resolveMiEnvironment(CONFIG, {})).toEqual({
        url: 'https://dev.mi.example.com',
        appId: 7,
        token: 'DEV-TOKEN',
      });
    });

    it('keeps MI_BACKEND_URL and MI_ACCESS_TOKEN for the top-level settings', () => {
      expect(resolveMiEnvironment({ app: { id: 7 } }, { MI_BACKEND_URL: 'https://x', MI_ACCESS_TOKEN: 'T' })).toEqual({
        url: 'https://x',
        appId: 7,
        token: 'T',
      });
    });

    it('takes the environment MI_ENV names, its token from MI_ACCESS_TOKEN_<NAME>', () => {
      expect(resolveMiEnvironment(CONFIG, { MI_ENV: 'staging', MI_ACCESS_TOKEN_STAGING: 'STAGING-TOKEN' })).toEqual({
        name: 'staging',
        url: 'https://staging.mi.example.com',
        appId: 42,
        token: 'STAGING-TOKEN',
      });
    });

    it("prefers the environment's own token in the config", () => {
      const config: PPDevConfig = { ...CONFIG, envs: { staging: { url: 'https://s', token: 'CONFIG-TOKEN' } } };

      expect(resolveMiEnvironment(config, { MI_ENV: 'staging', MI_ACCESS_TOKEN_STAGING: 'X' }).token).toBe(
        'CONFIG-TOKEN',
      );
    });

    // The design: the dev token must not reach another host. Without its own token, the login page.
    it('never gives a named environment the top-level token, mi.token or MI_ACCESS_TOKEN', () => {
      expect(
        resolveMiEnvironment(CONFIG, { MI_ENV: 'staging', MI_ACCESS_TOKEN: 'DEFAULT-TOKEN' }).token,
      ).toBeUndefined();
    });

    it('takes the URL from MI_BACKEND_URL_<NAME>, and the app id from the top level', () => {
      expect(
        resolveMiEnvironment(CONFIG, { MI_ENV: 'customer-eu', MI_BACKEND_URL_CUSTOMER_EU: 'https://eu.example.com' }),
      ).toMatchObject({ name: 'customer-eu', url: 'https://eu.example.com', appId: 9 });

      const sameInstance: PPDevConfig = { ...CONFIG, envs: { other: { url: 'https://o' } } };

      expect(resolveMiEnvironment(sameInstance, { MI_ENV: 'other' }).appId).toBe(7);
    });

    // Review: a URL left out of `.env.local` pointed the environment, and a sync from it, at the
    // default MI. Another page on the default instance names that URL itself.
    it.each([
      ['none', {}],
      ['an empty MI_BACKEND_URL_<NAME>', { MI_BACKEND_URL_CUSTOMER_EU: '' }],
    ])('refuses a named environment with no URL of its own (%s), never taking mi.url', (_label, variables) => {
      expect(() =>
        resolveMiEnvironment(CONFIG, { MI_ENV: 'customer-eu', MI_BACKEND_URL: 'https://x', ...variables }),
      ).toThrow(
        'MI environment "customer-eu" has no URL: set envs.customer-eu.url or MI_BACKEND_URL_CUSTOMER_EU (the same URL as mi.url for another page on the default instance)',
      );
    });

    it('takes defaultEnv when MI_ENV names none, and MI_ENV over it', () => {
      const config: PPDevConfig = { ...CONFIG, defaultEnv: 'staging' };

      expect(resolveMiEnvironment(config, {}).name).toBe('staging');
      expect(
        resolveMiEnvironment(config, { MI_ENV: 'customer-eu', MI_BACKEND_URL_CUSTOMER_EU: 'https://eu' }).name,
      ).toBe('customer-eu');
      expect(resolveMiEnvironment(config, { MI_ENV: 'default' }).name).toBeUndefined();
    });

    it('ignores the spaces around MI_ENV, and an empty one', () => {
      expect(resolveMiEnvironment(CONFIG, { MI_ENV: ' staging ' }).name).toBe('staging');
      expect(resolveMiEnvironment(CONFIG, { MI_ENV: '' }).name).toBeUndefined();
    });

    it('refuses an environment that is not defined, listing those that are, instead of the default', () => {
      expect(() => resolveMiEnvironment(CONFIG, { MI_ENV: 'prod' })).toThrow(
        'Unknown MI environment "prod" (--env or MI_ENV). Defined: default, staging, customer-eu',
      );
    });

    it('refuses a defaultEnv that is not defined', () => {
      expect(() => resolveMiEnvironment({ ...CONFIG, defaultEnv: 'prod' }, { MI_ENV: 'staging' })).toThrow(
        'defaultEnv "prod" is not an environment',
      );
    });

    it('refuses envs.default: the top-level settings are the default environment', () => {
      expect(() => resolveMiEnvironment({ envs: { default: { url: 'https://x' } } }, {})).toThrow(
        'envs.default is reserved',
      );
    });

    it.each(['../x', 'a/b', '.hidden', 'with space', ''])('refuses the environment name %j', (name) => {
      expect(() => resolveMiEnvironment({ envs: { [name]: {} } }, {})).toThrow('an environment name takes');
    });

    it('refuses two names that read the same variables', () => {
      expect(() => resolveMiEnvironment({ envs: { 'eu-1': {}, eu_1: {} } }, {})).toThrow(
        'envs.eu-1 and envs.eu_1 would both read MI_ACCESS_TOKEN_EU_1',
      );
    });

    it('refuses an environment that is not an object', () => {
      expect(() => resolveMiEnvironment({ envs: { staging: 'https://x' as never } }, {})).toThrow(
        'envs.staging must be an object',
      );
    });
  });

  it('names the variables after the environment in upper case, other characters as _', () => {
    expect(envVariableSuffix('staging-eu')).toBe('STAGING_EU');
    expect(envVariableSuffix('Customer_2')).toBe('CUSTOMER_2');
  });

  // The users panel and its messages name these: a named environment's own, never the top-level ones.
  it('names where the token of an environment is set', () => {
    expect(describeTokenSettings()).toBe('mi.token or MI_ACCESS_TOKEN');
    expect(describeTokenSettings('staging-eu')).toBe('envs.staging-eu.token or MI_ACCESS_TOKEN_STAGING_EU');
  });

  // PP-4840 phase 2: Sync and Variables Editor saves ask for a confirmation in a protected environment.
  describe('protected', () => {
    const config = (mi: boolean | undefined, staging: boolean | undefined): PPDevConfig => ({
      mi: { url: 'https://dev', protected: mi },
      app: { id: 7 },
      envs: { staging: { url: 'https://staging', protected: staging }, dev: { url: 'https://dev2' } },
    });
    const protectedOf = (c: PPDevConfig, name?: string) =>
      resolveMiEnvironment(c, name ? { MI_ENV: name } : {}).protected ?? false;

    it('is off unless set', () => {
      expect(protectedOf(CONFIG)).toBe(false);
      expect(protectedOf(CONFIG, 'staging')).toBe(false);
    });

    it('protects the default environment with mi.protected, and the named ones that set nothing', () => {
      expect(protectedOf(config(true, undefined))).toBe(true);
      expect(protectedOf(config(true, undefined), 'dev')).toBe(true);
    });

    it("takes a named environment's own setting first, false included", () => {
      expect(protectedOf(config(true, false), 'staging')).toBe(false);
      expect(protectedOf(config(undefined, true), 'staging')).toBe(true);
      expect(protectedOf(config(undefined, true))).toBe(false);
    });

    it.each([
      [{ mi: { url: 'https://dev', protected: 'true' } }, 'mi.protected must be true or false, got "true"'],
      [
        { mi: { url: 'https://dev' }, envs: { staging: { url: 'https://s', protected: 1 } } },
        'envs.staging.protected must be true or false, got 1',
      ],
    ])("refuses a value that isn't true or false: %j", (c, message) => {
      // Any environment's: also one that isn't chosen.
      expect(() => resolveMiEnvironment(c as unknown as PPDevConfig, {})).toThrow(message);
    });

    it('gives the server envProtected', () => {
      process.env.MI_ENV = 'dev';

      expect(normalizePPDevConfig(config(true, false), 'my-app').envProtected).toBe(true);

      process.env.MI_ENV = 'staging';

      expect(normalizePPDevConfig(config(true, false), 'my-app').envProtected).toBe(false);
    });
  });

  describe('normalizePPDevConfig', () => {
    // PP-4840 phase 3: the browser keeps a session per MI instance; the default one's keeps MI's name.
    it("names the session cookie after the environment's MI instance", () => {
      const config: PPDevConfig = {
        ...CONFIG,
        envs: { ...CONFIG.envs, 'other-page': { url: 'https://dev.mi.example.com/', appId: 8 } },
      };

      expect(normalizePPDevConfig(config, 'my-app').sessionCookieName).toBe('metric_insights_session');

      process.env.MI_ENV = 'other-page';
      expect(normalizePPDevConfig(config, 'my-app').sessionCookieName).toBe('metric_insights_session');

      process.env.MI_ENV = 'staging';
      expect(normalizePPDevConfig(config, 'my-app').sessionCookieName).toBe(
        'metric_insights_session__staging_mi_example_com',
      );
    });

    it('leaves the top-level settings as they were', () => {
      const n = normalizePPDevConfig(CONFIG, 'my-app');

      expect(n).toMatchObject({
        backendBaseURL: 'https://dev.mi.example.com',
        appId: 7,
        personalAccessToken: 'DEV-TOKEN',
        syncBackupsDir: 'backups',
      });
      expect(n.envName).toBeUndefined();
    });

    it("gives the server the named environment's URL, app id and token, and its own backups folder", () => {
      process.env.MI_ENV = 'staging';
      process.env.MI_ACCESS_TOKEN_STAGING = 'STAGING-TOKEN';

      expect(normalizePPDevConfig(CONFIG, 'my-app')).toMatchObject({
        envName: 'staging',
        backendBaseURL: 'https://staging.mi.example.com',
        appId: 42,
        personalAccessToken: 'STAGING-TOKEN',
        syncBackupsDir: 'backups/staging',
      });
    });

    it('puts the backups folder of a named environment inside sync.backupsDir', () => {
      process.env.MI_ENV = 'staging';

      expect(normalizePPDevConfig({ ...CONFIG, sync: { backupsDir: 'out/backups/' } }, 'my-app').syncBackupsDir).toBe(
        'out/backups/staging',
      );
    });

    // Review of #402: `''` (the project root) gave `/staging`, outside the project.
    it.each([
      ['', 'staging'],
      ['.', './staging'],
      ['/', '/staging'],
    ])('keeps a sync.backupsDir of %j as relative as it is', (backupsDir, expected) => {
      process.env.MI_ENV = 'staging';

      expect(normalizePPDevConfig({ ...CONFIG, sync: { backupsDir } }, 'my-app').syncBackupsDir).toBe(expected);
    });
  });

  describe('validatePPDevConfig', () => {
    it('checks the app id of the environment in use, and says where it goes', () => {
      process.env.MI_ENV = 'other';

      expect(() =>
        validatePPDevConfig({ mi: { url: 'https://dev' }, envs: { other: { url: 'https://o' } } }, 'my-app'),
      ).toThrow('app.id (or envs.other.appId) is required when app.type is "template"');
    });

    it("takes a named environment's own app id", () => {
      process.env.MI_ENV = 'other';

      expect(() =>
        validatePPDevConfig({ mi: { url: 'https://dev' }, envs: { other: { url: 'https://o', appId: 3 } } }, 'my-app'),
      ).not.toThrow();
    });

    // A URL left out of `.env.local` by mistake would point the environment, and its sync, at the default MI.
    it('refuses a named environment with no URL of its own, as the dev server start does', () => {
      process.env.MI_ENV = 'customer-eu';

      expect(() => validatePPDevConfig(CONFIG, 'my-app')).toThrow('MI environment "customer-eu" has no URL');

      process.env.MI_BACKEND_URL_CUSTOMER_EU = 'https://eu.example.com';

      expect(() => validatePPDevConfig(CONFIG, 'my-app')).not.toThrow();
    });

    // Not chosen, it doesn't stop the start: a warning says it would.
    it('warns about the other environments with no URL of their own', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        validatePPDevConfig(CONFIG, 'my-app');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          '[pp-dev] envs.customer-eu has no URL (envs.customer-eu.url or MI_BACKEND_URL_CUSTOMER_EU): --env customer-eu would stop with an error',
        );

        warn.mockClear();
        process.env.MI_BACKEND_URL_CUSTOMER_EU = 'https://eu.example.com';
        validatePPDevConfig(CONFIG, 'my-app');

        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('refuses an unknown environment, as the dev server start does', () => {
      process.env.MI_ENV = 'prod';

      expect(() => validatePPDevConfig(CONFIG, 'my-app')).toThrow('Unknown MI environment "prod"');
    });

    // Review of #402: with `envs.staging` from `withPPDev()` in next.config, the supervisor's check of
    // the standalone file refused every change to it, and the dev server was never restarted.
    describe('a partial config (the standalone file next to withPPDev())', () => {
      const standalone: PPDevConfig = { mi: { url: 'https://dev' }, app: { id: 7 } };

      it('leaves an environment it does not define to the merged config', () => {
        process.env.MI_ENV = 'staging';

        expect(() => validatePPDevConfig(standalone, 'my-app', { partial: true })).not.toThrow();
        expect(() => validatePPDevConfig(standalone, 'my-app')).toThrow('Unknown MI environment "staging"');
      });

      it('leaves a defaultEnv it does not define to the merged config', () => {
        expect(() =>
          validatePPDevConfig({ ...standalone, defaultEnv: 'staging' }, 'my-app', { partial: true }),
        ).not.toThrow();
      });

      it('still checks the environments it defines, and the rest of the file', () => {
        process.env.MI_ENV = 'staging';

        expect(() =>
          validatePPDevConfig({ ...standalone, envs: { 'eu-1': {}, eu_1: {} } }, 'my-app', { partial: true }),
        ).toThrow('would both read MI_ACCESS_TOKEN_EU_1');
        expect(() =>
          validatePPDevConfig({ ...standalone, sync: { maxBackups: -1 } }, 'my-app', { partial: true }),
        ).toThrow('sync.maxBackups');
      });

      it('checks an environment it defines in full', () => {
        process.env.MI_ENV = 'staging';

        expect(() =>
          validatePPDevConfig({ ...standalone, envs: { staging: { appId: 3 } } }, 'my-app', { partial: true }),
        ).toThrow('MI environment "staging" has no URL');
      });
    });
  });

  describe('--env', () => {
    it('passes the name on as MI_ENV, over one already set', () => {
      const env: Record<string, string | undefined> = { MI_ENV: 'from-shell' };

      applyEnvOption(' staging ', env);

      expect(env.MI_ENV).toBe('staging');
    });

    it('takes a number cac parsed the name into', () => {
      const env: Record<string, string | undefined> = {};

      applyEnvOption(2, env);

      expect(env.MI_ENV).toBe('2');
    });

    it('leaves MI_ENV without --env', () => {
      const env: Record<string, string | undefined> = { MI_ENV: 'from-shell' };

      applyEnvOption(undefined, env);

      expect(env.MI_ENV).toBe('from-shell');
    });

    it.each([true, ''])('refuses --env without a name (%j)', (value) => {
      expect(() => applyEnvOption(value, {})).toThrow('--env needs the name of an environment');
    });

    it("stays out of Vite's server and build config", () => {
      expect(cleanOptions({ env: 'staging', ppConfig: 'x.ts', 'pp-config': 'x.ts', port: 1 })).toEqual({ port: 1 });
    });
  });

  describe('--pp-config', () => {
    it('passes the file on as PP_DEV_CONFIG, resolved against the current directory', () => {
      const env: Record<string, string | undefined> = {};

      applyPPConfigOption(' configs/staging.config.ts ', env, path.resolve('/work/app'));

      expect(env.PP_DEV_CONFIG).toBe(path.resolve('/work/app', 'configs/staging.config.ts'));
    });

    it('keeps the PP_DEV_CONFIG of the shell without --pp-config', () => {
      const env: Record<string, string | undefined> = { PP_DEV_CONFIG: path.resolve('/x.ts') };

      applyPPConfigOption(undefined, env);

      expect(env.PP_DEV_CONFIG).toBe(path.resolve('/x.ts'));
    });

    // Review of #402: a sync's build runs in the project root, where a relative one names another file.
    it('makes a relative PP_DEV_CONFIG of the shell absolute, for the processes pp-dev starts elsewhere', () => {
      const env: Record<string, string | undefined> = { PP_DEV_CONFIG: './configs/staging.ts' };

      applyPPConfigOption(undefined, env, path.resolve('/work'));

      expect(env.PP_DEV_CONFIG).toBe(path.resolve('/work', 'configs/staging.ts'));
    });

    it('takes the last of a repeated --pp-config', () => {
      const env: Record<string, string | undefined> = {};

      applyPPConfigOption(['a.ts', 'b.ts'], env, path.resolve('/work'));

      expect(env.PP_DEV_CONFIG).toBe(path.resolve('/work', 'b.ts'));
    });

    it.each([true, ''])('refuses --pp-config without a file (%j)', (value) => {
      expect(() => applyPPConfigOption(value, {})).toThrow('--pp-config needs the path of a pp-dev config file');
    });
  });

  // Review of #402: cac turned `--env 01` into the number 1 (another environment's name), and a
  // repeated flag (`npm run dev -- --env staging` over a script's `--env dev`) into an array.
  describe('lastFlagValue', () => {
    it.each<[string, string[], string | true | undefined]>([
      ['a value that looks like a number, as typed', ['--env', '01'], '01'],
      ['the last of a repeated flag', ['--env', 'dev', '--port', '1', '--env', 'staging'], 'staging'],
      ['--name=value', ['--env=staging'], 'staging'],
      ['true for a flag without a value', ['--env', '--port', '1'], true],
      ['true for the last argument', ['serve', '--env'], true],
      ['nothing without the flag', ['--environment', 'x'], undefined],
      ['nothing after --', ['--', '--env', 'x'], undefined],
    ])('reads %s', (_label, argv, expected) => {
      expect(lastFlagValue(argv, ['env'])).toBe(expected);
    });

    it('reads any of the names, the last one written counting', () => {
      expect(lastFlagValue(['--pp-config', 'a.ts', '--ppConfig', 'b.ts'], ['pp-config', 'ppConfig'])).toBe('b.ts');
    });

    it('gives --env the last value, kept as a string', () => {
      const env: Record<string, string | undefined> = {};

      applyEnvOption(lastFlagValue(['--env', 'dev', '--env', '01'], ['env']), env);

      expect(env.MI_ENV).toBe('01');
    });

    it('takes the last of an array --env', () => {
      const env: Record<string, string | undefined> = {};

      applyEnvOption(['dev', 'staging'], env);

      expect(env.MI_ENV).toBe('staging');
    });
  });

  // A Vite dev server restarts in the same process: what the previous environment cached, the page
  // data included, was served for up to the cache TTL.
  describe('useMiEnvironment', () => {
    it('drops the cache when the environment changes, not on a restart with the same one', () => {
      useMiEnvironment({ url: 'https://dev', appId: 7 });

      const dropped = vi.fn();
      const unsubscribe = onProxyCacheInvalidate(dropped);

      try {
        useMiEnvironment({ url: 'https://dev/', appId: 7 });
        expect(dropped).not.toHaveBeenCalled();

        useMiEnvironment({ name: 'staging', url: 'https://staging', appId: 42 });
        expect(dropped).toHaveBeenCalledTimes(1);

        // Another page on the same instance.
        useMiEnvironment({ name: 'staging', url: 'https://staging', appId: 43 });
        expect(dropped).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('dev panel', () => {
    const template = ejs.compile(fs.readFileSync(path.resolve('src/client/index.html'), 'utf8'), {
      openDelimiter: '{',
      closeDelimiter: '}',
      rmWhitespace: true,
    });
    const render = (envName: string) =>
      template({
        PACKAGE_NAME: '@metricinsights/pp-dev',
        VERSION: '0.0.0',
        envName,
        backendBaseURL: 'https://staging.mi.example.com',
        templateLess: false,
        appId: 42,
        canSync: true,
        devPanelPosition: 'bottom-right',
        devPanelHidden: false,
        devPanelAutoHide: false,
      }) as string;

    it('names a named environment', () => {
      expect(render('staging')).toMatch(/Environment:<\/span>\s*<span class="[^"]*pp-dev-info__env">staging<\/span>/);
    });

    it('shows no environment for the top-level settings', () => {
      expect(render('')).not.toContain('Environment:');
    });
  });
});
