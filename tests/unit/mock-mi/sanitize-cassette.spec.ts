import { describe, it, expect } from 'vitest';
import { redactMiHosts, sanitizeCassette, type Cassette, type Interaction } from '../../mock-mi/server';

const json = (pathname: string, body: unknown): Interaction => ({
  request: { method: 'GET', pathname },
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
});

const cassette = (interactions: Interaction[]): Cassette => ({
  name: 'test',
  baseUrl: 'https://stg7x.metricinsights.com',
  recordedAt: '2026-01-01T00:00:00.000Z',
  interactions,
});

describe('mock-mi cassette sanitizer', () => {
  describe('redactMiHosts', () => {
    it('replaces internal instance hosts with example.com placeholders', () => {
      expect(redactMiHosts('https://stg7x.metricinsights.com/p/page')).toBe('https://mi.example.com/p/page');
      expect(redactMiHosts('beta7.metricinsights.com')).toBe('mi.example.com');
    });

    it('keeps distinct hosts distinct', () => {
      expect(redactMiHosts('stg7x-custom.metricinsights.com')).toBe('mi-custom.example.com');
    });

    it('leaves public metricinsights.com hosts alone', () => {
      const text = 'https://help.metricinsights.com/x https://www.metricinsights.com https://tools.metricinsights.com';

      expect(redactMiHosts(text)).toBe(text);
    });

    it('is idempotent', () => {
      const once = redactMiHosts('https://stg7x.metricinsights.com');

      expect(redactMiHosts(once)).toBe(once);
    });
  });

  describe('sanitizeCassette', () => {
    it('redacts hosts in baseUrl, JSON bodies and text bodies', () => {
      const result = sanitizeCassette(
        cassette([
          json('/api/page/id/1', { page: { id: 1, base_url: 'https://stg7x.metricinsights.com/p/one' } }),
          {
            request: { method: 'GET', pathname: '/index.html' },
            response: {
              status: 200,
              headers: { 'content-type': 'text/html' },
              body: '<a href="https://stg7x.metricinsights.com/home">home</a>',
            },
          },
        ]),
      );

      expect(result.baseUrl).toBe('https://mi.example.com');
      expect(JSON.stringify(result)).not.toMatch(/stg7x/);
      expect(JSON.parse(result.interactions[0].response.body).page.base_url).toBe('https://mi.example.com/p/one');
    });

    it('trims /api/page to pages referenced elsewhere in the cassette', () => {
      const result = sanitizeCassette(
        cassette([
          json('/api/page/id/937', { page: { id: 937 } }),
          json('/api/page_variable?page_id=292', { variables: [] }),
          json('/api/page', { pages: [{ id: 937 }, { id: 292 }, { id: 5, name: 'Unrelated Customer Page' }] }),
        ]),
      );
      const pages = JSON.parse(result.interactions[2].response.body).pages;

      expect(pages.map((p: { id: number }) => p.id)).toEqual([937, 292]);
    });

    it('leaves binary bodies untouched', () => {
      const body = Buffer.from('stg7x.metricinsights.com').toString('base64');
      const result = sanitizeCassette(
        cassette([
          {
            request: { method: 'GET', pathname: '/favicon.ico' },
            response: { status: 200, headers: { 'content-type': 'image/x-icon' }, body, bodyEncoding: 'base64' },
          },
        ]),
      );

      expect(result.interactions[0].response.body).toBe(body);
    });
  });
});
