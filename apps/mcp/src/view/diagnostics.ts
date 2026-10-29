import type {CardChromeProps} from '@saga-a2ui/react-mcp-stack/faithful-card';
import {createElement, useEffect, type ComponentType} from 'react';
import type {ViewMark, ViewReportReason} from './diagnostic-marks.js';

// First-load diagnosis (#335). The stack's hooks (hostContext, readyWhen, onError, the `ready` promise and the
// chrome) mark how far this card got; the early script in mcp-app-react.html has already recorded the script
// start and any error, rejection or content-policy violation before the bundle ran. A report is one tagged
// console line, and, only when the served card carries a `data-diagnostics` address (Dev), a beacon to it.
// Reports carry milestones, enumerated failures and error names only: never answer text or error messages.

type EarlyRecord = {id: string; marks: Partial<Record<ViewMark, number>>; errors: Record<string, string>[]};
declare global {
  interface Window { __ansariDiag?: EarlyRecord }
}

const MAX_ERRORS = 20;
const TIMEOUT_MS = 15_000;
const early: EarlyRecord = window.__ansariDiag ?? {
  id: Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join(''),
  marks: {},
  errors: [],
};
let hostName: string | undefined;
let failure: string | undefined;
let settled = false;

export function mark(name: ViewMark): void {
  early.marks[name] ??= performance.now();
}

export function noteHost(name: string | undefined): void {
  hostName ??= name;
}

export function noteFailure(kind: string): void {
  failure = kind;
}

export function noteCallbackError(error: unknown, phase: string): void {
  if (early.errors.length < MAX_ERRORS) early.errors.push({type: 'callback', name: error instanceof Error ? error.name : typeof error, phase});
}

export function report(reason: ViewReportReason): void {
  for (const entry of performance.getEntriesByType('paint')) {
    if (entry.name === 'first-paint') early.marks.firstPaint ??= entry.startTime;
    if (entry.name === 'first-contentful-paint') early.marks.firstContentfulPaint ??= entry.startTime;
  }
  const body = JSON.stringify({
    v: 1,
    id: early.id,
    release: document.body.dataset.revision ?? document.body.dataset.release ?? 'unknown',
    reason,
    visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
    ...(hostName === undefined ? {} : {host: hostName}),
    ...(failure === undefined ? {} : {failure}),
    marks: early.marks,
    errors: early.errors,
  });
  console.info('[ansari-view]', body);
  const endpoint = document.body.dataset.diagnostics;
  if (endpoint === undefined) return;
  try {
    if (!navigator.sendBeacon(endpoint, new Blob([body], {type: 'text/plain'}))) {
      void fetch(endpoint, {method: 'POST', body, mode: 'no-cors', keepalive: true}).catch(() => undefined);
    }
  } catch {
    // Diagnosis never disturbs the card.
  }
}

/** Reports once when the card starts or fails, when the page is put away, and if it has not started in time. */
export function watchStart(ready: Promise<void>, failureKind: (failure: unknown) => string): void {
  ready.then(
    () => { settled = true; mark('ready'); report('ready'); },
    (error: unknown) => { settled = true; noteFailure(failureKind(error)); mark('failed'); report('failed'); },
  );
  addEventListener('pagehide', () => report('pagehide'), {once: true});
  setTimeout(() => { if (!settled) report('timeout'); }, TIMEOUT_MS);
}

/** The application's chrome, marking the first answer and the first problem it actually rendered. */
export function observedChrome(Chrome: ComponentType<CardChromeProps>): ComponentType<CardChromeProps> {
  return function ObservedChrome(props: CardChromeProps) {
    const kind = props.state.kind;
    useEffect(() => {
      if (kind === 'waiting') return;
      const name = kind === 'answer' ? 'result' : 'problem';
      if (early.marks[name] !== undefined) return;
      mark(name);
      report(name);
    }, [kind]);
    return createElement(Chrome, props);
  };
}
