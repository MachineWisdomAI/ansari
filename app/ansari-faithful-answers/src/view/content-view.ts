import {
  createFaithfulCardReader,
  createImageConsentScope,
  establishImageEnforcement,
  type ContentPolicy,
  type HostLinks,
} from '@saga-a2ui/components/faithful-card';
import type {FaithfulCardView} from '@saga-a2ui/react/faithful-card';
import {CARD_MAX_UTF16_UNITS} from './envelope.js';

/** Every Content-Security-Policy value the document carries: the restrictions image loading relies on. */
function documentContentSecurityPolicies(document: Document): string[] {
  return Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]'), meta => meta.getAttribute('content') ?? '');
}

/**
 * The trusted settings of the card, created once by the app: the Markdown dialect and the app's
 * existing answer ceiling (never clipped), the content policy the document was served with, how a
 * link leaves the view, and the image restrictions the document actually carries. Nothing in an
 * answer can change any of them.
 */
export function createContentView(settings: {readonly policy: ContentPolicy; readonly hostLinks: HostLinks; readonly document: Document}): FaithfulCardView {
  const reader = createFaithfulCardReader({dialect: 'commonmark-tables-strikethrough', maxLength: CARD_MAX_UTF16_UNITS});
  if (!reader.ok) throw new Error(reader.failure.message);
  return {
    reader: reader.reader,
    policy: settings.policy,
    hostLinks: settings.hostLinks,
    // Images load only if the document declares exactly the restrictions the policy derives; otherwise they stay inert.
    imageEnforcement: establishImageEnforcement(settings.policy, documentContentSecurityPolicies(settings.document)),
    // This view's own consent scope. The app ends it when the view ends.
    consent: createImageConsentScope(),
  };
}
