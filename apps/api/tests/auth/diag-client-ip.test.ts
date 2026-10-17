import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GET } from '../../src/app/api/v2/%5Fdiag/client-ip/route';

/**
 * The P-4 edge probe (removed by the contract PR): the caller's own observed
 * X-Real-IP, the X-Forwarded-For entry count and whether the first entry is that
 * address (never the values), the CF-Connecting-IP that arrived, and whether the
 * request came through Cloudflare.
 */
const EDGE_SHAPES = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/cutover/edge-header-shapes.json'), 'utf8')
  ) as { shapes: { name: string; headers: Record<string, string> }[] }
).shapes;
const probe = (headers: Record<string, string> = {}) =>
  GET(new NextRequest('http://localhost/api/v2/_diag/client-ip', { headers }));
describe('GET /api/v2/_diag/client-ip', () => {
  it('echoes the observed x-real-ip and counts x-forwarded-for entries without values', async () => {
    const res = GET(
      new NextRequest('http://localhost/api/v2/_diag/client-ip', {
        headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.9.8.7, 198.51.100.4' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      x_real_ip: '203.0.113.7',
      x_forwarded_for_entries: 2,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
    expect(text).not.toContain('10.9.8.7');
    expect(text).not.toContain('198.51.100.4');
  });

  it('reports absent headers as null and zero', async () => {
    const res = GET(new NextRequest('http://localhost/api/v2/_diag/client-ip'));
    expect(await res.json()).toEqual({
      x_real_ip: null,
      x_forwarded_for_entries: 0,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: null,
      via_cloudflare: false,
    });
  });

  it('records the via-Cloudflare shape: first X-Forwarded-For entry is not the client, no Cloudflare or edge value echoed', async () => {
    const text = await probe(EDGE_SHAPES[0]!.headers).text();
    expect(JSON.parse(text)).toEqual({
      x_real_ip: '203.0.113.10',
      x_forwarded_for_entries: 2,
      x_forwarded_for_first_is_x_real_ip: false,
      cf_connecting_ip: '203.0.113.10',
      via_cloudflare: true,
    });
    expect(text).not.toContain('198.51.100.10');
    expect(text).not.toContain('192.0.2.200');
  });

  it('records the direct shape: the spoofed CF-Connecting-IP is reported as it arrived', async () => {
    const text = await probe(EDGE_SHAPES[1]!.headers).text();
    expect(JSON.parse(text)).toEqual({
      x_real_ip: '203.0.113.20',
      x_forwarded_for_entries: 2,
      x_forwarded_for_first_is_x_real_ip: true,
      cf_connecting_ip: '192.0.2.66',
      via_cloudflare: false,
    });
    expect(text).not.toContain('192.0.2.200');
  });
});
