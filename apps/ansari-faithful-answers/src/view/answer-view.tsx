import {A2uiSurface} from '@saga-a2ui/react/a2ui';
import {FaithfulCardProvider, type FaithfulCardView} from '@saga-a2ui/react/faithful-card';
import {useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import {SagaCredit} from './saga-credit.js';
import {BRANDING} from './branding.js';
import type {AnswerSurface} from './answer-surface.js';
import {watchAttribution} from './attribution.js';

// The consumer-owned React wrapper around the shared card. It supplies the question header and the
// footer treatment (data-attribution -> theme.css); the answer itself is the card's, rendered from the
// A2UI surface exactly as the shared reader interpreted it, once. The footer mark is taken from the
// paragraph the card rendered (attribution.ts), never from a second reading of the Markdown. It chooses
// no artwork, no policy and no text of an answer: artwork and colors are the app's constants
// (floral-artwork.ts, theme.css, both loaded by the composition root).

export type ViewState =
  | {readonly kind: 'waiting'; readonly text: string}
  | {readonly kind: 'answer'; readonly question: string; readonly revision: number}
  | {readonly kind: 'problem'; readonly text: string};

/** The view's state as an external store: every change is a new snapshot object. */
export function createViewStore(initial: ViewState) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: ViewState): void {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (): ViewState => current,
  };
}
export type ViewStore = ReturnType<typeof createViewStore>;

export function AnswerView(props: {readonly view: FaithfulCardView; readonly answer: AnswerSurface; readonly store: ViewStore}) {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get, props.store.get);
  const card = useRef<HTMLElement>(null);
  const showingAnswer = state.kind === 'answer';
  useLayoutEffect(() => (card.current === null ? undefined : watchAttribution(card.current)), [showingAnswer]);
  return (
    <FaithfulCardProvider view={props.view}>
      <main>
        {state.kind === 'answer' ? (
          <article ref={card} className="answer-card" data-testid="answer-card">
            <header className="answer-header">
              {state.question === '' ? null : (
                <h2 className="answer-question" dir="auto" data-testid="question">
                  {state.question}
                </h2>
              )}
            </header>
            {/* Each delivered answer is a fresh card: its list numbering, link outcomes and consent are never carried over from the previous one. */}
            <A2uiSurface key={state.revision} surface={props.answer.surface} />
            <SagaCredit key={`credit-${state.revision}`} view={props.view} enabled={BRANDING.showSagaCredit} />
          </article>
        ) : null}
        <p className="answer-status" role="status" data-testid="answer-status">
          {state.kind === 'answer' ? '' : state.text}
        </p>
      </main>
    </FaithfulCardProvider>
  );
}
