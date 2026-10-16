import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { authApi } from '@/lib/auth/client';
import { AuthError } from '@/lib/auth/api';
import { openAuthSheet } from '@/lib/authSheet';
import { Field } from '@/components/AuthField';
import { AuthPage, authPageStyles as styles } from '@/components/AuthPage';
import { PressableScale } from '@/components/PressableScale';

/** What apps/auth answers for a token that is unknown, expired or used. */
const INVALID_TOKEN = 'Invalid or expired reset token';

type Outcome = 'form' | 'done' | 'dead-link';

/**
 * The token, between the link's page and the clean page that replaces it.
 * Memory only: never persisted, never in a URL, gone on a reload.
 */
const handoff: { token: string | null } = { token: null };

/**
 * `/reset-password?token=…` (#304): the page the reset email links to, on
 * the web directly and on native through the `ansarichat` scheme. The path
 * and the `token` query are fixed by apps/auth's email and by the released
 * app, which link here; neither may change.
 *
 * The token is a credential. The page the link opens hands it over in
 * memory and replaces itself with a plain `/reset-password`, so the token
 * leaves the URL bar, the history entry and the router's own state (which
 * would otherwise write it back into the address: expo-router re-syncs the
 * URL from navigation state, verified in a browser). It is never logged.
 *
 * A reset ends every session of the account (apps/auth), so success does
 * not sign anyone in here: it sends the reader to sign in with the new
 * password. If this device was signed in as that account, its next request
 * finds the session gone and it falls back to its guest.
 */
export default function ResetPasswordScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const fromLink = (Array.isArray(params.token) ? params.token[0] : params.token)?.trim() || null;
  const [token] = useState(() => fromLink ?? handoff.token);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(token ? 'form' : 'dead-link');

  const linkPage = params.token !== undefined;
  useEffect(() => {
    if (!linkPage) return;
    handoff.token = fromLink;
    router.replace('/reset-password');
    // Only on arrival from the link; the clean page has no `token` param.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the clean page forgets the token, whatever happened on it.
  useEffect(
    () => () => {
      if (!linkPage) handoff.token = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );


  const submit = async () => {
    if (submitting || !token) return;
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword(token, password);
      setOutcome('done');
    } catch (e) {
      if (e instanceof AuthError && e.status === 400 && e.message === INVALID_TOKEN) {
        setOutcome('dead-link');
      } else {
        setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const signIn = () => {
    openAuthSheet('login');
    router.replace('/');
  };

  // The link's page only hands the token over; the clean page shows the form.
  if (linkPage) return null;

  if (outcome === 'done') {
    return (
      <AuthPage
        documentTitle="Password changed · Ansari"
        title="Password changed"
        subtitle="You've been signed out everywhere. Sign in with your new password."
      >
        <PrimaryButton label="Log in" onPress={signIn} testID="reset-sign-in" />
      </AuthPage>
    );
  }

  if (outcome === 'dead-link') {
    return (
      <AuthPage
        documentTitle="Reset link expired · Ansari"
        title="This link no longer works"
        subtitle="Reset links work once, for one hour. Ask for a new one and use the newest email."
      >
        <PrimaryButton
          label="Send a new link"
          onPress={() => router.replace('/forgot-password')}
          testID="reset-request-new"
        />
      </AuthPage>
    );
  }

  return (
    <AuthPage
      documentTitle="Choose a new password · Ansari"
      title="Choose a new password"
      subtitle="At least 8 characters. Mix letters, numbers and symbols."
    >
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        testID="new-password-input"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        onSubmitEditing={submit}
        returnKeyType="go"
        testID="confirm-password-input"
      />
      {error && (
        <Text style={[styles.error, { color: colors.destructive }]} testID="reset-error">
          {error}
        </Text>
      )}
      <PrimaryButton
        label="Set new password"
        onPress={submit}
        busy={submitting}
        testID="reset-submit"
      />
    </AuthPage>
  );
}

function PrimaryButton({
  label,
  onPress,
  busy = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  testID: string;
}) {
  const colors = useColors();
  return (
    <PressableScale
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      testID={testID}
      style={(state) => [
        styles.button,
        {
          backgroundColor: colors.primary,
          opacity: busy ? 0.7 : state.pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.primaryForeground} />
      ) : (
        <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{label}</Text>
      )}
    </PressableScale>
  );
}
