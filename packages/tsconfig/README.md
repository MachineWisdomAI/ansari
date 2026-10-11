# @ansari/tsconfig

Shared TypeScript base for the workspace. Apps extend it and layer their own
framework settings on top.

## Why it is this small

It contains exactly the options **both** apps already had, so adopting it changed
neither app's resolved configuration — verified with `tsc --showConfig` before and
after.

`isolatedModules` is deliberately **not** here. `apps/api` sets it; `apps/frontend`
does not (it extends `expo/tsconfig.base`, which leaves it unset). Putting it in the
base would have silently turned it on for the frontend — a real behaviour change
disguised as a refactor. It stays in `apps/api/tsconfig.json`.

The rule: this base holds settings the apps genuinely agree on. Anything one app
needs and the other does not belongs in that app.

## Use

```jsonc
// an app that extends nothing else
{ "extends": "@ansari/tsconfig/base.json" }

// an app that already extends a framework base — order matters, later wins
{ "extends": ["expo/tsconfig.base", "@ansari/tsconfig/base.json"] }
```

## Exports

`package.json` declares an `exports` map, the same way `@ansari/eslint-config` does,
so the two shared config packages resolve by one rule. The key is `./base.json`
**with** the extension: TypeScript resolves `extends` through the map, and a key
that does not match the specifier exactly breaks every consumer's `extends` chain
(`TS6053: File '@ansari/tsconfig/base.json' not found`).

A second config file therefore needs its own `exports` entry before anything can
extend it.
