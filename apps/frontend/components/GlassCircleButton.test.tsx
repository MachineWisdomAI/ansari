// @vitest-environment jsdom
/**
 * Covers the blur-fallback path (iOS pre-Liquid-Glass, Android, web) —
 * the one path all five consumers share, since Liquid Glass itself
 * only runs on a real iOS 26 device and can't be rendered here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('expo-glass-effect', () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
}));

let scheme: 'light' | 'dark' = 'light';
vi.mock('@/hooks/useScheme', () => ({ useScheme: () => scheme }));

import colors from '@/constants/colors';
import { GlassCircleButton } from '@/components/GlassCircleButton';

afterEach(() => {
  cleanup();
  scheme = 'light';
});

function renderDisc() {
  render(
    <GlassCircleButton onPress={() => {}} accessibilityLabel="Menu" testID="btn">
      <></>
    </GlassCircleButton>,
  );
  // The Pressable (testID) renders the bordered, filled disc as its one
  // child — nothing else sits between them on this path.
  return screen.getByTestId('btn').firstElementChild as HTMLElement;
}

// Renders a plain element with the given style and reads back how the
// browser normalises it, so the assertion doesn't have to guess jsdom's
// own rgb()/rgba() string format. jsdom only synthesises the per-edge
// longhand (`borderTopColor`) reliably from an inline style, not the
// shorthand, which is also what react-native-web itself emits.
function computedTopColorFor(borderTopColor: string): string {
  const { container } = render(<div style={{ borderTopColor }} />);
  return getComputedStyle(container.firstElementChild as HTMLElement)
    .borderTopColor;
}

describe('GlassCircleButton — rim colour per scheme', () => {
  it('draws the border-token rim in light mode', () => {
    scheme = 'light';
    const disc = renderDisc();
    expect(getComputedStyle(disc).borderTopColor).toBe(
      computedTopColorFor(colors.light.border),
    );
  });

  it('switches to the glass-rim light-catch colour in dark mode', () => {
    scheme = 'dark';
    const disc = renderDisc();
    expect(getComputedStyle(disc).borderTopColor).toBe(
      computedTopColorFor(colors.dark.glassRim),
    );
  });

  it('draws a visible rim width regardless of scheme', () => {
    const disc = renderDisc();
    expect(parseFloat(getComputedStyle(disc).borderTopWidth)).toBeGreaterThan(
      0,
    );
  });

  it('fills the disc, so the blur alone is never what has to carry the shape', () => {
    // The fill sits on the inner wash View this path draws over the
    // blur, not on the bordered disc itself — see the component's own
    // layering comment.
    const fillLayer = renderDisc().firstElementChild as HTMLElement;
    const bg = getComputedStyle(fillLayer).backgroundColor;
    expect(bg).not.toBe('');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });
});
