import React from 'react';
import { Image, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';
import { night } from '@/constants/colors';
import { GRAIN_OPACITY } from '@/components/PaperBackground';

const grain = require('@/assets/images/grain.png');
const grainUri =
  Platform.OS === 'web'
    ? ((grain as { uri?: string })?.uri ?? (grain as unknown as string))
    : null;

/**
 * Where a row meets the floating menu disc (top) or the composer
 * (bottom): the row doesn't stop, it dissolves — solid page colour at
 * the true edge, gone by the inner one. Not a bar, not a scrim: the
 * colour is the page's own, so the effect reads as the page thinning
 * out rather than something sitting on top of it.
 *
 * `PaperBackground` paints the page's own film grain under everything,
 * which the colour wash alone doesn't carry — at the solid end the
 * wash used to read as a flat, ungrained panel sitting against the
 * grained page behind it, exactly where the dissolve was meant to feel
 * seamless. The same tile, at the same constant opacity the rest of
 * the page carries it at, rides along for the full height of the fade
 * so the solid end matches the paper it's dissolving into rather than
 * just its colour.
 *
 * Sized to clearance the layout already reserves (`threadContentTop`,
 * the composer's own top pad) rather than claiming new space, so a
 * screen that already scrolled correctly keeps scrolling identically —
 * this only paints over space that was already kept empty.
 */
export function ScrollEdgeFade({
  edge,
  height,
}: {
  edge: 'top' | 'bottom';
  height: number;
}) {
  const colors = useColors();
  const dark = useScheme() === 'dark';

  if (height <= 0) return null;

  const fade: [string, string] =
    edge === 'top'
      ? [colors.background, withAlpha(colors.background, 0)]
      : [withAlpha(colors.background, 0), colors.background];

  return (
    <LinearGradient
      colors={fade}
      locations={[0, 1]}
      style={[styles.wrap, { [edge]: 0, height } as ViewStyle]}
      pointerEvents="none"
    >
      {Platform.OS === 'web' ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundImage: `url(${grainUri})`,
              backgroundRepeat: 'repeat',
              backgroundSize: '96px 96px',
              opacity: dark ? GRAIN_OPACITY.dark : GRAIN_OPACITY.light,
              ...(dark ? { mixBlendMode: 'screen' } : null),
            } as ViewStyle,
          ]}
        />
      ) : (
        <Image
          source={grain}
          resizeMode="repeat"
          tintColor={dark ? night.bright : undefined}
          style={[
            StyleSheet.absoluteFill,
            { opacity: dark ? GRAIN_OPACITY.dark : GRAIN_OPACITY.light },
          ]}
          fadeDuration={0}
        />
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 5,
  },
});
