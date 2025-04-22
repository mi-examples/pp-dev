import { Logger, ViteDevServer } from 'vite';
import { DistService } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper';
import { isAxiosError } from 'axios';

export interface ClientServiceOptions {
  distService?: DistService;
  miAPI?: MiAPI;
}

export class ClientService {
  private readonly server: ViteDevServer;
  private readonly opts: ClientServiceOptions;
  private readonly eventMap: Map<string, (this: ClientService, ...attrs: any[]) => void>;

  private logger: Logger;

  constructor(server: ViteDevServer, opts?: ClientServiceOptions) {
    this.server = server;
    this.opts = opts || {};

    this.eventMap = new Map<string, (this: ClientService, ...attrs: any[]) => void>();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));
    this.eventMap.set('template:sync', this.onTemplateSync.bind(this));

    this.logger = createLogger();

    this.init();
  }

  init() {
    const { ws } = this.server;

    for (const [event, handler] of this.eventMap) {
      ws.on(event, handler);
    }
  }

  onInfoDataRequest() {
    this.server.ws.send({
      type: 'custom',
      event: 'info-data:response',
      data: {},
    });
  }

  async onTemplateSync() {
    if (this.opts.distService && this.opts.miAPI) {
      const { distService, miAPI } = this.opts;

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

      const currentAssets = await miAPI?.getAssets().catch((err) => {
        if (isAxiosError(err)) {
          if (err.response?.status === 412) {
            this.logger.info(colors.yellow('Session expired'));

            this.server.ws.send('template:sync:response', { error: 'Session expired', refresh: true });

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
            });

            return err;
          }
        }

        throw err;
      });

      if (currentAssets instanceof Error) {
        return;
      }

      const newAssets = currentAssets
        ? await distService?.saveBackupAndBuild(currentAssets).catch((err: Error) => {
            if (err.message === 'Backup file is not a ZIP file') {
              this.logger.error(colors.red('Backup file is not a ZIP file'));

              return err;
            }
          })
        : await distService?.buildNewAssets()

      if (newAssets && newAssets instanceof Buffer) {
        const updateResult = await miAPI?.updateAssets(newAssets);

        if (updateResult?.status === 'OK') {
          const backupMeta = distService?.getBackupMeta();

          const {
            lastBackupName: backupFilename,
            lastBackupHash: currentHash,
            lastBackupDate: backupDate,
          } = backupMeta || { lastBackupName: '', lastBackupHash: '', lastBackupDate: new Date().toISOString() };

          this.server.ws.send('template:sync:response', {
            syncedAt: new Date(backupDate),
            currentHash,
            backupFilename,
          });

          this.logger.info(colors.green('Template synced'));
        } else {
          this.server.ws.send('template:sync:response', { error: 'Failed to update assets' });

          this.logger.error(colors.red('Failed to update assets'));
        }
      } else {
        if (newAssets instanceof Error) {
          this.server.ws.send('template:sync:response', { error: newAssets.message });

          this.logger.error(colors.red(newAssets.message));

          return;
        }

        this.server.ws.send('template:sync:response', { error: 'Failed to build new assets' });

        this.logger.error(colors.red('Failed to build new assets'));

        return;
      }
    } else {
      this.server.ws.send('template:sync:response', { error: 'Dist service or MiAPI is not defined' });

      this.logger.error(colors.red('Dist service or MiAPI is not defined'));

      return;
    }
  }
}
