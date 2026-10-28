import * as path from 'path';
import { createLogger } from './logger.js';
import { colors, getTokenErrorInfo, logTokenError } from './helpers/index.js';
import { isUnavailableJsonApiError } from '../api/unavailable-json-api.js';
import { DistService, TEMPLATE_VARIABLES_FILE_NAME } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import { Logger, ViteDevServer, WebSocketClient } from 'vite';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import {
  SYNC_IN_PROGRESS_CODE,
  type SyncActionRequiredPayload,
  type SyncActionResponsePayload,
  type TemplateSyncResponsePayload,
} from '../shared/ws-messages.js';

export { SYNC_IN_PROGRESS_CODE };

export interface ClientServiceOptions {
  distService?: DistService;
  miAPI?: MiAPI;
  /**
   * Max time to wait for the browser to respond to `template:sync:action-required`.
   * After this, the pending promise resolves to `false` and the resolver is removed.
   * @default 120_000
   */
  syncActionTimeoutMs?: number;
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
    { resolve: (approved: boolean) => void; timeoutId: ReturnType<typeof setTimeout>; cleanup: () => void }
  >();

  constructor(server: ViteDevServer, opts?: ClientServiceOptions) {
    this.server = server;
    this.opts = opts || {};

    this.eventMap = new Map<string, (this: ClientService, ...attrs: any[]) => void>();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));
    this.eventMap.set('template:sync', this.onTemplateSync.bind(this));
    this.eventMap.set('template:sync:action-response', this.onTemplateSyncActionResponse.bind(this));
    this.eventMap.set('page-variables:reload', this.onPageVariablesReload.bind(this));

    this.logger = createLogger();

    this.init();
  }

  init() {
    const { ws } = this.server;

    for (const [event, handler] of this.eventMap) {
      ws.on(event, handler);
    }

    ws.on('error', () => {
      this.clearAllPendingSyncActions(false);
    });
  }

  /**
   * The dev server shuts down: no dialog can be answered any more, and a running sync's build must
   * not outlive it. Called by whoever closes the server (the Vite plugin's `closeBundle`, `pp-dev
   * next`'s restart and shutdown). Not a WebSocket `close` listener: Vite takes `ws.on('close')` for
   * a message any page could send, and never calls it on shutdown.
   */
  dispose() {
    this.clearAllPendingSyncActions(false);
    this.opts.distService?.stopBuilds();
  }

  private resolveSyncAction(requestId: string, approved: boolean) {
    const entry = this.syncActionResolvers.get(requestId);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timeoutId);
    entry.cleanup();
    this.syncActionResolvers.delete(requestId);
    entry.resolve(approved);
  }

  /** Resolves every pending `requestSyncAction` promise and clears timeouts (e.g. WebSocket closed). */
  private clearAllPendingSyncActions(approved: boolean) {
    for (const requestId of [...this.syncActionResolvers.keys()]) {
      this.resolveSyncAction(requestId, approved);
    }
  }

  /** Tells the panel how its sync ended, in the shape it reads (`src/shared/ws-messages.ts`). */
  private sendSyncResponse(client: WebSocketClient, payload: TemplateSyncResponsePayload) {
    client.send('template:sync:response', payload);
  }

  onInfoDataRequest(_data: unknown, client: WebSocketClient) {
    client.send('info-data:response', {});
  }

  onTemplateSyncActionResponse(payload?: SyncActionResponsePayload) {
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.approved !== 'boolean') {
      return;
    }

    this.resolveSyncAction(payload.requestId, payload.approved);
  }

  async requestSyncAction(payload: Omit<SyncActionRequiredPayload, 'requestId'>, client: WebSocketClient) {
    const requestId = randomUUID();
    const timeoutMs = this.opts.syncActionTimeoutMs ?? 120_000;

    return await new Promise<boolean>((resolve) => {
      const cancel = () => this.resolveSyncAction(requestId, false);
      const timeoutId = setTimeout(cancel, timeoutMs);
      // A tab closed while its dialog is open will never answer: cancel the sync at once instead of
      // keeping every other sync blocked until the timeout.
      const { socket } = client as Partial<Pick<WebSocketClient, 'socket'>>;

      socket?.once('close', cancel);
      this.syncActionResolvers.set(requestId, { resolve, timeoutId, cleanup: () => socket?.off('close', cancel) });

      if (socket && socket.readyState !== socket.OPEN) {
        cancel();

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

        const currentAssets = await miAPI?.getAssets().catch(async (err) => {
          if (isAxiosError(err)) {
            // Use the token helper for better error handling
            const errorInfo = getTokenErrorInfo(err);

            if (errorInfo.code === 'SESSION_EXPIRED') {
              this.logger.info(colors.yellow('Session expired - attempting to validate credentials'));

              // Try to validate credentials to get more specific error information
              try {
                const validation = await miAPI?.validateCredentials();

                if (validation && !validation.isValid) {
                  this.logger.error(colors.red(`Authentication error: ${validation.error}`));
                  this.sendSyncResponse(client, {
                    error: validation.error ?? 'Authentication failed',
                    code: validation.code,
                    refresh: true,
                  });
                } else {
                  this.logger.info(colors.yellow('Session expired'));
                  this.sendSyncResponse(client, {
                    error: 'Session expired',
                    code: 'SESSION_EXPIRED',
                    refresh: true,
                  });
                }
              } catch (validationError) {
                this.logger.info(colors.yellow('Session expired'));
                this.sendSyncResponse(client, {
                  error: 'Session expired',
                  code: 'SESSION_EXPIRED',
                  refresh: true,
                });
              }

              return err;
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

              return err;
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

              return err;
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

            return err;
          }

          throw err;
        });

        if (currentAssets instanceof Error) {
          return;
        }

        let newAssets: Buffer | Error | undefined;

        if (currentAssets) {
          const backupAnalysis = await distService?.analyzeBackup(currentAssets).catch((err: Error) => {
            if (err.message === 'Backup file is not a ZIP file') {
              this.logger.error(colors.red('Backup file is not a ZIP file'));

              return err;
            }

            return err;
          });

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

            const promptReplaceTemplateVariables = async () => {
              if (!backupAnalysis.templateVariables || !distService) {
                return;
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

                if (replaceFromServer) {
                  await distService.saveTemplateVariablesFile(templateVariables.content);
                }
              }
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

              if (!shouldContinueSync) {
                this.sendSyncResponse(client, {
                  cancelled: true,
                  message: 'Sync cancelled by user. Backup was saved.',
                });

                this.logger.info(colors.yellow('Sync cancelled by user'));

                return;
              }
            }

            if (mixedTemplateAndOthers) {
              await promptReplaceTemplateVariables();
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

              if (!shouldContinueAfterVersionMismatch) {
                this.sendSyncResponse(client, {
                  cancelled: true,
                  message: 'Sync cancelled by user. Backup was saved.',
                });

                this.logger.info(colors.yellow('Sync cancelled by user'));

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

              if (!shouldContinueAfterMismatch) {
                this.sendSyncResponse(client, {
                  cancelled: true,
                  message: 'Sync cancelled by user. Backup was saved.',
                });

                this.logger.info(colors.yellow('Sync cancelled by user'));

                return;
              }
            }

            if (!mixedTemplateAndOthers) {
              await promptReplaceTemplateVariables();
            }

            newAssets = await distService?.buildNewAssets();
          }
        } else {
          newAssets = await distService?.buildNewAssets();
        }

        if (newAssets && newAssets instanceof Buffer) {
          const updateResult = await miAPI?.updateAssets(newAssets);

          if (updateResult?.status === 'OK') {
            // The meta is `{}` until a first backup is saved (a page with no assets on MI yet).
            const backupMeta = distService?.getBackupMeta();
            const backupDate = backupMeta?.lastBackupDate ? new Date(backupMeta.lastBackupDate) : new Date();

            this.sendSyncResponse(client, {
              // Now, for a date that doesn't parse: `toISOString()` throws on one, after the upload
              // succeeded, and the panel showed a failed sync.
              syncedAt: (Number.isNaN(backupDate.getTime()) ? new Date() : backupDate).toISOString(),
              currentHash: backupMeta?.lastBackupHash ?? '',
              backupFilename: backupMeta?.lastBackupName ?? '',
            });

            this.logger.info(colors.green('Template synced'));
          } else {
            this.sendSyncResponse(client, {
              error: 'Failed to update assets',
            });

            this.logger.error(colors.red('Failed to update assets'));
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
