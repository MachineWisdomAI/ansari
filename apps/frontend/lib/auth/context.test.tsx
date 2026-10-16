// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the storage + network layers so the provider runs under jsdom with no
// React Native runtime and no real requests. The apps/auth client is one shared
// double (the provider builds its client once, at import); `AuthError` stays
// the real class, because the provider's decisions key on it.
vi.mock('@/lib/auth/store', () => ({
  loadSession: vi.fn(async () => null),
  saveSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
  loadGuestCredentials: vi.fn(async () => null),
  saveGuestCredentials: vi.fn(async () => {}),
  clearGuestCredentials: vi.fn(async () => {}),
}));
const authApiDouble = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  mintJwt: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@/lib/auth/api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/api')>()),
  createAuthApi: () => authApiDouble,
}));

import * as store from '@/lib/auth/store';
import { AuthError } from '@/lib/auth/api';
import { handleUnauthorized } from '@/lib/api/auth-bridge';
import { AuthProvider, useAuth } from '@/lib/auth/context';

const loadSessionMock = vi.mocked(store.loadSession);
const saveSessionMock = vi.mocked(store.saveSession);
const clearSessionMock = vi.mocked(store.clearSession);
const loadGuestMock = vi.mocked(store.loadGuestCredentials);
const saveGuestMock = vi.mocked(store.saveGuestCredentials);
const clearGuestMock = vi.mocked(store.clearGuestCredentials);
const { signIn, signUp, mintJwt, signOut } = authApiDouble;

const STORED_GUEST = { email: 'guest_stored@ansari.chat', password: 'Stored-guest-pw1!' };

let authApi!: ReturnType<typeof useAuth>;

function Probe() {
  authApi = useAuth();
  return <span>{authApi.status}</span>;
}

beforeEach(() => {
  loadSessionMock.mockResolvedValue(null);
  loadGuestMock.mockResolvedValue(null);
  signIn.mockImplementation(async (email: string) => ({
    sessionToken: `session-${email}`,
    firstName: 'X',
    lastName: 'Y',
  }));
  signUp.mockImplementation(async (input: { firstName?: string; lastName?: string }) => ({
    sessionToken: 'session-new',
    firstName: input.firstName ?? '',
    lastName: input.lastName ?? '',
  }));
  mintJwt.mockImplementation(async (sessionToken: string) => `jwt-for-${sessionToken}`);
  signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Mount and let startup settle. With nothing stored, the provider auto-provisions
 * a GUEST session (`apps/api` has no anonymous path), so the settled state is
 * `signedIn` as a guest — not `signedOut`.
 */
async function mount(queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(authApi.status).not.toBe('loading'));
}

/**
 * Issue #124: `apps/api` returns 401 for any thread call without a bearer token
 * and has no anonymous path, so a tokenless "signed-out" app is broken. The
 * provider must auto-provision a guest — on first launch with nothing stored,
 * and again after logout — so the app is never tokenless.
 */
describe('AuthProvider auto-provisions a guest session', () => {
  it('first launch with no stored session signs up a guest at apps/auth', async () => {
    await mount();

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(true);
    expect(signIn).not.toHaveBeenCalled();
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signUp.mock.calls[0]![0]).toMatchObject({
      firstName: 'Welcome',
      lastName: 'Guest',
      registerToMailList: false,
    });
    // The guest is remembered, and the session holds both tokens.
    expect(saveGuestMock).toHaveBeenCalledTimes(1);
    expect(authApi.session).toMatchObject({
      sessionToken: 'session-new',
      accessToken: 'jwt-for-session-new',
    });
  });

  it('relaunch with a stored guest signs back into that guest', async () => {
    loadGuestMock.mockResolvedValue(STORED_GUEST);
    await mount();

    expect(signIn).toHaveBeenCalledWith(STORED_GUEST.email, STORED_GUEST.password);
    expect(signUp).not.toHaveBeenCalled();
    expect(authApi.isGuest).toBe(true);
    expect(authApi.session?.sessionToken).toBe(`session-${STORED_GUEST.email}`);
  });

  it('restores a real stored session without minting a guest', async () => {
    loadSessionMock.mockResolvedValueOnce({
      accessToken: 'real-access',
      sessionToken: 'real-session',
      firstName: 'Real',
      lastName: 'User',
      isGuest: false,
    });
    await mount();

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(false);
    expect(signIn).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });
});

/**
 * The narrowed guest fall-through (app architect, I-6). Only apps/auth refusing
 * the stored credentials (401 from sign-in) means a new guest. A 429, a 5xx and
 * a network error must keep the SAME stored guest, surface an error, and make
 * no sign-up request — otherwise sign-in throttling becomes sign-up pressure
 * and the device's guest and its threads are orphaned.
 */
