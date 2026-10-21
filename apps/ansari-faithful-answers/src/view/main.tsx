import '@saga-a2ui/react/faithful-card.css';
import './theme.css';
import {applyHostTheme} from './host-theme.js';
import {App, PostMessageTransport} from '@modelcontextprotocol/ext-apps';
import type {HostLinks} from '@saga-a2ui/components/faithful-card';
import {connectToolResultView, type ToolResultViewConnection} from '@saga-a2ui/mcp/view';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BRANDING} from './branding.js';
import {ownSizing} from './owned-sizing.js';
import {APP_VERSION} from '../version.js';
import {classifyToolResult, type ToolResultLike} from './tool-result.js';
import {AnswerView, createViewStore} from './answer-view.js';
import {openAnswerSurface} from './answer-surface.js';
import {createContentView} from './content-view.js';
import {CONTENT_POLICY_ELEMENT_ID, policyFromEmbedded} from './embedded-policy.js';
import {installFloralArtwork} from './floral-artwork.js';
import {loadKitab} from './fonts.js';

// Application composition: SAGA owns the card and MCP bridge; Ansari owns branding and answer mapping.

const lifetime = new AbortController();
const root = document.documentElement;
installFloralArtwork(root);

const container = document.getElementById('root');
if (container === null) throw new Error('The page has no #root element.');
const reactRoot = createRoot(container);
const store = createViewStore({kind: 'waiting', text: BRANDING.waitingText});

const policy = policyFromEmbedded(document.getElementById(CONTENT_POLICY_ELEMENT_ID)?.textContent ?? null);
if (!policy.ok) {
  // A view is never mounted on a guessed policy.
  store.set({kind: 'problem', text: 'This view could not start: its content policy is not valid.'});
  reactRoot.render(<main><p className="answer-status" role="alert">{'This view could not start: its content policy is not valid.'}</p></main>);
} else {
  const app = new App({name: BRANDING.name, version: APP_VERSION}, {}, {autoResize: false});
  // Links leave only through the negotiated host capability. No navigation fallback exists: a host
  // without `openLinks`, a refusal or a failure leaves the link inert with an explicit outcome.
  const hostLinks: HostLinks = {
    async open(url) {
      if (lifetime.signal.aborted || app.getHostCapabilities()?.openLinks === undefined) return 'unavailable';
      try {
        return (await app.openLink({url})).isError === true ? 'denied' : 'opened';
      } catch {
        return 'failed';
      }
    },
  };
  const view = createContentView({policy: policy.policy, hostLinks, document});
  const answer = openAnswerSurface();
  reactRoot.render(
    <StrictMode>
      <AnswerView view={view} answer={answer} store={store} />
    </StrictMode>,
  );

  // View-local state: a result delivered before the handshake completes waits and is shown once ready.
  let ready = false;
  let revision = 0;
  let pending: ToolResultLike | undefined;

  const problem = (text: string): void => {
    answer.clear();
    store.set({kind: 'problem', text});
  };

  /**
   * Replaces the answer shown. A result that is not the published envelope, or an error, clears it and
   * says so. Every result is a new selection, so it first revokes the view's image consent: an answer
   * equal to the previous one would otherwise look unchanged to the card and keep the earlier grant.
   */
  const present = (result: ToolResultLike): void => {
    if (lifetime.signal.aborted) return;
    view.consent.revokeAll();
    const classified = classifyToolResult(result);
    if (classified.kind === 'rejected') {
      problem(classified.text);
      return;
    }
    const shown = answer.show(classified.envelope);
    if (!shown.ok) {
      problem('This result could not be displayed.');
      return;
    }
    store.set({
      kind: 'answer',
      question: classified.envelope.question,
      revision: ++revision,
    });
  };

  const retire = (): void => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    view.consent.retire();
    app.onhostcontextchanged = undefined;
    reactRoot.unmount();
  };

  let connection: ToolResultViewConnection | undefined;
  app.onhostcontextchanged = context => {
    if (!lifetime.signal.aborted) applyHostTheme(root, context, app.getHostVersion()?.name);
  };
  window.addEventListener('pagehide', () => {
    retire();
    if (connection) connection.dispose();
    else void app.close().catch(() => {});
  }, {once: true});

  // Do not present an answer using a substituted device font if embedded fonts fail.
  const fontsReady = loadKitab(document, lifetime.signal);
  void Promise.all([connectToolResultView({
    app,
    transport: new PostMessageTransport(window.parent, window.parent),
    onToolResult: result => {
      if (!ready) pending = result;
      else present(result);
    },
    // The host ends the connection after it answers the teardown request: nothing else tells this view it is going away.
    onTeardown: retire,
  }), fontsReady]).then(([value]) => {
    connection = value;
    if (lifetime.signal.aborted) { value.dispose(); return; }
    applyHostTheme(root, app.getHostContext(), app.getHostVersion()?.name);
    ready = true;
    if (pending !== undefined) { const next = pending; pending = undefined; present(next); }
    ownSizing(app, lifetime.signal);
  }).catch(() => {
    if (lifetime.signal.aborted) return;
    problem(BRANDING.connectFailureText);
  });
}
