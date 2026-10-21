import {useLayoutEffect, useRef, useState} from 'react';
import {describeLinkOutcome} from '@saga-a2ui/components/faithful-card';
import type {FaithfulCardView} from '@saga-a2ui/react/faithful-card';

const REPOSITORY = 'https://github.com/MachineWisdomAI/saga-a2ui';

/** Optional application credit, separate from the unchanged upstream answer. */
export function SagaCredit({view, enabled}: {readonly view: Pick<FaithfulCardView, 'policy' | 'hostLinks'>; readonly enabled: boolean}) {
  const [status, setStatus] = useState('');
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = enabled;
    return () => { active.current = false; };
  }, [enabled]);
  if (!enabled) return null;
  const decision = view.policy.decideLink(REPOSITORY);
  async function open() {
    if (!active.current) return;
    const current = view.policy.decideLink(REPOSITORY);
    if (!current.allowed) return;
    const outcome = await view.hostLinks.open(current.url);
    if (active.current) setStatus(outcome === 'opened' ? '' : describeLinkOutcome(outcome, current.url));
  }
  return <footer className="saga-credit" data-testid="saga-credit" dir="ltr">
    Built with {decision.allowed
      ? <button type="button" onClick={() => { void open(); }}>saga a2ui</button>
      : <span>saga a2ui</span>}
    <span role="status">{status}</span>
  </footer>;
}
