// App-owned mapping from an MCP tool result to the answer envelope the shared card shows.
// Pure and browser-safe. It decides what to display; it never renders Markdown and never edits the answer.
import {ANSWER_ENVELOPE_VERSION, type AnswerEnvelope} from './envelope.js';

export const UNSUPPORTED_RESULT_TEXT = 'This result could not be displayed.';

/** The structural subset of an MCP tool result the view reads. */
export type ToolResultLike = {
  structuredContent?: unknown;
  content?: ReadonlyArray<{type?: string; text?: string}>;
  isError?: boolean;
};

export type ClassifiedResult =
  | {kind: 'valid'; envelope: AnswerEnvelope}
  | {kind: 'rejected'; text: string};

function contentText(result: ToolResultLike): string | undefined {
  const text = result.content?.find(block => block.type === 'text')?.text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/**
 * A failed call shows its own (server-written, fixed) message. A successful call shows the answer
 * from `structuredContent` when the host delivered it, else from the text content, exactly as sent.
 */
export function classifyToolResult(result: ToolResultLike): ClassifiedResult {
  const fallback = contentText(result) ?? UNSUPPORTED_RESULT_TEXT;
  if (result.isError) return {kind: 'rejected', text: fallback};
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    if (typeof structured !== 'object' || Array.isArray(structured)) return {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT};
    const fields = structured as {answer?: unknown; question?: unknown; version?: unknown};
    if (typeof fields.answer !== 'string') return {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT};
    if (fields.version !== ANSWER_ENVELOPE_VERSION || typeof fields.question !== 'string') return {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT};
    if (fields.answer.length === 0) return {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT};
    return {kind: 'valid', envelope: {question: fields.question, answer: fields.answer}};
  }
  const text = contentText(result);
  return text === undefined
    ? {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT}
    : {kind: 'valid', envelope: {question: '', answer: text}};
}
