import {operationViewFromHtml, type OperationView} from '@saga-a2ui/react-mcp-stack/server';
import {stampHtmlRevision} from './operation-log.js';

/** The file name the view's content identity keeps: `ui://views/answer-card.<fingerprint>.html`. */
export const VIEW_FILENAME = 'answer-card.html';
/** Where a diagnostic card sends its milestone reports (#335). Served only when a diagnostics origin is configured. */
export const VIEW_DIAGNOSTICS_PATH = '/diag/view';
const CLOSED_CONNECT = "connect-src 'none'";

/**
 * Prepare immutable deployment bytes once from the built card the host supplies: no file is read here.
 * With a diagnostics origin (Dev only), the card may connect to that one origin and is told where to report; this
 * changes its bytes and so its address. Without one, the card and its permissions are exactly the built card's.
 */
export function prepareAnswerView(html: string, release?: string, diagnosticsOrigin?: string): OperationView {
  let currentHtml = stampHtmlRevision(html, release);
  if (diagnosticsOrigin !== undefined) {
    if (!currentHtml.includes(CLOSED_CONNECT)) throw new Error(`The card has no "${CLOSED_CONNECT}" rule to open for diagnostics.`);
    currentHtml = currentHtml
      .replace(CLOSED_CONNECT, `connect-src ${diagnosticsOrigin}`)
      .replace(/<body([^>]*)>/, `<body$1 data-diagnostics="${diagnosticsOrigin}${VIEW_DIAGNOSTICS_PATH}">`);
    return Object.freeze(operationViewFromHtml({html: currentHtml, filename: VIEW_FILENAME, title: 'Ansari answer card', csp: {connectDomains: [diagnosticsOrigin]}}));
  }
  // The identity is taken from the final bytes, after revision stamping. Declared permissions stay closed.
  return Object.freeze(operationViewFromHtml({html: currentHtml, filename: VIEW_FILENAME, title: 'Ansari answer card'}));
}
