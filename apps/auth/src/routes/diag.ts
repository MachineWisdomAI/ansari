// The edge check's probe (plan P-4), removed by the contract PR. It tells the
// caller only what the edge says about the caller itself: the observed
// `X-Real-IP`, and how many `X-Forwarded-For` entries arrived (never their
// values). Telling a caller its own address is not a disclosure.
import type { Request, Response } from 'express';

export const DIAG_PATH = '/__diag/client-ip';

export function clientIpDiag(req: Request, res: Response): void {
  const realIp = req.headers['x-real-ip'];
  const forwardedFor = req.headers['x-forwarded-for'];
  const entries =
    typeof forwardedFor === 'string'
      ? forwardedFor.split(',').filter((entry) => entry.trim().length > 0).length
      : 0;
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    x_real_ip: typeof realIp === 'string' ? realIp : null,
    x_forwarded_for_entries: entries,
  });
}
