import { ViteDevServer } from 'vite';
import { DistService } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';

export interface ClientServiceOptions {
  distService?: DistService;
  miAPI?: MiAPI;
}

export class ClientService {
  private readonly server: ViteDevServer;
  private readonly opts: ClientServiceOptions;
  private readonly eventMap: Map<string, (this: ClientService, ...attrs: any[]) => void>;

  constructor(server: ViteDevServer, opts?: ClientServiceOptions) {
    this.server = server;
    this.opts = opts || {};

    this.eventMap = new Map<string, (this: ClientService, ...attrs: any[]) => void>();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));
    this.eventMap.set('template:sync', this.onTemplateSync.bind(this));

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

      const currentAssets = await miAPI?.getAssets();

      const newAssets = currentAssets
        ? await distService?.saveBackupAndBuild(currentAssets)
        : await distService?.buildNewAssets();

      if (newAssets) {
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
        } else {
          this.server.ws.send('template:sync:response', { error: 'Failed to update assets' });
        }
      } else {
        this.server.ws.send('template:sync:response', { error: 'Failed to build new assets' });

        return;
      }
    } else {
      this.server.ws.send('template:sync:response', { error: 'Dist service or MiAPI is not defined' });

      return;
    }
  }
}
