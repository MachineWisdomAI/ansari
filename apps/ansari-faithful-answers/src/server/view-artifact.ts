import {readFileSync} from 'node:fs';
import {viewUriForHtml, type OperationView} from '@saga-a2ui/mcp/server';
import {stampHtmlRevision} from './operation-log.js';

/** Prepare immutable deployment bytes once, before accepting HTTP requests. */
export function prepareAnswerView(html = readFileSync(new URL('../../dist/view.html', import.meta.url), 'utf8'), release?: string): OperationView {
  const currentHtml = stampHtmlRevision(html, release);
  return Object.freeze({
    uri: viewUriForHtml(currentHtml),
    title: 'Ansari answer card',
    html: currentHtml,
    csp: {connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []},
  });
}
