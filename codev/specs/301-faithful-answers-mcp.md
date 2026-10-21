# 301: Faithful Answers MCP application

Contribute the independently reviewed standalone Ansari application to this repository. It retrieves a complete Ansari answer and attribution, then renders it through the public saga a2ui React packages in ChatGPT, Claude and Alexa.

## Constraints

Use `app/ansari-faithful-answers` as requested by the contributor. React only, MCP only, no SDUI or private source dependencies. Pin public saga a2ui 0.5.4-rc.1 and preserve the SAGA-owned A2UI dependency boundary. Retain Kitab fonts and their OFL notices, contributed artwork, complete answers, content policy and optional lowercase framework credit. Keep the existing API/auth/frontend development experience unchanged. No production deployment or upstream merge is included.

## Approach

Import the qualified application with minimal workspace adaptation. Reimplementing the card or adding a shared renderer would introduce unnecessary divergence. Public dependencies, a root Markdown adapter override and one root lockfile provide a reproducible consumer setup.

## Acceptance

The destination branch installs and passes application typecheck/build/server/browser checks and isolated Docker smoke checks without private package credentials. Runtime assets contain real bytes. The exact destination revision is verified on DEV and captured on ChatGPT, Claude and Alexa before opening the contribution PR. Host reload limitations and unverified mobile behavior remain explicit; desktop checks do not prove mobile reliability.
