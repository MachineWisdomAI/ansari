// @vitest-environment jsdom
// The two password-reset routes (#304), `app/forgot-password.tsx` and
// `app/reset-password.tsx`. Tests live here because a file under `app/`
// is a route. The page chrome (`AuthPage`) is stood in for: what is under
// test is what each page sends, shows and keeps out of the address.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const routerDouble = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
}));
const searchParams = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock('expo-router', () => ({
  router: routerDouble,
  useLocalSearchParams: () => searchParams.current,
}));
vi.mock('@/components/PressableScale', async () => {
  const { Pressable } = await import('react-native');
  return { PressableScale: Pressable };
});
// A plain text input: react-native-web renders an email field as
// type="email", whose value the DOM itself strips of surrounding spaces,
// which would hide whether the screen trims (a native field does not).
vi.mock('@/components/AuthField', () => ({
  Field: ({
    value,
    onChangeText,
    testID,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    testID: string;
  }) => (
    <input data-testid={testID} value={value} onChange={(e) => onChangeText(e.target.value)} />
  ),
}));
vi.mock('@/components/AuthPage', () => ({
  AuthPage: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="auth-page">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </div>
  ),
  authPageStyles: {},
}));
const authApiDouble = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock('@/lib/auth/client', () => ({ authApi: authApiDouble }));
const openAuthSheet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authSheet', () => ({ openAuthSheet }));

import { AuthError } from '@/lib/auth/api';
import ForgotPasswordScreen from '@/app/forgot-password';
import ResetPasswordScreen from '@/app/reset-password';

const TOKEN = 'reset-token-abcdef0123456789';
const type = (testID: string, value: string) =>
  fireEvent.change(screen.getByTestId(testID), { target: { value } });
const press = async (testID: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testID));
  });
};

