// @vitest-environment jsdom
/**
 * `expo-linear-gradient` falls back to a native-module shim outside
 * Metro's platform resolution (no `backgroundImage`, no colour
 * passthrough), so the gradient itself is stood in for here — what's
 * under test is which colours this component hands it, in which
 * order, not the library's own rendering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({
    colors,
    pointerEvents,
  }: {
    colors: string[];
    pointerEvents?: string;
  }) => (
    <div
      data-testid="gradient"
      data-colors={JSON.stringify(colors)}
      data-pointer-events={pointerEvents}
    />
  ),
}));

import { ScrollEdgeFade } from '@/components/ScrollEdgeFade';

afterEach(cleanup);

function stopsFor(edge: 'top' | 'bottom', height = 40): string[] {
  render(<ScrollEdgeFade edge={edge} height={height} />);
  return JSON.parse(screen.getByTestId('gradient').dataset.colors!);
}

describe('ScrollEdgeFade', () => {
  it('is solid at the true top edge and transparent by the inner one', () => {
    const [outer, inner] = stopsFor('top');
    expect(outer).not.toMatch(/,\s*0\)$/);
    expect(inner).toMatch(/,\s*0\)$/);
  });

  it('is transparent at the inner bottom edge and solid by the true one', () => {
    const [inner, outer] = stopsFor('bottom');
    expect(inner).toMatch(/,\s*0\)$/);
    expect(outer).not.toMatch(/,\s*0\)$/);
  });

  it('never intercepts a touch meant for the content under it', () => {
    render(<ScrollEdgeFade edge="top" height={40} />);
    expect(screen.getByTestId('gradient').dataset.pointerEvents).toBe('none');
  });

  it('renders nothing when the layout has reserved no clearance for it', () => {
    const { container } = render(<ScrollEdgeFade edge="top" height={0} />);
    expect(container.firstChild).toBeNull();
  });
});
