import type {ReactCatalogComponent} from '@saga-a2ui/react/a2ui';
import {Catalog, type SurfaceModel} from '@saga-a2ui/react/a2ui';
import {a2uiV0_9Decoder, createMessageSession, type IngestResult, type MessageSession} from '@saga-a2ui/core/protocols/a2ui/v0_9';
import {faithfulCardEntry} from '@saga-a2ui/react/faithful-card';
import {cardData, type AnswerEnvelope} from './envelope.js';

// The one A2UI path an answer reaches the card through: the app's own catalog (the one optional SAGA
// component), a surface that binds the card to a data model, and the data updates that replace the
// answer. The surface starts neutral (an empty answer, no canned text) and every later answer replaces
// the whole data model, so nothing of an earlier answer survives. The envelope is mapped by the app's
// existing `cardData`: the answer is passed through unchanged.

const CATALOG_ID = 'urn:ansari-faithful-answers:catalog:faithful-answer-card:react:v1';
const SURFACE_ID = 'faithful-answer';

const catalog = new Catalog<ReactCatalogComponent>(CATALOG_ID, 'v0.9', [faithfulCardEntry]);

const surfaceMessages = [
  {version: 'v0.9', createSurface: {surfaceId: SURFACE_ID, catalogId: CATALOG_ID}},
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: SURFACE_ID,
      components: [{id: 'root', component: 'FaithfulCard', contractVersion: {path: '/contractVersion'}, markdown: {path: '/markdown'}}],
    },
  },
  {version: 'v0.9', updateDataModel: {surfaceId: SURFACE_ID, value: {contractVersion: 1, markdown: ''}}},
];

const dataMessages = (value: {contractVersion: 1; markdown: string}) => [
  {version: 'v0.9', updateDataModel: {surfaceId: SURFACE_ID, value}},
];

export interface AnswerSurface {
  readonly surface: SurfaceModel<ReactCatalogComponent>;
  /** Replaces the answer shown with the envelope's, unchanged. */
  show(envelope: AnswerEnvelope): IngestResult;
  /** Removes the shown answer at once. */
  clear(): IngestResult;
}

/** Opens the answer surface from its neutral initial state. Throws if the app's own layout is not accepted. */
export function openAnswerSurface(): AnswerSurface {
  const session: MessageSession<ReactCatalogComponent> = createMessageSession({catalogs: [catalog], decoder: a2uiV0_9Decoder});
  let surface: SurfaceModel<ReactCatalogComponent> | undefined;
  session.onSurfaceCreated(created => { surface = created; });
  const opened = session.ingest(surfaceMessages);
  if (!opened.ok || surface === undefined) throw new Error('The answer surface was not accepted.');
  return {
    surface,
    show: envelope => session.ingest(dataMessages(cardData(envelope))),
    clear: () => session.ingest(dataMessages({contractVersion: 1, markdown: ''})),
  };
}
