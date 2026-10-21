import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createContentPolicy, NO_HOST_LINKS} from '@saga-a2ui/components/faithful-card';
import {SagaCredit} from '../src/view/saga-credit.js';

test('branding can omit the credit, while policy controls whether its link is actionable', () => {
  for (const level of ['standard', 'strict'] as const) {
    const result = createContentPolicy({level});
    assert.ok(result.ok);
    const view = {policy: result.policy, hostLinks: NO_HOST_LINKS};
    assert.equal(renderToStaticMarkup(createElement(SagaCredit, {view, enabled: false})), '');
    const shown = renderToStaticMarkup(createElement(SagaCredit, {view, enabled: true}));
    assert.match(shown, /Built with/);
    assert.match(shown, /saga a2ui/);
    assert.equal(shown.includes('<button'), level === 'standard');
  }
});
