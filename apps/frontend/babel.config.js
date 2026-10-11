module.exports = function (api) {
  api.cache(true);
  // babel-preset-expo 57 transforms `import.meta` by default
  // (`transformImportMeta`, default true); the SDK 54 opt-in flag
  // `unstable_transformImportMeta` is no longer read.
  return {
    presets: ['babel-preset-expo'],
  };
};
