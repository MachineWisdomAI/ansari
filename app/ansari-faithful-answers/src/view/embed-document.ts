// Build side of the embedded policy: node-only, no runtime import of the SDK (the policy is passed in).
import type {ContentPolicy} from '@saga-a2ui/components/faithful-card';
import {CONTENT_POLICY_ELEMENT_ID} from './embedded-policy.ts';

/** The application's one policy: Standard, no external image origin, no font origin. A constant, never derived from data. */
export const STANDARD_POLICY_CONFIGURATION = Object.freeze({level: 'standard', imageHosts: [] as string[], fontOrigins: [] as string[]});

const HEAD_OPENING = /<head(\s[^>]*)?>/i;
const CHARSET_META = /<meta\s+charset=[^>]*>/i;

/** JSON that can sit inside a script element: `<` can never start a closing tag. */
function inertJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * Returns `viewHtml` with the policy's restrictions and configuration at the start of its head (after
 * the charset declaration, which must stay near the top), so the restrictions precede every script.
 */
export function embedPolicy(viewHtml: string, policy: ContentPolicy): string {
  const head = HEAD_OPENING.exec(viewHtml);
  if (head === null) throw new Error('The view document has no <head> to carry its content restrictions.');
  const restrictions = `<meta http-equiv="Content-Security-Policy" content="${policy.resource.contentSecurityPolicy}">`;
  const configuration = `<script type="application/json" id="${CONTENT_POLICY_ELEMENT_ID}">${inertJson(policy.configuration)}</script>`;
  const charset = CHARSET_META.exec(viewHtml);
  const insertAt = charset !== null && charset.index > head.index ? charset.index + charset[0].length : head.index + head[0].length;
  return viewHtml.slice(0, insertAt) + restrictions + configuration + viewHtml.slice(insertAt);
}
