// Addresses that public sign-up must refuse (spec 4, carried into spec 300).
// Ported from apps/api/lib/auth/reserved.ts and system-accounts.ts.
//
// Reserved = the configured admin addresses (ADMIN_EMAILS) OR any address under
// the system domain. Refusing them with the SAME response as an existing
// account keeps sign-up from becoming an oracle for which addresses are
// privileged. System accounts live only in the app database (spec 300, Desired
// State item 9), so the auth database must never hold one of these addresses.

export const SYSTEM_EMAIL_DOMAIN = '@system.ansari.chat';

/** The same normalisation better-auth applies on lookup, plus the legacy trim. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the address is under the reserved system domain. */
export function isSystemAddress(email: string): boolean {
  return normalizeEmail(email).endsWith(SYSTEM_EMAIL_DOMAIN);
}

/**
 * True when public sign-up must refuse this address. The email is normalized
 * here, so no caller can bypass the check with a mixed-case address.
 *
 * @param adminEmails - the ADMIN_EMAILS entries, already normalized by getEnv().
 */
export function isReservedAddress(email: string, adminEmails: readonly string[]): boolean {
  const normalized = normalizeEmail(email);
  return adminEmails.includes(normalized) || isSystemAddress(normalized);
}
