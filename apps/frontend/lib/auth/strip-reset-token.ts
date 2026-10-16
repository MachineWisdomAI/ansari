// Side effect only, imported FIRST by the app entry (index.ts): on the web,
// a reset link's `?token=` moves into memory before expo-router loads.
import { takeResetTokenFromUrl } from '@/lib/auth/reset-token';

takeResetTokenFromUrl(typeof window === 'undefined' ? undefined : window);
