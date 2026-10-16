import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/lib/color';

/**
 * Where a row meets the floating menu disc (top) or the composer
 * (bottom): the row doesn't stop, it dissolves — solid page colour at
 * the true edge, gone by the inner one. Not a bar, not a scrim: the
 * colour is the page's own, so the effect reads as the page thinning
 * out rather than something sitting on top of it.
 *
 * No grain rides along with it: `PaperBackground` turns the page's
 * film grain off on this screen (`app/_layout.tsx`'s `reading` check),
 * because a full column of answer text has no room for a texture
 * competing with the letterforms. The real backdrop this is dissolving
 * into is already flat, so the wash matches it by being flat too.
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
    />
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
