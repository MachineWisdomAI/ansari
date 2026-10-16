import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRealIp } from '@/lib/rate-limit';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import {
  LEGACY_DETAIL,
  legacyError,
  mintJwt,
  unavailableResponse,
} from '@/lib/auth-service/legacy';
import { safeErrorMeta } from '@/lib/log';

// Legacy refresh over apps/auth (spec 300, plan phase 8): the refresh_token is
// the Better Auth session token. It is exchanged for a fresh JWT and returned
// unchanged, so concurrent refreshes with one token all succeed (issue #34),
// and any refresh slides the session forward once a day (30 days, 1 day).

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parseResult = refreshSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message);
      return legacyError(errors.join(', '), 422);
    }

    const { refresh_token } = parseResult.data;
    const accessToken = await mintJwt(refresh_token, { clientIp: getRealIp(request) });
    if (!accessToken) return legacyError(LEGACY_DETAIL.invalidRefreshToken, 401);

    return NextResponse.json({
      access_token: accessToken,
      refresh_token,
      token_type: 'bearer',
    });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Token refresh: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Token refresh error:', safeErrorMeta(error));
    return legacyError('Token refresh failed', 500);
  }
}
