const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// Uniwind stays wired but unused: the ported UI is StyleSheet-only, and
// src/global.css is deliberately not imported by app/_layout.tsx (Tailwind's
// preflight reset would restyle it on web). Adopting it is #264's call.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
});
