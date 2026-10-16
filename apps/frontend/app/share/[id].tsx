import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { useScreenLandmark } from '@/hooks/useScreenLandmark';
import {
  setSourcePanelOpen,
  useSourcePanelInset,
  useSourcePanelPresentation,
} from '@/hooks/useSourcePanel';
import { fonts } from '@/constants/colors';
import {
  phoneGutter,
  READING_COLUMN,
  THREAD_BOTTOM_PAD,
  THREAD_GAP,
  threadContentTop,
} from '@/constants/layout';
import { RADIUS, rounded } from '@/constants/radius';
import { heading, OFFSCREEN } from '@/lib/semantics';
import { isHovered } from '@/lib/web';
import { AnswerMessage } from '@/components/AnswerMessage';
import { AskedQuestion } from '@/components/AskedQuestion';
import { PressableScale } from '@/components/PressableScale';
import { answerExcerpt, SourcePanel, type SourceRequest } from '@/components/SourcePanel';
import type { ConversationDetail, Message } from '@/lib/api';
import { loadSharedThread, ShareNotFoundError } from '@/lib/api/share';

/**
 * A shared thread, read-only: the link apps/api hands out as `share_url`.
 *
 * Public by design — fetched without a bearer (see `lib/api/share`) and
 * rendered while the session is still restoring, with no rail and no
 * composer. The one way on is into Ansari's own home; the thread stays the
 * sharer's and is never copied into the viewer's threads.
 */
export default function SharedThreadScreen() {
  const colors = useColors();
  const screenLandmark = useScreenLandmark();
  const insets = useSafeAreaInsets();
  const desktop = useDesktop();
  const { width } = useWindowDimensions();
  const gutter = phoneGutter(width);
  const { id } = useLocalSearchParams<{ id: string }>();
  const shareId = id ?? '';

  // Held here rather than in the query cache: the cache is the viewer's,
  // and is wiped (in-flight requests cancelled) whenever their session is
  // restored or changes — which can happen while a share is loading.
  // Each load is keyed by the share and the attempt, so a retry shows the
  // loading state again rather than the failure it is replacing.
  const [attempt, setAttempt] = useState(0);
  const loadKey = `${shareId}#${attempt}`;
  const [result, setResult] = useState<
    | { key: string; state: 'loaded'; data: ConversationDetail }
    | { key: string; state: 'missing' | 'failed' }
    | null
  >(null);
  useEffect(() => {
    let active = true;
    const key = `${shareId}#${attempt}`;
    loadSharedThread(shareId).then(
      (data) => active && setResult({ key, state: 'loaded', data }),
      (error: unknown) =>
        active &&
        setResult({
          key,
          state: error instanceof ShareNotFoundError ? 'missing' : 'failed',
        }),
    );
    return () => {
      active = false;
    };
  }, [shareId, attempt]);
  const share =
    result && result.key === loadKey ? result : ({ state: 'loading' } as const);

  // The sources apparatus, exactly as the thread opens it.
  const [sources, setSources] = useState<SourceRequest | null>(null);
  const sourceRequests = useRef(0);
  const sourcesAsPanel = useSourcePanelPresentation();
  const sourcesInset = useSourcePanelInset();
  const panelOpen = sources !== null && sourcesAsPanel;
  useEffect(() => {
    setSourcePanelOpen(panelOpen);
  }, [panelOpen]);
  useEffect(() => () => setSourcePanelOpen(false), []);
  const openSources = (message: Message, marker: number) => {
    sourceRequests.current += 1;
    setSources({
      messageId: message.id,
      citations: [...message.citations].sort((a, b) => a.marker - b.marker),
      marker,
      excerpt: answerExcerpt(message.content),
      requestKey: sourceRequests.current,
    });
  };

  const notFound = share.state === 'missing';
  const title = share.state === 'loaded' ? share.data.title : '';
  const column = [
    styles.messages,
    !desktop && { paddingHorizontal: gutter },
    desktop && styles.messagesDesktop,
    { paddingTop: threadContentTop(desktop, insets.top) },
  ];

  const continueButton = (
    <PressableScale
      onPress={() => router.replace('/')}
      accessibilityRole="link"
      accessibilityLabel="Continue in Ansari"
      testID="share-continue"
      style={(state) => [
        styles.continueButton,
        {
          backgroundColor: colors.primary,
          ...rounded(RADIUS.pill),
          opacity: state.pressed ? 0.85 : isHovered(state) ? 0.92 : 1,
        },
      ]}
    >
      <Text style={[styles.continueText, { color: colors.primaryForeground }]}>
        Continue in Ansari
      </Text>
    </PressableScale>
  );

  return (
    <Animated.View style={[styles.flex, sourcesAsPanel && sourcesInset]} {...screenLandmark}>
      {Platform.OS === 'web' && (
        <Head>
          <title>{title ? `${title} · Ansari` : 'Shared conversation · Ansari'}</title>
        </Head>
      )}
      {Platform.OS === 'web' && !!title && (
        <Text style={OFFSCREEN} {...heading(1)}>
          {title}
        </Text>
      )}
      {share.state === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : share.state !== 'loaded' ? (
        <View style={[styles.center, { paddingHorizontal: gutter }]}>
          <Feather
            name={notFound ? 'link-2' : 'alert-circle'}
            size={22}
            color={notFound ? colors.mutedForeground : colors.destructive}
          />
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
            {notFound
              ? 'This shared conversation doesn’t exist, or is no longer shared.'
              : 'This shared conversation didn’t load. Check your connection.'}
          </Text>
          {!notFound && (
            <PressableScale
              onPress={() => setAttempt((n) => n + 1)}
              accessibilityRole="button"
              accessibilityLabel="Try loading this shared conversation again"
              testID="share-retry"
              style={(state) => [
                styles.retryButton,
                {
                  borderColor: colors.border,
                  ...rounded(RADIUS.pill),
                  opacity: state.pressed ? 0.72 : isHovered(state) ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.continueText, { color: colors.foreground }]}>
                Try again
              </Text>
            </PressableScale>
          )}
          {continueButton}
        </View>
      ) : (
        <FlatList
          data={share.data.messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={column}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) =>
            item.role === 'user' ? (
              <AskedQuestion text={item.content} selectable={Platform.OS === 'web'} />
            ) : (
              <AnswerMessage message={item} onSourcesOpen={openSources} />
            )
          }
          ListFooterComponent={<View style={styles.footer}>{continueButton}</View>}
        />
      )}
      <SourcePanel request={sources} onClose={() => setSources(null)} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  statusText: {
    fontSize: 14,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
  messages: {
    flexGrow: 1,
    paddingBottom: THREAD_BOTTOM_PAD.phone,
    gap: THREAD_GAP.phone,
  },
  messagesDesktop: {
    width: '100%',
    maxWidth: READING_COLUMN,
    alignSelf: 'center',
    paddingBottom: THREAD_BOTTOM_PAD.desktop,
    gap: THREAD_GAP.desktop,
  },
  footer: { alignItems: 'center', paddingTop: 8 },
  continueButton: {
    minHeight: 44,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButton: {
    minHeight: 44,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  continueText: { fontSize: 14, fontFamily: fonts.bodySemiBold },
});
