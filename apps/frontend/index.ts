// The app entry. On the web, a password-reset link's token leaves the address
// before expo-router loads (lib/auth/strip-reset-token.ts); then the router
// starts as usual. ES modules evaluate in import order, so the first import's
// side effect has run before the router's module is evaluated. A body
// statement would NOT do: imports are hoisted above it. index.test.ts pins
// the order.
import './lib/auth/strip-reset-token';
import 'expo-router/entry';