let consoleCalls: unknown[][];
beforeEach(() => {
  searchParams.current = {};
  consoleCalls = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('/forgot-password', () => {
  it('asks apps/auth for a reset with the trimmed email, then says "if an account exists"', async () => {
    authApiDouble.requestPasswordReset.mockResolvedValue(undefined);
    render(<ForgotPasswordScreen />);
    type('email-input', '  reader@example.com ');
    await press('reset-request-submit');
    expect(authApiDouble.requestPasswordReset).toHaveBeenCalledWith('reader@example.com');
    expect(screen.getByTestId('reset-request-sent').textContent).toMatch(
      /If an account exists for reader@example\.com/,
    );
  });

  it('shows the same confirmation for an address no account holds (no oracle)', async () => {
    authApiDouble.requestPasswordReset.mockResolvedValue(undefined);
    render(<ForgotPasswordScreen />);
    type('email-input', 'known@example.com');
    await press('reset-request-submit');
    const known = screen.getByTestId('reset-request-sent').textContent?.replace('known@', 'X@');
    cleanup();
    render(<ForgotPasswordScreen />);
    type('email-input', 'nobody@example.com');
    await press('reset-request-submit');
    const unknown = screen.getByTestId('reset-request-sent').textContent?.replace('nobody@', 'X@');
    expect(unknown).toBe(known);
  });

  it('an empty email is refused before any request', async () => {
    render(<ForgotPasswordScreen />);
    await press('reset-request-submit');
    expect(authApiDouble.requestPasswordReset).not.toHaveBeenCalled();
    expect(screen.getByTestId('reset-error')).toBeTruthy();
  });

  it('a rate limit or outage is an error, not a confirmation', async () => {
    authApiDouble.requestPasswordReset.mockRejectedValue(
      new AuthError('Too many attempts. Please wait a minute and try again.', 429, 'request-password-reset'),
    );
    render(<ForgotPasswordScreen />);
    type('email-input', 'reader@example.com');
    await press('reset-request-submit');
    expect(screen.getByTestId('reset-error').textContent).toMatch(/too many attempts/i);
    expect(screen.queryByTestId('reset-request-sent')).toBeNull();
  });

  it('"Back to sign in" raises the sign-in sheet over the home screen', async () => {
    render(<ForgotPasswordScreen />);
    await press('back-to-sign-in');
    expect(openAuthSheet).toHaveBeenCalledWith('login');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });
});

describe('/reset-password', () => {
  /**
   * The emailed link, as the router delivers it: the page opened with
   * `?token=` hands the token over and replaces itself with a plain
   * `/reset-password`, which mounts as a new page with no params.
   */
  function open(token: string | null = TOKEN) {
    if (token !== null) {
      searchParams.current = { token };
      render(<ResetPasswordScreen />);
      cleanup();
    }
    searchParams.current = {};
    return render(<ResetPasswordScreen />);
  }

  it('the link page replaces itself with a plain /reset-password and shows nothing itself', () => {
    searchParams.current = { token: TOKEN };
    render(<ResetPasswordScreen />);
    expect(routerDouble.replace).toHaveBeenCalledWith('/reset-password');
    expect(screen.queryByTestId('new-password-input')).toBeNull();
    expect(JSON.stringify(routerDouble.replace.mock.calls)).not.toContain(TOKEN);
    // The replacement page it navigated to, as the router mounts it.
    cleanup();
    searchParams.current = {};
    render(<ResetPasswordScreen />);
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
  });

  it('a reload of the clean page (the hand-off is memory only) offers a new link', () => {
    open(null);
    expect(screen.getByText('This link no longer works')).toBeTruthy();
  });

  it('sets the new password with the token from the link, then sends the reader to sign in', async () => {
    authApiDouble.resetPassword.mockResolvedValue(undefined);
    open();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    expect(authApiDouble.resetPassword).toHaveBeenCalledWith(TOKEN, 'New-pass-123!');
    expect(screen.getByText('Password changed')).toBeTruthy();
    await press('reset-sign-in');
    expect(openAuthSheet).toHaveBeenCalledWith('login');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });

  it.each([
    ['too short', 'short', 'short', /at least 8/],
    ['mismatched', 'New-pass-123!', 'New-pass-124!', /do not match/],
  ])('a %s password is refused before any request', async (_label, pw, confirm, message) => {
    open();
    type('new-password-input', pw);
    type('confirm-password-input', confirm);
    await press('reset-submit');
    expect(authApiDouble.resetPassword).not.toHaveBeenCalled();
    expect(screen.getByTestId('reset-error').textContent).toMatch(message);
  });

  it('an expired or used token turns the page into "ask for a new link"', async () => {
    authApiDouble.resetPassword.mockRejectedValue(
      new AuthError('Invalid or expired reset token', 400, 'reset-password'),
    );
    open();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    expect(screen.getByText('This link no longer works')).toBeTruthy();
    await press('reset-request-new');
    expect(routerDouble.replace).toHaveBeenCalledWith('/forgot-password');
  });

  it("a weak password shows apps/auth's message and keeps the form", async () => {
    authApiDouble.resetPassword.mockRejectedValue(
      new AuthError('Password is too weak. Use a mix of letters, numbers and symbols.', 400, 'reset-password'),
    );
    open();
    type('new-password-input', 'weakweak');
    type('confirm-password-input', 'weakweak');
    await press('reset-submit');
    expect(screen.getByTestId('reset-error').textContent).toMatch(/too weak/);
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
  });

  it('with no token in the link, offers a new link instead of a form', () => {
    open(null);
    expect(screen.getByText('This link no longer works')).toBeTruthy();
    expect(screen.queryByTestId('new-password-input')).toBeNull();
  });

  it('leaving the page forgets the token: the next clean page has none', () => {
    open();
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
    cleanup();
    open(null);
    expect(screen.getByText('This link no longer works')).toBeTruthy();
  });

  it('after a reset, the hand-off is cleared: a second clean page has no token', async () => {
    authApiDouble.resetPassword.mockResolvedValue(undefined);
    open();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    cleanup();
    open(null);
    expect(screen.getByText('This link no longer works')).toBeTruthy();
  });

  it('the token is never logged and never rendered, on any outcome', async () => {
    for (const outcome of ['ok', 'dead', 'weak', 'network'] as const) {
      cleanup();
      authApiDouble.resetPassword.mockReset();
      if (outcome === 'ok') authApiDouble.resetPassword.mockResolvedValue(undefined);
      if (outcome === 'dead')
        authApiDouble.resetPassword.mockRejectedValue(
          new AuthError('Invalid or expired reset token', 400, 'reset-password'),
        );
      if (outcome === 'weak')
        authApiDouble.resetPassword.mockRejectedValue(new AuthError('Too weak', 400, 'reset-password'));
      if (outcome === 'network')
        authApiDouble.resetPassword.mockRejectedValue(new AuthError("Couldn't reach Ansari.", 0, 'reset-password'));
      open();
      type('new-password-input', 'New-pass-123!');
      type('confirm-password-input', 'New-pass-123!');
      await press('reset-submit');
      await waitFor(() => expect(authApiDouble.resetPassword).toHaveBeenCalled());
      expect(document.body.innerHTML).not.toContain(TOKEN);
    }
    expect(JSON.stringify(consoleCalls)).not.toContain(TOKEN);
  });

  it('the rendering check can fail (a near-miss: the token, when rendered, is found)', () => {
    render(<span>{TOKEN}</span>);
    expect(document.body.innerHTML).toContain(TOKEN);
  });
});
