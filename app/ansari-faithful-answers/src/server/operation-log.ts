export type OperationRecord = {
  event: string;
  method?: string;
  requestId?: string | number | null;
  [key: string]: unknown;
};

export type OperationLogger = (record: OperationRecord) => void;

const FORBIDDEN = new Set([
  'question',
  'answer',
  'authorization',
  'session',
  'sessionId',
  'token',
  'messages',
  'params',
  'body',
]);

const SAFE_REVISION = /^[A-Za-z0-9._+-]{1,80}$/;

import {APP_VERSION} from '../version.js';
export const DEFAULT_RELEASE = APP_VERSION;

export function deployedRevision(): string {
  for (const value of [process.env.ANSARI_RELEASE, process.env.RAILWAY_GIT_COMMIT_SHA]) {
    if (value && SAFE_REVISION.test(value)) {
      return value;
    }
  }
  return DEFAULT_RELEASE;
}

export function stampHtmlRevision(html: string, revision = deployedRevision()): string {
  const safe = SAFE_REVISION.test(revision) ? revision : DEFAULT_RELEASE;
  if (/data-revision=/.test(html)) {
    return html.replace(/data-revision="[^"]*"/, `data-revision="${safe}"`);
  }
  return html.replace(/<body([^>]*)>/, `<body$1 data-revision="${safe}">`);
}

export function defaultOperationLogger(record: OperationRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function writeOperationLog(
  record: OperationRecord,
  logger: OperationLogger = defaultOperationLogger,
): void {
  const payload: OperationRecord = { release: deployedRevision(), ...record };
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN.has(key)) {
      delete payload[key];
    }
  }
  logger(payload);
}

export function jsonRpcMeta(body: unknown): { method?: string; requestId?: string | number | null } {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const record = body as { method?: unknown; id?: unknown };
  const method = typeof record.method === 'string' ? record.method : undefined;
  const requestId =
    typeof record.id === 'string' || typeof record.id === 'number' || record.id === null
      ? record.id
      : undefined;
  return { method, requestId };
}
