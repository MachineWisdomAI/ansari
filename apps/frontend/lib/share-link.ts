/**
 * A shared thread (`/share/<id>`, the path apps/api hands out in
 * `share_url`) is the one page that needs no identity: it is read without
 * a bearer, renders while the session is still being restored, and must
 * not provision a guest for a visitor who only came to read it.
 *
 * The route is enough on a cold start from a tapped link: expo-router
 * builds its first state from the launch URL (synchronously on iOS; on
 * Android the navigator renders nothing until it resolves), so the root
 * layout never renders a `/` first. A dev client is the exception — it
 * boots at `/` and forwards the link afterwards.
 */
export function isSharePath(path: string): boolean {
  return path.startsWith('/share/');
}

