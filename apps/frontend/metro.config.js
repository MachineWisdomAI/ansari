const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// The Replit-sourced pages import the vendored API client's runtime under
// its original package name rather than the `@/vendor/...` path this repo's
// own code uses (see lib/api/, lib/auth/). Metro would otherwise try to
// resolve it as a real node_modules package, so it's pointed at the vendored
// copy explicitly (mirrors the tsconfig.json `paths` entry, which is what
// TypeScript itself reads).
config.resolver.extraNodeModules = {
  "@workspace/api-client-react": path.resolve(__dirname, "vendor/api-client-react"),
};

// Uniwind stays wired but unused: the ported UI is StyleSheet-only, and
// src/global.css is deliberately not imported by app/_layout.tsx (Tailwind's
// preflight reset would restyle it on web). Adopting it is #264's call.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
});
