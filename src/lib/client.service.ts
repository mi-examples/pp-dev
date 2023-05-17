import { ViteDevServer } from 'vite';

export class ClientService {
  private readonly server: ViteDevServer;
  private opts: any;
  private eventMap: Map<string, (this: ClientService, ...attrs: any[]) => void>;

  constructor(server: ViteDevServer, opts?: any) {
    this.server = server;
    this.opts = opts;

    this.eventMap = new Map<
      string,
      (this: ClientService, ...attrs: any[]) => void
    >();

    this.eventMap.set('info-data:request', this.onInfoDataRequest.bind(this));

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
}