describe('loginAsGuest: when a stored guest may be replaced', () => {
  async function tapContinueAsGuest(): Promise<unknown> {
    try {
      await act(async () => {
        await authApi.loginAsGuest();
      });
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('401 from sign-in: the stored guest is gone, a new guest is signed up', async () => {
    loadGuestMock.mockResolvedValue(STORED_GUEST);
    signIn.mockRejectedValue(new AuthError('Invalid email or password', 401, 'sign-in'));
    await mount();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(saveGuestMock).toHaveBeenCalledTimes(1);
    expect(saveGuestMock.mock.calls[0]![0].email).not.toBe(STORED_GUEST.email);
    expect(authApi.isGuest).toBe(true);
  });

  it.each([
    ['429 (rate limited)', new AuthError('Too many attempts.', 429, 'sign-in')],
    ['503 (apps/auth down)', new AuthError('Sign-in is unavailable.', 503, 'sign-in')],
    ['a network error', new AuthError("Couldn't reach Ansari.", 0, 'sign-in')],
    ['a 401 from /token, not sign-in', new AuthError('Session ended.', 401, 'token')],
  ])('%s: the same guest is kept, the error surfaces, no sign-up', async (_label, failure) => {
    loadGuestMock.mockResolvedValue(STORED_GUEST);
    signIn.mockRejectedValue(failure);
    signIn.mockImplementationOnce(async (email: string) => ({
      sessionToken: `session-${email}`,
      firstName: 'Welcome',
      lastName: 'Guest',
    }));
    // The /token case fails on the exchange after a good sign-in.
    if (failure.endpoint === 'token') {
      signIn.mockReset();
      signIn.mockResolvedValue({ sessionToken: 's', firstName: 'Welcome', lastName: 'Guest' });
      mintJwt.mockRejectedValue(failure);
    }
    // Startup's attempt (succeeds once for the sign-in cases; the /token case
    // fails here too), then "Continue as guest" meets the failure.
    await mount();

    const surfaced = await tapContinueAsGuest();

    expect(surfaced).toBe(failure);
    expect(signUp).not.toHaveBeenCalled();
    expect(saveGuestMock).not.toHaveBeenCalled();
    expect(clearGuestMock).not.toHaveBeenCalled();
  });

  it('a transient failure at first launch lands signed-out, guest kept, no sign-up', async () => {
    loadGuestMock.mockResolvedValue(STORED_GUEST);
    signIn.mockRejectedValue(new AuthError('Too many attempts.', 429, 'sign-in'));
    await mount();

    await waitFor(() => expect(authApi.status).toBe('signedOut'));
    expect(signUp).not.toHaveBeenCalled();
    expect(saveGuestMock).not.toHaveBeenCalled();
    expect(clearGuestMock).not.toHaveBeenCalled();
  });
});

/**
 * 401 recovery: the transport's single-flight refresh now mints a JWT from the
 * apps/auth session (`/token`). Only a dead session signs the user out.
 */
describe('refresh on 401 through /token', () => {
  async function mountSignedIn() {
    loadSessionMock.mockResolvedValueOnce({
      accessToken: 'expired-jwt',
      sessionToken: 'live-session',
      firstName: 'Real',
      lastName: 'User',
      isGuest: false,
    });
    await mount();
  }

  it('concurrent 401s share ONE /token call and all get the fresh JWT', async () => {
    await mountSignedIn();
    let release!: () => void;
    mintJwt.mockImplementationOnce(
      () => new Promise<string>((resolve) => (release = () => resolve('fresh-jwt'))),
    );

    let results: (string | null)[] = [];
    await act(async () => {
      const pending = Promise.all([handleUnauthorized(), handleUnauthorized(), handleUnauthorized()]);
      release();
      results = await pending;
    });

    expect(mintJwt).toHaveBeenCalledTimes(1);
    expect(mintJwt).toHaveBeenCalledWith('live-session');
    expect(results).toEqual(['fresh-jwt', 'fresh-jwt', 'fresh-jwt']);
    expect(authApi.session?.accessToken).toBe('fresh-jwt');
    expect(saveSessionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: 'fresh-jwt', sessionToken: 'live-session' }),
    );
    expect(authApi.isGuest).toBe(false);
  });

  it('401 from /token (dead session): signed out, then back to the guest', async () => {
    await mountSignedIn();
    mintJwt.mockRejectedValueOnce(new AuthError('Session ended.', 401, 'token'));

    let result: string | null = 'unset';
    await act(async () => {
      result = await handleUnauthorized();
    });

    expect(result).toBeNull();
    expect(clearSessionMock).toHaveBeenCalled();
    await waitFor(() => expect(authApi.isGuest).toBe(true));
  });

  it.each([
    ['503', new AuthError('Sign-in is unavailable.', 503, 'token')],
    ['429', new AuthError('Too many attempts.', 429, 'token')],
    ['a network error', new AuthError("Couldn't reach Ansari.", 0, 'token')],
  ])('%s from /token keeps the session (no sign-out)', async (_label, failure) => {
    await mountSignedIn();
    mintJwt.mockRejectedValueOnce(failure);

    let result: string | null = 'unset';
    await act(async () => {
      result = await handleUnauthorized();
    });

    expect(result).toBeNull();
    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(authApi.status).toBe('signedIn');
    expect(authApi.session?.sessionToken).toBe('live-session');
  });
});

