import { NextRequest, NextResponse } from 'next/server';
import { requireUser, bearerToken } from '@/lib/auth/require-user';
import { AuthServiceUnavailableError } from '@/lib/auth-service/client';
import { legacyError, revokeSessions, unavailableResponse } from '@/lib/auth-service/legacy';
import { safeErrorMeta } from '@/lib/log';

// Legacy logout over apps/auth (spec 300, plan phase 8; G-3): the legacy client
// sends only its JWT, and logout ends EVERY session of the user, as today.
// apps/auth requires that JWT, so the credential alone logs nobody out. A JWT
// already issued stays valid until its exp (15 minutes, the accepted window).

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireUser(request);
    if ('error' in authResult) return authResult.error;

    const jwt = bearerToken(request.headers.get('Authorization')) as string;
    await revokeSessions(authResult.user.id, jwt);
    return NextResponse.json({ message: 'Successfully logged out' });
  } catch (error) {
    if (error instanceof AuthServiceUnavailableError) {
      console.error('Logout: apps/auth unavailable', { status: error.status });
      return unavailableResponse();
    }
    console.error('Logout error:', safeErrorMeta(error));
    return legacyError('Logout failed', 500);
  }
}
