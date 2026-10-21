// View side of how the application's content policy travels inside the one document it serves. The
// build (embed-document.ts) writes the policy-derived Content-Security-Policy and the policy's
// configuration into the HTML; this module rebuilds the same policy from that configuration,
// validating it again. The document is the only source: a tool result, an answer or an A2UI
// property can never supply or change it.
//
// The format follows the SAGA React consumer example (examples/react-card-consumer/src/embedded-policy.ts),
// which is not an SDK export; this application owns its copy of the format.
import {createContentPolicy, type CreatePolicyResult} from '@saga-a2ui/components/faithful-card';

export const CONTENT_POLICY_ELEMENT_ID = 'saga-content-policy';

/**
 * Rebuilds the policy from the embedded configuration text. Nothing embedded means the default
 * Standard policy with empty lists; anything embedded that does not validate is a failure, so a view
 * is never mounted on a guessed policy.
 */
export function policyFromEmbedded(text: string | null): CreatePolicyResult {
  if (text === null) return createContentPolicy({});
  let configuration: unknown;
  try {
    configuration = JSON.parse(text);
  } catch {
    return {ok: false, failure: {kind: 'invalid-config', message: 'The embedded content policy is not valid JSON.'}};
  }
  return createContentPolicy(configuration);
}