/** A promise the test settles by hand, to force an interleaving. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Guest provisioning is atomic and single-flight (app architect, #309 review).
 * A new guest's credentials are stored the moment apps/auth creates it, before
 * `/token`, so a failed exchange never orphans it; and concurrent callers
 * share one attempt, so a device never signs up two guests at once.
 */
describe('guest provisioning: atomic and single-flight', () => {
  it('sign-up ok, /token 503: the guest is stored, and the retry signs back into it', async () => {
    const stored: { email: string; password: string }[] = [];
    saveGuestMock.mockImplementation(async (credentials) => {
      stored.push(credentials);
    });
    loadGuestMock.mockImplementation(async () => stored.at(-1) ?? null);
    mintJwt.mockRejectedValueOnce(new AuthError('Sign-in is unavailable.', 503, 'token'));
    await mount();

    // Startup: sign-up succeeded and the guest was stored, /token failed →
    // signed out; the re-guest retry then signs back into THAT guest.
    await waitFor(() => expect(authApi.status).toBe('signedIn'));
    expect(stored).toHaveLength(1);
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(stored[0]!.email, stored[0]!.password);
    expect(authApi.isGuest).toBe(true);

    // A later "Continue as guest" reuses it too.
    await act(async () => {
      await authApi.loginAsGuest();
    });
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(saveGuestMock).toHaveBeenCalledTimes(1);
  });

  it('the guest is stored BEFORE the /token exchange starts', async () => {
    const order: string[] = [];
    saveGuestMock.mockImplementation(async () => {
      order.push('save guest');
    });
    mintJwt.mockImplementation(async (token: string) => {
      order.push('token');
      return `jwt-for-${token}`;
    });
    await mount();
    expect(order).toEqual(['save guest', 'token']);
  });

  it('concurrent calls on a device with no stored guest sign up ONE guest', async () => {
    const pendingSignUp = deferred<{ sessionToken: string; firstName: string; lastName: string }>();
    signUp.mockImplementationOnce(() => pendingSignUp.promise);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    );
    // Startup's attempt is in flight (sign-up pending); the sheet's
    // "Continue as guest" and a second caller arrive meanwhile.
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    let both!: Promise<unknown>;
    act(() => {
      both = Promise.all([authApi.loginAsGuest(), authApi.loginAsGuest()]);
    });
    await act(async () => {
      pendingSignUp.resolve({ sessionToken: 'session-one', firstName: 'Welcome', lastName: 'Guest' });
      await both;
    });

    expect(signUp).toHaveBeenCalledTimes(1);
    expect(saveGuestMock).toHaveBeenCalledTimes(1);
    expect(authApi.session?.sessionToken).toBe('session-one');
  });
});

/**
 * refresh() must not write a result back over a principal change that landed
 * while `/token` was awaited (app architect, #309 review).
 */
