import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * `disableSSLValidation` used to set `NODE_TLS_REJECT_UNAUTHORIZED=0` and `axios.defaults.httpsAgent`,
 * turning certificate checks off for every HTTPS call in the process, not only those to MI.
 */
describe('MiAPI — disableSSLValidation', () => {
  const tlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const defaultAgent = axios.defaults.httpsAgent;

  afterEach(() => {
    if (tlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsEnv;
    }

    axios.defaults.httpsAgent = defaultAgent;
  });

  it('relaxes TLS for its own client only', () => {
    new MiAPI('https://self-signed-tls.example.com', { disableSSLValidation: true });

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tlsEnv);
    expect(axios.defaults.httpsAgent).toBe(defaultAgent);
  });
});
