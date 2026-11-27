import * as path from 'path';
import { createLogger } from './logger.js';
import { colors, getTokenErrorInfo, logTokenError } from './helpers/index.js';
import { isUnavailableJsonApiError } from '../api/unavailable-json-api.js';
import { DistService, TEMPLATE_VARIABLES_FILE_NAME } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import { Logger, ViteDevServer, WebSocketClient } from 'vite';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { type ProtectedEnvironment, describeEnvironment } from './protected-environment.js';
import { DEFAULT_ENV_NAME, type EnvironmentChoice } from './pp-dev-config.js';
import { requestEnvSwitch, setEnvSwitchFailure } from './env-switch.js';
import {
  type EnvSwitchFailedPayload,
  type EnvSwitchPayload,
  SYNC_IN_PROGRESS_CODE,
  type SyncActionRequiredPayload,
  type SyncActionResponsePayload,
  type TemplateSyncResponsePayload,
} from '../shared/ws-messages.js';

export { SYNC_IN_PROGRESS_CODE };

const DEFAULT_SYNC_ACTION_TIMEOUT_MS = 120_000;

/** What MI answered an upload with, for the error message: its JSON, or the head of a text body. */
function describeUploadAnswer(answer: unknown): string {
  if (typeof answer === 'string') {
    const text = answer.replace(/\s+/g, ' ').trim();

    return `with a non-JSON body: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
  }

  if (answer && typeof answer === 'object') {
    return `with ${JSON.stringify(answer).slice(0, 200)}`;
  }

  return `with ${String(answer)}`;
}

/** Why a sync's dialog ended without a confirmation: the user's answer, or none that could come. */
export type SyncCancelReason = 'cancelled' | 'timeout' | 'disconnected' | 'shutdown';

/** The answer to a `template:sync:action-required` dialog. */
export type SyncActionAnswer = { approved: true } | { approved: false; reason: SyncCancelReason };

export interface ClientServiceOptions {
  distService?: DistService;
  miAPI?: MiAPI;
  /**
   * Max time to wait for the browser to respond to `template:sync:action-required`.
   * After this, the pending promise resolves to a `'timeout'` answer and the resolver is removed.
   * @default 120_000
   */
  syncActionTimeoutMs?: number;
  /** Set when the environment is `protected`: a sync asks for a confirmation that names it. */
  protectedEnvironment?: ProtectedEnvironment;
  /** The environment in use and the ones the panel may switch to (PP-4840 phase 4). */
  environments?: { current: string; choices: EnvironmentChoice[] };
}

export class ClientService {
  private readonly server: ViteDevServer;
  private readonly opts: ClientServiceOptions;
  private readonly eventMap: Map<string, (this: ClientService, ...attrs: any[]) => void>;

  private logger: Logger;
  /** The running template sync, if any (see `onTemplateSync`). */
  private syncInFlight: Promise<void> | null = null;
  private readonly syncActionResolvers = new Map<
    string,
    { resolve: (answer: SyncActionAnswer) => void; timeoutId: ReturnType<typeof setTimeout>; cleanup: () => void }
  >();

  constructor(server: ViteDevServer, opts?: ClientServiceOptions) {
    this.server = server;
    this.opts = opts || {};

    this.eventMap = new Map<string, (this: ClientService, ...attrs: any[]) => void>();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));
    this.eventMap.set('template:sync', this.onTemplateSync.bind(this));
    this.eventMap.set('template:sync:action-response', this.onTemplateSyncActionResponse.bind(this));
    this.eventMap.set('page-variables:reload', this.onPageVariablesReload.bind(this));
    this.eventMap.set('env:switch', this.onEnvSwitch.bind(this));

    this.logger = createLogger();

    this.init();
  }

  init() {
    const { ws } = this.server;

    for (const [event, handler] of this.eventMap) {
      ws.on(event, handler);
    }

    ws.on('error', () => {
      this.clearAllPendingSyncActions('disconnected');
    });
  }

  /**
   * The dev server shuts down: no dialog can be answered any more, and a running sync's build must
   * not outlive it. Called by whoever closes the server (the Vite plugin's `closeBundle`, `pp-dev
   * next`'s restart and shutdown). Not a WebSocket `close` listener: Vite takes `ws.on('close')` for
   * a message any page could send, and never calls it on shutdown.
   */
  dispose() {
    this.clearAllPendingSyncActions('shutdown');
    this.opts.distService?.stopBuilds();
  }

  private resolveSyncAction(requestId: string, answer: SyncActionAnswer) {
    const entry = this.syncActionResolvers.get(requestId);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timeoutId);
    entry.cleanup();
    this.syncActionResolvers.delete(requestId);
    entry.resolve(answer);
  }

  /** Ends every open dialog with `reason`, clearing its timeout: the dev server or its WebSocket is going. */
  private clearAllPendingSyncActions(reason: SyncCancelReason) {
    for (const requestId of [...this.syncActionResolvers.keys()]) {
      this.resolveSyncAction(requestId, { approved: false, reason });
    }
  }

  /** What the panel and the terminal are told when a sync ends on a dialog without a confirmation. */
  private describeSyncCancel(reason: SyncCancelReason): string {
    switch (reason) {
      case 'cancelled':
        return 'Sync cancelled by user.';
      case 'timeout': {
        const seconds = Math.round((this.opts.syncActionTimeoutMs ?? DEFAULT_SYNC_ACTION_TIMEOUT_MS) / 1000);

        return `Sync cancelled: its dialog was not answered within ${seconds} s.`;
      }
      case 'disconnected':
        return 'Sync cancelled: the tab that started it lost its connection to the dev server.';
      case 'shutdown':
        return 'Sync cancelled: the dev server is shutting down.';
    }
  }

  /**
   * Ends the sync on a dialog's answer that is not a confirmation. The backup is saved before the
   * dialogs about it; the one of a protected environment comes before anything is read from MI.
   */
  private cancelSync(client: WebSocketClient, reason: SyncCancelReason, { backupSaved = true } = {}) {
    const description = this.describeSyncCancel(reason);

    this.sendSyncResponse(client, {
      cancelled: true,
      message: backupSaved ? `${description} Backup was saved.` : description,
    });
    this.logger.info(colors.yellow(description));
  }

  /** Tells the panel how its sync ended, in the shape it reads (`src/shared/ws-messages.ts`). */
  private sendSyncResponse(client: WebSocketClient, payload: TemplateSyncResponsePayload) {
    client.send('template:sync:response', payload);
  }

  /** A switch asked for and not yet failed: one at a time. */
  private switching: string | null = null;

  /**
   * The panel asks to restart the dev server in another MI environment (PP-4840 phase 4). Only a
   * name of the server's own config is taken, with a URL; not while a sync runs, which the restart
   * would end. Every tab is told first, and told again if the restart failed and this server stays.
   */
  async onEnvSwitch(data: unknown, client: WebSocketClient) {
    const name = (data as Partial<EnvSwitchPayload> | undefined)?.name;
    const { environments } = this.opts;
    const refuse = (error: string) => {
      client.send('env:switch:failed', { name: String(name), error } satisfies EnvSwitchFailedPayload);
    };

    if (!environments) {
      refuse('This dev server cannot switch environments.');

      return;
    }

    const choice = environments.choices.find((entry) => entry.name === name);

    if (typeof name !== 'string' || !choice) {
      refuse(`There is no MI environment ${JSON.stringify(name)} in the config.`);

      return;
    }

    if (!choice.hasUrl) {
      refuse(`The MI environment ${name} has no URL: set envs.${name}.url or its MI_BACKEND_URL_ variable.`);

      return;
    }

    if (name === environments.current) {
      refuse(`The dev server already works with ${name}.`);

      return;
    }

    if (this.syncInFlight) {
      refuse('A template sync is running: switch once it has finished.');

      return;
    }

    if (this.switching) {
      refuse(`A switch to ${this.switching} is under way.`);

      return;
    }

    this.switching = name;
    setEnvSwitchFailure(undefined);
    this.logger.info(colors.blue(`🧭 Switching to the MI environment ${name}, as the dev panel asked`));
    this.server.ws.send('env:switching', { name } satisfies EnvSwitchPayload);

    const result = await requestEnvSwitch(name);

    this.switching = null;

    if (!result.ok) {
      this.reportEnvSwitchFailure(name, result.error);
    }
  }

  /**
   * A switch failed and this server stays: every tab is told, and the tabs that ask the server
   * (`GET /@api/environment`) too, since the one answering them may have been started again after
   * the failed restart, without this WebSocket. Also for a switch another server process asked for
   * (`pp-dev next`: one a restart stopped while the switch waited).
   */
  reportEnvSwitchFailure(name: string, error: string): void {
    const current = this.opts.environments?.current;

    this.logger.error(
      colors.red(`❌ The switch to ${name} failed${current ? `, the dev server keeps ${current}` : ''}: ${error}`),
    );
    setEnvSwitchFailure({ name, error });
    this.server.ws.send('env:switch:failed', { name, error } satisfies EnvSwitchFailedPayload);
  }

  onInfoDataRequest(_data: unknown, client: WebSocketClient) {
    client.send('info-data:response', {});
  }

  onTemplateSyncActionResponse(payload?: SyncActionResponsePayload) {
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.approved !== 'boolean') {
      return;
    }

    this.resolveSyncAction(
      payload.requestId,
      payload.approved ? { approved: true } : { approved: false, reason: 'cancelled' },
    );
  }

  async requestSyncAction(
    payload: Omit<SyncActionRequiredPayload, 'requestId'>,
    client: WebSocketClient,
  ): Promise<SyncActionAnswer> {
    const requestId = randomUUID();
    const timeoutMs = this.opts.syncActionTimeoutMs ?? DEFAULT_SYNC_ACTION_TIMEOUT_MS;

    return await new Promise<SyncActionAnswer>((resolve) => {
      const cancel = (reason: SyncCancelReason) => this.resolveSyncAction(requestId, { approved: false, reason });
      const timeoutId = setTimeout(() => cancel('timeout'), timeoutMs);
      // A tab closed while its dialog is open will never answer: cancel the sync at once instead of
      // keeping every other sync blocked until the timeout.
      const { socket } = client as Partial<Pick<WebSocketClient, 'socket'>>;
      const onClose = () => cancel('disconnected');

      socket?.once('close', onClose);
      this.syncActionResolvers.set(requestId, { resolve, timeoutId, cleanup: () => socket?.off('close', onClose) });

      if (socket && socket.readyState !== socket.OPEN) {
        cancel('disconnected');

        return;
      }

      client.send('template:sync:action-required', {
        ...payload,
        requestId,
      } satisfies SyncActionRequiredPayload);
    });
  }

  /**
   * One sync at a time: a second click, a second tab, or a click the panel replays after a
   * reconnect would otherwise start a second build into the same `dist`/`.next` and a second
   * upload to MI while the first is still running.
   */
  async onTemplateSync(data: unknown, client: WebSocketClient) {
    // The restart would end it, the backup half-saved or the upload half-sent.
    if (this.switching) {
      this.sendSyncResponse(client, {
        error: `The dev server is switching to the MI environment ${this.switching}: sync once it has restarted.`,
      });

      return;
    }

    if (this.syncInFlight) {
      this.logger.warn(colors.yellow('Template sync requested while another one is running; ignored'));

      this.sendSyncResponse(client, {
        error:
          'A template sync is already running. Wait for it to finish, or answer its dialog in the tab that started it.',
        code: SYNC_IN_PROGRESS_CODE,
      });

      return;
    }

    const sync = this.runTemplateSync(data, client);

    this.syncInFlight = sync;

    try {
      await sync;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async runTemplateSync(_data: unknown, client: WebSocketClient) {
    if (this.opts.distService && this.opts.miAPI) {
      const { distService, miAPI } = this.opts;

      try {
        if (this.server.config.clientInjectionPlugin?.v7Features) {
          if (!miAPI?.isV710OrHigher) {
            this.sendSyncResponse(client, {
              error: 'This feature is available only for MI v7.1.0 or higher',
              config: {
                canSync: false,
              },
            });

            return;
          } else {
            client.send('client:config:update', {
              config: {
                canSync: true,
              },
            });
          }
        }

        // Before anything is read from MI or saved: the dialog names the environment this server works
        // with now, whatever the tab was opened with.
        const { protectedEnvironment } = this.opts;

        if (protectedEnvironment) {
          const where = describeEnvironment(protectedEnvironment);
          const confirmed = await this.requestSyncAction(
            {
              title: 'Protected MI environment',
              content: `Sync uploads the template to ${where}. This environment is protected: sync to it?`,
              confirmText: `Sync to ${protectedEnvironment.name ?? DEFAULT_ENV_NAME}`,
              cancelText: 'Cancel sync',
            },
            client,
          );

          if (!confirmed.approved) {
            this.cancelSync(client, confirmed.reason, { backupSaved: false });

            return;
          }

          this.logger.info(colors.yellow(`Sync to the protected MI environment ${where} confirmed`));
        }

        const currentAssets = await miAPI.getAssets().catch(async (err: unknown) => {
          if (await this.reportMiFailure(client, err)) {
            return err as Error;
          }

          throw err;
        });

        if (currentAssets instanceof Error) {
          return;
        }

        let newAssets: Buffer | Error | undefined;

        if (currentAssets) {
          // An analysis that fails ends the sync as a failed build does, with its message.
          const backupAnalysis = await distService?.analyzeBackup(currentAssets).catch((err: Error) => err);

          if (backupAnalysis instanceof Error) {
            newAssets = backupAnalysis;
          } else if (backupAnalysis) {
            await distService?.saveBackup(currentAssets, backupAnalysis);

            /** Only `__template_variables.json` differs from VERSION — show replace/keep modal only (no VERSION / BUILD-MANIFEST prompts). */
            const onlyTemplateVariablesMismatch =
              backupAnalysis.unknownFiles.length === 0 &&
              backupAnalysis.versionManifestHashMismatches.length === 1 &&
              path.basename(backupAnalysis.versionManifestHashMismatches[0].relativePath) ===
                TEMPLATE_VARIABLES_FILE_NAME;

            const mm = backupAnalysis.versionManifestHashMismatches;
            const templateVarMismatches = mm.filter(
              (m) => path.basename(m.relativePath) === TEMPLATE_VARIABLES_FILE_NAME,
            );
            const otherManifestMismatches = mm.filter(
              (m) => path.basename(m.relativePath) !== TEMPLATE_VARIABLES_FILE_NAME,
            );

            /** `__template_variables.json` and at least one other path both mismatch VERSION — template modal first, then VERSION list for the rest only. */
            const mixedTemplateAndOthers =
              !onlyTemplateVariablesMismatch && templateVarMismatches.length > 0 && otherManifestMismatches.length > 0;

            const pathsForVersionModal = onlyTemplateVariablesMismatch
              ? []
              : otherManifestMismatches.map((m) => m.relativePath);

            /** Whether the sync goes on: a dialog nobody answered stops it, as the other dialogs do. */
            const promptReplaceTemplateVariables = async (): Promise<boolean> => {
              if (!backupAnalysis.templateVariables || !distService) {
                return true;
              }

              const { templateVariables } = backupAnalysis;
              const localHash = await distService.getPublicTemplateVariablesHash();
              const serverPreferredHash = templateVariables.actualHash;

              if (localHash !== serverPreferredHash) {
                const replaceFromServer = await this.requestSyncAction(
                  {
                    title: 'Template variables (server backup)',
                    content:
                      'The server backup includes __template_variables.json. It differs from your local public/__template_variables.json (or that file is missing). Replace your project copy with the server backup?',
                    confirmText: 'Replace from server',
                    cancelText: 'Keep local',
                  },
                  client,
                );

                if (replaceFromServer.approved) {
                  await distService.saveTemplateVariablesFile(templateVariables.content);
                } else if (replaceFromServer.reason !== 'cancelled') {
                  // A timeout, a closed tab, a stopping server: not "Keep local", which went on to
                  // build and upload the local variables with nobody having answered.
                  this.cancelSync(client, replaceFromServer.reason);

                  return false;
                }
              }

              return true;
            };

            if (backupAnalysis.unknownFiles.length > 0) {
              const shouldContinueSync = await this.requestSyncAction(
                {
                  title: 'Unknown files found in backup',
                  content: `Backup contains files not listed in VERSION: ${backupAnalysis.unknownFiles.join(', ')}. Continue sync or cancel?`,
                  confirmText: 'Continue sync',
                  cancelText: 'Cancel sync',
                },
                client,
              );

              if (!shouldContinueSync.approved) {
                this.cancelSync(client, shouldContinueSync.reason);

                return;
              }
            }

            if (mixedTemplateAndOthers && !(await promptReplaceTemplateVariables())) {
              return;
            }

            if (!onlyTemplateVariablesMismatch && pathsForVersionModal.length > 0) {
              const maxPaths = 40;
              const paths = pathsForVersionModal;
              const listed = paths.slice(0, maxPaths);
              const remainder = paths.length - listed.length;
              const fileList = listed.map((p) => `• ${p}`).join('\n');
              const suffix = remainder > 0 ? `\n... and ${remainder} more file${remainder === 1 ? '' : 's'}` : '';

              const shouldContinueAfterVersionMismatch = await this.requestSyncAction(
                {
                  title: 'VERSION manifest out of date',
                  content: `These files no longer match the hashes recorded in the VERSION manifest:\n\n${fileList}${suffix}\n\nCancel sync, or override and continue using the files on disk?`,
                  confirmText: 'Override and continue',
                  cancelText: 'Cancel sync',
                },
                client,
              );

              if (!shouldContinueAfterVersionMismatch.approved) {
                this.cancelSync(client, shouldContinueAfterVersionMismatch.reason);

                return;
              }
            }

            // Fingerprint vs BUILD-MANIFEST: only if there was no per-file VERSION dialog (that already means "override")
            if (
              !onlyTemplateVariablesMismatch &&
              backupAnalysis.buildManifestMismatch &&
              backupAnalysis.versionManifestHashMismatches.length === 0
            ) {
              const { expected, actual } = backupAnalysis.buildManifestMismatch;

              const shouldContinueAfterMismatch = await this.requestSyncAction(
                {
                  title: 'Build manifest fingerprint mismatch',
                  content: `The recomputed backup fingerprint does not match BUILD-MANIFEST.json.\nManifest: ${expected.slice(0, 12)}...\nComputed: ${actual.slice(0, 12)}...\nContinue sync anyway?`,
                  confirmText: 'Continue sync',
                  cancelText: 'Cancel sync',
                },
                client,
              );

              if (!shouldContinueAfterMismatch.approved) {
                this.cancelSync(client, shouldContinueAfterMismatch.reason);

                return;
              }
            }

            if (!mixedTemplateAndOthers && !(await promptReplaceTemplateVariables())) {
              return;
            }

            newAssets = await distService?.buildNewAssets();
          }
        } else {
          newAssets = await distService?.buildNewAssets();
        }

        if (newAssets && newAssets instanceof Buffer) {
          // Built, but the dev server is shutting down (or restarting, with a sync of its own to come):
          // nothing is uploaded from here any more.
          if (distService.stopped) {
            this.sendSyncResponse(client, { error: 'Sync stopped: the dev server is shutting down.' });
            this.logger.warn(colors.yellow('Sync stopped before the upload: the dev server is shutting down'));

            return;
          }

          let updateResult: Awaited<ReturnType<MiAPI['updateAssets']>>;

          try {
            updateResult = await miAPI.updateAssets(newAssets);
          } catch (error) {
            // An MI session that expired during a long build, or MI gone down meanwhile, is reported
            // as it is for the download, not as a bare "Request failed with status code 412".
            if (await this.reportMiFailure(client, error)) {
              return;
            }

            throw error;
          }

          if (updateResult?.status === 'OK') {
            // The meta is `{}` until a first backup is saved (a page with no assets on MI yet).
            const backupMeta = distService?.getBackupMeta();

            this.sendSyncResponse(client, {
              // Now, not the last backup's date: a backup the same as the last one is not saved
              // again, and the panel then showed that one's date as the sync's.
              syncedAt: new Date().toISOString(),
              backupFilename: backupMeta?.lastBackupName ?? '',
            });

            this.logger.info(colors.green('Template synced'));
          } else {
            // A 200 without the `{ status: 'OK' }` an upload ends with: MI's maintenance page (HTML)
            // or a JSON error of its own. The answer is the only clue, so it goes along.
            const error = `Failed to update assets: MI answered ${describeUploadAnswer(updateResult)}`;

            this.sendSyncResponse(client, { error });
            this.logger.error(colors.red(error));
          }
        } else {
          if (newAssets instanceof Error) {
            this.sendSyncResponse(client, {
              error: newAssets.message,
            });

            this.logger.error(colors.red(newAssets.message));

            return;
          }

          this.sendSyncResponse(client, {
            error: 'Failed to build new assets',
          });

          this.logger.error(colors.red('Failed to build new assets'));

          return;
        }
      } catch (syncError: unknown) {
        const message = syncError instanceof Error ? syncError.message : 'Template sync failed';

        this.logger.error(colors.red(`Template sync failed: ${message}`));

        this.sendSyncResponse(client, {
          error: message,
          code: 'SYNC_FAILED',
        });

        return;
      }
    } else {
      this.sendSyncResponse(client, {
        error: 'Dist service or MiAPI is not defined',
      });

      this.logger.error(colors.red('Dist service or MiAPI is not defined'));

      return;
    }
  }

  /**
   * Tells the panel about an MI request that failed for a reason the sync can't help: credentials
   * that expired (with `refresh`), MI down or in maintenance (also behind a 200 with an HTML body).
   * `false` when it is none of those, and the caller reports it as a failed sync.
   */
  private async reportMiFailure(client: WebSocketClient, err: unknown): Promise<boolean> {
    if (isAxiosError(err)) {
      const errorInfo = getTokenErrorInfo(err);

      if (errorInfo.code === 'SESSION_EXPIRED') {
        this.logger.info(colors.yellow('Session expired - attempting to validate credentials'));

        // Without an API token the sync goes as your login on localhost (PP-4602), from any tab: a
        // saved user's tab must not take "Session expired" for its own and log in there.
        const localhostLogin = this.opts.miAPI?.personalAccessToken
          ? undefined
          : 'Your MI session on localhost ended: log in again on localhost, then sync again.';
        // Reloading this tab doesn't log in on localhost, and would take the message away at once.
        const refresh = localhostLogin === undefined;

        // Try to validate credentials to get more specific error information
        try {
          const validation = await this.opts.miAPI?.validateCredentials();

          if (validation && !validation.isValid) {
            this.logger.error(colors.red(`Authentication error: ${validation.error}`));
            this.sendSyncResponse(client, {
              error: localhostLogin ?? validation.error ?? 'Authentication failed',
              code: validation.code,
              refresh,
            });
          } else {
            this.logger.info(colors.yellow('Session expired'));
            this.sendSyncResponse(client, {
              error: localhostLogin ?? 'Session expired',
              code: 'SESSION_EXPIRED',
              refresh,
            });
          }
        } catch {
          this.logger.info(colors.yellow('Session expired'));
          this.sendSyncResponse(client, {
            error: localhostLogin ?? 'Session expired',
            code: 'SESSION_EXPIRED',
            refresh,
          });
        }

        return true;
      }

      // Get Address Info error (server in maintenance mode, VPN connection is needed or no internet connection)
      if (
        err.cause instanceof Error &&
        ((err.cause as { code: string } & Error).code === 'ECONNRESET' ||
          (err.cause as { code: string } & Error).code === 'ENOTFOUND')
      ) {
        this.logger.info(
          colors.yellow('Server in maintenance mode, VPN connection is needed or no internet connection'),
        );

        this.sendSyncResponse(client, {
          error: 'Server in maintenance mode, VPN connection is needed or no internet connection',
          code: 'CONNECTION_ERROR',
        });

        return true;
      }

      // HTTP gateway / maintenance (explicit status)
      const httpStatus = err.response?.status;

      if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
        this.logger.info(
          colors.yellow(`Server in maintenance mode or unreachable (HTTP ${httpStatus}); VPN may be required`),
        );

        this.sendSyncResponse(client, {
          error: 'Server in maintenance mode, VPN connection is needed or no internet connection',
          code: 'CONNECTION_ERROR',
        });

        return true;
      }
    }

    // PageAPI / PageTemplateAPI: 200 + HTML / non-JSON → plain Error (not axios)
    if (isUnavailableJsonApiError(err)) {
      this.logger.info(
        colors.yellow(
          'Server in maintenance mode or non-JSON page / page-template API response (unavailable HTML body)',
        ),
      );

      this.sendSyncResponse(client, {
        error: 'Server in maintenance mode, VPN connection is needed or no internet connection',
        code: 'CONNECTION_ERROR',
      });

      return true;
    }

    return false;
  }

  /**
   * Force-refetches live page variables right now (bypassing `load-pp-data.middleware.ts`'s
   * page-data cache), so `[VarName]` substitution reflects a just-saved value without waiting
   * for the cache to expire or restarting the dev server. The client reloads the browser page
   * on success so the refreshed substitution is actually visible.
   */
  async onPageVariablesReload(_data: unknown, client: WebSocketClient) {
    const { miAPI } = this.opts;

    if (!miAPI) {
      client.send('page-variables:reload:response', {
        error: 'MiAPI is not defined',
      });

      this.logger.error(colors.red('MiAPI is not defined'));

      return;
    }

    try {
      const reloaded = await miAPI.reloadPageVariables();

      client.send('page-variables:reload:response', {
        ok: true,
        count: reloaded ? reloaded.length : 0,
        skipped: reloaded === null,
      });

      this.logger.info(colors.green('Page variables reloaded'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Reload variables failed';

      this.logger.error(colors.red(`Reload variables failed: ${message}`));

      client.send('page-variables:reload:response', {
        error: message,
      });
    }
  }
}
