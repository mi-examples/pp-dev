// Next.js ships its vendored `compression` middleware without a declaration file; the rewrite
// middleware's tests drive it over the response as `pp-dev next` sees it.
declare module 'next/dist/compiled/compression/index.js' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  const compression: (
    options?: Record<string, unknown>,
  ) => (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

  export default compression;
}
