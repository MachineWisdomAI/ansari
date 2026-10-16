import { NextResponse } from 'next/server';

/**
 * Create standardized error response matching Ansari's format
 */
export function createErrorResponse(detail: string, status: number = 400): NextResponse {
  return NextResponse.json({ detail }, { status });
}
