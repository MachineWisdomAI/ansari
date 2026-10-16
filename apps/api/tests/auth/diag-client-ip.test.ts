import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/v2/%5Fdiag/client-ip/route';

/**
 * The P-4 edge probe (removed by the contract PR): the caller's own observed
 * X-Real-IP and the number of X-Forwarded-For entries, never their values.
 */
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
    expect(JSON.parse(text)).toEqual({ x_real_ip: '203.0.113.7', x_forwarded_for_entries: 2 });
    expect(text).not.toContain('10.9.8.7');
    expect(text).not.toContain('198.51.100.4');
  });

  it('reports absent headers as null and zero', async () => {
    const res = GET(new NextRequest('http://localhost/api/v2/_diag/client-ip'));
    expect(await res.json()).toEqual({ x_real_ip: null, x_forwarded_for_entries: 0 });
  });
});
