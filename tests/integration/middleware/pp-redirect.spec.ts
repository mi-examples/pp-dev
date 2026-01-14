import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import { initPPRedirect } from '../../../src/lib/pp-redirect.middleware.js';

// Simple test server helper
function createTestServer(middleware: any): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const next = () => {
        res.statusCode = 200;
        res.end('OK');
      };
      middleware(req, res, next);
    });

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' ? address?.port ?? 0 : 0;
      
      resolve({ server, port });
    });
  });
}

async function makeRequest(port: number, path: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: 'GET',
      },
      (res: any) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            body,
          });
        });
      }
    );
    req.end();
  });
}

describe('PP Redirect Middleware', () => {
  describe('Root Path Redirection', () => {
    it('should redirect root path to base path', async () => {
      const middleware = initPPRedirect('/p/my-template/', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/');

        expect(response.status).toBe(302);
        expect(response.location).toBe('/p/my-template/');
      } finally {
        server.close();
      }
    });

    it('should not redirect requests to base path', async () => {
      const middleware = initPPRedirect('/p/my-template/', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/p/my-template/');

        expect(response.status).toBe(200);
        expect(response.body).toBe('OK');
      } finally {
        server.close();
      }
    });

    it('should not redirect requests to sub-paths under base', async () => {
      const middleware = initPPRedirect('/p/my-template/', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/p/my-template/page');

        expect(response.status).toBe(200);
        expect(response.body).toBe('OK');
      } finally {
        server.close();
      }
    });
  });

  describe('V7 Features Path', () => {
    it('should handle /pl/ prefix for v7 features', async () => {
      const middleware = initPPRedirect('/pl/my-template/', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/');

        expect(response.status).toBe(302);
        expect(response.location).toBe('/pl/my-template/');
      } finally {
        server.close();
      }
    });

    it('should not redirect /pl/ path requests', async () => {
      const middleware = initPPRedirect('/pl/my-template/', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/pl/my-template/');

        expect(response.status).toBe(200);
      } finally {
        server.close();
      }
    });
  });

  describe('Base Path Without Trailing Slash', () => {
    it('should handle base path without trailing slash', async () => {
      const middleware = initPPRedirect('/p/my-template', 'my-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/');

        expect(response.status).toBe(302);
        // Should still redirect properly
        expect(response.location).toContain('/p/my-template');
      } finally {
        server.close();
      }
    });
  });

  describe('Special Characters in Template Name', () => {
    it('should handle template names with hyphens', async () => {
      const middleware = initPPRedirect('/p/my-cool-template/', 'my-cool-template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/');

        expect(response.status).toBe(302);
        expect(response.location).toBe('/p/my-cool-template/');
      } finally {
        server.close();
      }
    });

    it('should handle template names with underscores', async () => {
      const middleware = initPPRedirect('/p/my_template/', 'my_template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/');

        expect(response.status).toBe(302);
        expect(response.location).toBe('/p/my_template/');
      } finally {
        server.close();
      }
    });
  });

  describe('Pass Through Behavior', () => {
    it('should pass through Vite internal requests', async () => {
      const middleware = initPPRedirect('/p/template/', 'template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/@vite/client');

        expect(response.status).toBe(200);
        expect(response.body).toBe('OK');
      } finally {
        server.close();
      }
    });

    it('should pass through other paths', async () => {
      const middleware = initPPRedirect('/p/template/', 'template');
      const { server, port } = await createTestServer(middleware);

      try {
        const response = await makeRequest(port, '/api/data');

        expect(response.status).toBe(200);
        expect(response.body).toBe('OK');
      } finally {
        server.close();
      }
    });
  });
});
