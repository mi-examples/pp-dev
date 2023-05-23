import { ViteDevServer } from 'vite';

export class ClientService {
  private readonly server: ViteDevServer;
  private opts: any;
  private readonly eventMap: Map<string, (this: ClientService, ...attrs: any[]) => void>;

  constructor(server: ViteDevServer, opts?: any) {
    this.server = server;
    this.opts = opts;

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

  onTemplateSync(data: any) {
    // console.log('onTemplateSync', data);

    setTimeout(() => {
      this.server.ws.send('template:sync:response', { syncedAt: new Date(), currentHash: 'sync-hash' });
    }, 500);
  }
}
