import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableStateCallbackType,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useColors } from '@/hooks/useColors';
import { useScheme } from '@/hooks/useScheme';
import { withAlpha } from '@/lib/color';
import { isHovered } from '@/lib/web';
import { rounded } from '@/constants/radius';

const liquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * A floating circular chrome button. On modern iOS it renders native
 * Liquid Glass and stays out of its way: `isInteractive` gives the
 * system's own touch shimmer, so the pressable adds no effects of its
 * own there. Other iOS versions get a real blur, Android/web a crafted
 * translucent linen fallback.
 *
 * Every path draws the same hairline rim, the same quiet fill
 * (`glassButtonFill`) and the same contact shadow, on a plain bordered
 * View that wraps whichever effect is rendering inside it — rather
 * than a ring, and rather than trusting each effect to carry the shape
 * on its own. Real Liquid Glass *can* read as a disc with nothing but
 * its own rendering over varied content, but this app's flat paper —
 * and the thread screen's scroll-edge fade, which washes the page down
 * to one flat colour right where the button sits — leaves it nothing
 * to refract, and GlassView's own border/background sit behind its
 * native subview where they aren't reliably visible regardless. One
 * wrapper, drawn the same way on every path, is what actually holds up
 * everywhere.
 *
 * The rim stays quiet throughout — static edge, not a ring that would
 * react — so press and hover still have to be carried by the fill: a
 * breath of the page's own ink washed over the disc, which moves the
 * right way in both modes — rather than by fading the whole button
 * toward the paper, which now takes its resting shape with it.
 */
export function GlassCircleButton({
  onPress,
  onLongPress,
  size = 46,
  children,
  accessibilityLabel,
  testID,
  style,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  size?: number;
  children: React.ReactNode;
  /**
   * What the button does, said in words. These carry an icon and
   * nothing else, so without this a screen reader has only the test id
   * or silence to announce.
   */
  accessibilityLabel?: string;
  testID?: string;
  style?: object;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const dark = scheme === 'dark';
  // `glassRim` is a light catching an edge — it reads against a dark
  // backdrop and vanishes against light paper, the same split HeaderBar
  // makes for its own hairline.
  const rimColor = dark ? colors.glassRim : colors.border;
  const circle = {
    width: size,
    height: size,
    ...rounded(size / 2),
  };

  /**
   * Press and hover, drawn in the page's own ink so one recipe serves
   * both modes: `foreground` is dark on paper and light on charcoal, so
   * a wash of it always moves the disc away from its resting value
   * rather than toward the backdrop.
   */
  const stateWash = (state: PressableStateCallbackType) =>
    state.pressed
      ? withAlpha(colors.foreground, 0.14)
      : isHovered(state)
        ? withAlpha(colors.foreground, 0.06)
        : 'transparent';

  const surface = (state: PressableStateCallbackType) => {
    if (liquidGlass) {
      // The rim and fill are drawn by a plain View around the glass,
      // not by GlassView's own style — GlassView composites its native
      // UIVisualEffectView as a full-bleed subview of itself, and a
      // border/background set on GlassView directly sits behind that
      // subview where it isn't reliably visible. A bordered, filled
      // View is the one mechanism already proven to show up over any
      // backdrop (it's the same View the two fallback paths below use
      // for the same job), so it wraps the glass here instead of
      // trusting the effect to carry the shape on its own.
      return (
        <View
          style={[
            circle,
            styles.clip,
            {
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: rimColor,
              backgroundColor: colors.glassButtonFill,
            },
          ]}
        >
          <GlassView
            style={[StyleSheet.absoluteFill, styles.center]}
            glassEffectStyle="regular"
            isInteractive
            // Pin the glass to the app's scheme. Left on 'auto', each button
            // adapts to the brightness of the video drifting behind it, and
            // the pair can split light/dark on the same screen.
            colorScheme={scheme}
          >
            {children}
          </GlassView>
        </View>
      );
    }
    if (Platform.OS === 'ios' || Platform.OS === 'web') {
      // Real backdrop blur — a system-material look on older iOS, CSS
      // backdrop-filter on web. The wash over it is what the eye reads
      // as the disc, so it carries the shape the rim used to draw.
      return (
        <View
          style={[
            circle,
            styles.clip,
            { borderWidth: StyleSheet.hairlineWidth, borderColor: rimColor },
          ]}
        >
          <BlurView
            intensity={36}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              styles.center,
              { backgroundColor: colors.glassButtonFill },
            ]}
          >
            {children}
          </View>
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: stateWash(state) },
            ]}
          />
        </View>
      );
    }
    return (
      <View
        style={[
          circle,
          styles.center,
          styles.clip,
          {
            // Android has no blur here, so the wash is the material.
            backgroundColor: colors.glassButtonFill,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: rimColor,
          },
        ]}
      >
        {children}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: stateWash(state) },
          ]}
        />
      </View>
    );
  };

  // The contact shadow that stands in for the removed rim. It has to
  // live out here rather than on the disc: every path's disc clips its
  // own effect now, and a clipped layer cannot cast anything past its
  // own bounds.
  const depth = {
    ...rounded(size / 2),
    boxShadow: `0 1px 2px ${colors.shadowTintSoft}, 0 4px 12px ${colors.shadowTint}`,
  } as object;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[style, styles.pointer, depth]}
    >
      {(state) => surface(state)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    overflow: 'hidden',
  },
  pointer: {
    cursor: 'pointer',
  },
});