describe('refresh during a principal change', () => {
  async function mountSignedIn() {
    loadSessionMock.mockResolvedValueOnce({
      accessToken: 'old-jwt',
      sessionToken: 'old-session',
      firstName: 'Old',
      lastName: 'User',
      isGuest: false,
    });
    await mount();
  }

  it('sign-out during the await: the old tokens are not re-persisted', async () => {
    await mountSignedIn();
    const pending = deferred<string>();
    mintJwt.mockImplementationOnce(() => pending.promise);

    let refreshed!: Promise<string | null>;
    act(() => {
      refreshed = handleUnauthorized();
    });
    await act(async () => {
      await authApi.logout();
    });
    await act(async () => {
      pending.resolve('jwt-for-the-old-session');
      expect(await refreshed).toBeNull();
    });

    await waitFor(() => expect(authApi.isGuest).toBe(true));
    const persisted = saveSessionMock.mock.calls.map(([session]) => session.sessionToken);
    expect(persisted).not.toContain('old-session');
    expect(authApi.session?.accessToken).not.toBe('jwt-for-the-old-session');
  });

  it('sign-in during the await: the new principal is kept', async () => {
    await mountSignedIn();
    const pending = deferred<string>();
    mintJwt.mockImplementationOnce(() => pending.promise);

    let refreshed!: Promise<string | null>;
    act(() => {
      refreshed = handleUnauthorized();
    });
    await act(async () => {
      await authApi.login('b@example.com', 'pw');
    });
    await act(async () => {
      pending.resolve('jwt-for-the-old-session');
      expect(await refreshed).toBeNull();
    });

    expect(authApi.session).toMatchObject({
      sessionToken: 'session-b@example.com',
      accessToken: 'jwt-for-session-b@example.com',
      isGuest: false,
    });
  });

  it('a 401 for the OLD session after a sign-in does not sign the new principal out', async () => {
    await mountSignedIn();
    const pending = deferred<string>();
    mintJwt.mockImplementationOnce(() => pending.promise);

    let refreshed!: Promise<string | null>;
    act(() => {
      refreshed = handleUnauthorized();
    });
    await act(async () => {
      await authApi.login('b@example.com', 'pw');
    });
    await act(async () => {
      pending.reject(new AuthError('Session ended.', 401, 'token'));
      expect(await refreshed).toBeNull();
    });

    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(authApi.session?.sessionToken).toBe('session-b@example.com');
  });
});

describe('sign-in, sign-up and sign-out', () => {
  it('sign-in stores the session token and its JWT', async () => {
    await mount();
    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    expect(authApi.session).toMatchObject({
      sessionToken: 'session-a@example.com',
      accessToken: 'jwt-for-session-a@example.com',
      isGuest: false,
    });
  });

  it('sign-up passes the mail-list opt-in through', async () => {
    await mount();
    await act(async () => {
      await authApi.register({
        email: 'new@example.com',
        password: 'Strong-pass-123!',
        firstName: 'Amina',
        registerToMailList: true,
      });
    });
    expect(signUp).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: 'new@example.com', registerToMailList: true }),
    );
    expect(authApi.session?.firstName).toBe('Amina');
    expect(authApi.isGuest).toBe(false);
  });

  it('a failed sign-in rejects and leaves the guest session in place', async () => {
    await mount();
    const guestSession = authApi.session;
    signIn.mockRejectedValueOnce(new AuthError('Invalid email or password', 401, 'sign-in'));
    await expect(
      act(async () => {
        await authApi.login('a@example.com', 'wrong');
      }),
    ).rejects.toThrow('Invalid email or password');
    expect(authApi.session).toBe(guestSession);
  });

  it('sign-out calls apps/auth with the session token, clears, and returns to the guest', async () => {
    await mount();
    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    await act(async () => {
      await authApi.logout();
    });
    expect(signOut).toHaveBeenCalledWith('session-a@example.com');
    expect(clearSessionMock).toHaveBeenCalled();
    await waitFor(() => expect(authApi.isGuest).toBe(true));
  });

  it('sign-out still clears locally when apps/auth is unreachable', async () => {
    await mount();
    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    signOut.mockRejectedValueOnce(new AuthError("Couldn't reach Ansari.", 0, 'sign-out'));
    await act(async () => {
      await authApi.logout();
    });
    expect(clearSessionMock).toHaveBeenCalled();
    await waitFor(() => expect(authApi.isGuest).toBe(true));
  });
});

/**
 * BLOCKER 2 regression: cached, user-scoped queries must not outlive a principal
 * transition, or one account's threads render for the next (routine here via the
 * guest → register flow on one device). Without the `queryClient.clear()` in
 * `applySession`, both assertions below fail — the seeded data survives.
 */
describe('AuthProvider clears the query cache on principal transitions', () => {
  it('signing in as a real account wipes the guest cache', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient); // signed in as guest

    queryClient.setQueryData(['conversations'], [{ id: 'A-thread', title: 'A secret' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.login('b@example.com', 'pw');
    });

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(false);
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });

  it('logging out of a real account wipes the cache and drops back to a guest', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient);

    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    expect(authApi.isGuest).toBe(false);
    queryClient.setQueryData(['conversations'], [{ id: 'A-thread' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.logout();
    });

    // logout clears the cache, then the app falls straight back to a guest.
    await waitFor(() => expect(authApi.isGuest).toBe(true));
    expect(authApi.status).toBe('signedIn');
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });
});
