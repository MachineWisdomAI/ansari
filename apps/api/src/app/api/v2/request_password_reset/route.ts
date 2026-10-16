import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRealIp } from '@/lib/rate-limit';
import {
  legacyError,
  requestPasswordReset,
  tooManyRequestsResponse,
} from '@/lib/auth-service/legacy';
import { safeErrorMeta } from '@/lib/log';

// Legacy reset request over apps/auth (spec 300, plan phase 8). apps/auth
// sends the legacy-shaped link, and answers every email alike, with one rate
// budget for known and unknown addresses. Any other failure still answers
// success, as today, so the route never tells whether an address exists.

const requestSchema = z.object({
  email: z.string().email('Invalid email format'),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return legacyError('Invalid request body', 422);
  }

  const parseResult = requestSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((i) => i.message);
    return legacyError(errors.join(', '), 422);
  }

  try {
    const result = await requestPasswordReset(parseResult.data.email, {
      clientIp: getRealIp(request),
    });
    if (result.kind === 'rate_limited') return tooManyRequestsResponse(result.retryAfter);
  } catch (error) {
    console.error('Request password reset error:', safeErrorMeta(error));
  }
  return NextResponse.json({ status: 'success' });
}
