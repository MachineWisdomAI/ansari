import React, { useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { authApi } from '@/lib/auth/client';
import { AuthError } from '@/lib/auth/api';
import { openAuthSheet } from '@/lib/authSheet';
import { Field } from '@/components/AuthField';
import { AuthPage, authPageStyles as styles } from '@/components/AuthPage';
import { PressableScale } from '@/components/PressableScale';

/**
 * `/forgot-password` (#304): ask apps/auth for a reset email. The address
 * is legacy web's, kept because old links and the released app point here.
 *
 * The answer is the same whether or not an account holds the address
 * (apps/auth answers alike; this page must not tell them apart either), so
 * success always reads "if an account exists". Only a failure to reach
 * apps/auth, or its rate limit, is shown as an error.
 */
export default function ForgotPasswordScreen() {
  const colors = useColors();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter the email you signed up with.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.requestPasswordReset(trimmed);
      setSent(true);
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const backToSignIn = () => {
    openAuthSheet('login');
    router.replace('/');
  };

  return (
    <AuthPage
      documentTitle="Reset your password · Ansari"
      title="Reset your password"
      subtitle="Enter your account's email and we'll send you a link to choose a new password."
    >
      {sent ? (
        <Text style={[styles.note, { color: colors.foreground }]} testID="reset-request-sent">
          If an account exists for {email.trim()}, a link to reset its password is on its way.
          It works once, for one hour.
        </Text>
      ) : (
        <>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            inputMode="email"
            onSubmitEditing={submit}
            returnKeyType="send"
            testID="email-input"
          />
          {error && (
            <Text style={[styles.error, { color: colors.destructive }]} testID="reset-error">
              {error}
            </Text>
          )}
          <PressableScale
            onPress={submit}
            disabled={submitting}
            accessibilityRole="button"
            testID="reset-request-submit"
            style={(state) => [
              styles.button,
              {
                backgroundColor: colors.primary,
                opacity: submitting ? 0.7 : state.pressed ? 0.85 : 1,
              },
            ]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                Send reset link
              </Text>
            )}
          </PressableScale>
        </>
      )}
      <PressableScale
        onPress={backToSignIn}
        accessibilityRole="button"
        testID="back-to-sign-in"
        style={styles.link}
      >
        <Text style={[styles.linkText, { color: colors.foreground, fontFamily: fonts.bodyMedium }]}>
          Back to sign in
        </Text>
      </PressableScale>
    </AuthPage>
  );
}
