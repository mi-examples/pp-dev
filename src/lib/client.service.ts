import * as path from 'path';
import { createLogger } from './logger.js';
import { colors, getTokenErrorInfo, logTokenError } from './helpers/index.js';
import { isUnavailableJsonApiError } from '../api/unavailable-json-api.js';
import { DistService, TEMPLATE_VARIABLES_FILE_NAME } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import { Logger, ViteDevServer } from 'vite';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';

interface SyncActionRequestPayload {
  requestId: string;
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

interface SyncActionResponsePayload {
  requestId: string;
  approved: boolean;
}

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
  private readonly syncActionResolvers = new Map<
    string,
    { resolve: (approved: boolean) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  constructor(server: ViteDevServer, opts?: ClientServiceOptions) {
    this.server = server;
    this.opts = opts || {};

    this.eventMap = new Map<string, (this: ClientService, ...attrs: any[]) => void>();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));
    this.eventMap.set('template:sync', this.onTemplateSync.bind(this));
    this.eventMap.set('template:sync:action-response', this.onTemplateSyncActionResponse.bind(this));

    this.logger = createLogger();

    this.init();
  }

  init() {
    const { ws } = this.server;

    for (const [event, handler] of this.eventMap) {
      ws.on(event, handler);
    }

    ws.on('close', () => {
      this.clearAllPendingSyncActions(false);
    });

    ws.on('error', () => {
      this.clearAllPendingSyncActions(false);
    });
  }

  private resolveSyncAction(requestId: string, approved: boolean) {
    const entry = this.syncActionResolvers.get(requestId);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timeoutId);
    this.syncActionResolvers.delete(requestId);
    entry.resolve(approved);
  }

  /** Resolves every pending `requestSyncAction` promise and clears timeouts (e.g. WebSocket closed). */
  private clearAllPendingSyncActions(approved: boolean) {
    for (const requestId of [...this.syncActionResolvers.keys()]) {
      this.resolveSyncAction(requestId, approved);
    }
  }

  onInfoDataRequest() {
    this.server.ws.send({
      type: 'custom',
      event: 'info-data:response',
      data: {},
    });
  }

  onTemplateSyncActionResponse(payload?: SyncActionResponsePayload) {
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.approved !== 'boolean') {
      return;
    }

    this.resolveSyncAction(payload.requestId, payload.approved);
  }

  async requestSyncAction(payload: Omit<SyncActionRequestPayload, 'requestId'>) {
    const requestId = randomUUID();
    const timeoutMs = this.opts.syncActionTimeoutMs ?? 120_000;

    return await new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.resolveSyncAction(requestId, false);
      }, timeoutMs);

      this.syncActionResolvers.set(requestId, { resolve, timeoutId });

      this.server.ws.send('template:sync:action-required', {
        ...payload,
        requestId,
      } satisfies SyncActionRequestPayload);
    });
  }

  async onTemplateSync() {
    if (this.opts.distService && this.opts.miAPI) {
      const { distService, miAPI } = this.opts;

      try {
        if (this.server.config.clientInjectionPlugin?.v7Features) {
          if (!miAPI?.isV710OrHigher) {
            this.server.ws.send('template:sync:response', {
              error: 'This feature is available only for MI v7.1.0 or higher',
              config: {
                canSync: false,
              },
            });

            return;
          } else {
            this.server.ws.send('client:config:update', {
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
                  this.server.ws.send('template:sync:response', {
                    error: validation.error,
                    code: validation.code,
                    refresh: true,
                  });
                } else {
                  this.logger.info(colors.yellow('Session expired'));
                  this.server.ws.send('template:sync:response', {
                    error: 'Session expired',
                    code: 'SESSION_EXPIRED',
                    refresh: true,
                  });
                }
              } catch (validationError) {
                this.logger.info(colors.yellow('Session expired'));
                this.server.ws.send('template:sync:response', {
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

              this.server.ws.send('template:sync:response', {
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

              this.server.ws.send('template:sync:response', {
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

            this.server.ws.send('template:sync:response', {
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
                const replaceFromServer = await this.requestSyncAction({
                  title: 'Template variables (server backup)',
                  content:
                    'The server backup includes __template_variables.json. It differs from your local public/__template_variables.json (or that file is missing). Replace your project copy with the server backup?',
                  confirmText: 'Replace from server',
                  cancelText: 'Keep local',
                });

                if (replaceFromServer) {
                  await distService.saveTemplateVariablesFile(templateVariables.content);
                }
              }
            };

            if (backupAnalysis.unknownFiles.length > 0) {
              const shouldContinueSync = await this.requestSyncAction({
                title: 'Unknown files found in backup',
                content: `Backup contains files not listed in VERSION: ${backupAnalysis.unknownFiles.join(', ')}. Continue sync or cancel?`,
                confirmText: 'Continue sync',
                cancelText: 'Cancel sync',
              });

              if (!shouldContinueSync) {
                this.server.ws.send('template:sync:response', {
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

              const shouldContinueAfterVersionMismatch = await this.requestSyncAction({
                title: 'VERSION manifest out of date',
                content: `These files no longer match the hashes recorded in the VERSION manifest:\n\n${fileList}${suffix}\n\nCancel sync, or override and continue using the files on disk?`,
                confirmText: 'Override and continue',
                cancelText: 'Cancel sync',
              });

              if (!shouldContinueAfterVersionMismatch) {
                this.server.ws.send('template:sync:response', {
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

              const shouldContinueAfterMismatch = await this.requestSyncAction({
                title: 'Build manifest fingerprint mismatch',
                content: `The recomputed backup fingerprint does not match BUILD-MANIFEST.json.\nManifest: ${expected.slice(0, 12)}...\nComputed: ${actual.slice(0, 12)}...\nContinue sync anyway?`,
                confirmText: 'Continue sync',
                cancelText: 'Cancel sync',
              });

              if (!shouldContinueAfterMismatch) {
                this.server.ws.send('template:sync:response', {
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
            const backupMeta = distService?.getBackupMeta();

            const {
              lastBackupName: backupFilename,
              lastBackupHash: currentHash,
              lastBackupDate: backupDate,
            } = backupMeta || {
              lastBackupName: '',
              lastBackupHash: '',
              lastBackupDate: new Date().toISOString(),
            };

            this.server.ws.send('template:sync:response', {
              syncedAt: new Date(backupDate),
              currentHash,
              backupFilename,
            });

            this.logger.info(colors.green('Template synced'));
          } else {
            this.server.ws.send('template:sync:response', {
              error: 'Failed to update assets',
            });

            this.logger.error(colors.red('Failed to update assets'));
          }
        } else {
          if (newAssets instanceof Error) {
            this.server.ws.send('template:sync:response', {
              error: newAssets.message,
            });

            this.logger.error(colors.red(newAssets.message));

            return;
          }

          this.server.ws.send('template:sync:response', {
            error: 'Failed to build new assets',
          });

          this.logger.error(colors.red('Failed to build new assets'));

          return;
        }
      } catch (syncError: unknown) {
        const message = syncError instanceof Error ? syncError.message : 'Template sync failed';

        this.logger.error(colors.red(`Template sync failed: ${message}`));

        this.server.ws.send('template:sync:response', {
          error: message,
          code: 'SYNC_FAILED',
        });

        return;
      }
    } else {
      this.server.ws.send('template:sync:response', {
        error: 'Dist service or MiAPI is not defined',
      });

      this.logger.error(colors.red('Dist service or MiAPI is not defined'));

      return;
    }
  }
}
