import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// A worklet (a `useAnimatedStyle`/`useDerivedValue`/… callback, or any
// function whose body opens with 'worklet') runs on the UI thread on native.
// Calling a plain JS function from one throws there — "[Worklets] Tried to
// synchronously call a Remote Function" — and the web never shows it, because
// react-native-web runs worklets on the JS thread. `composerBottomPad` did
// exactly that from #121 until #262. This scan is the regression guard: every
// call inside a worklet body must be to a worklet-marked function, a closure
// declared inside the worklet, or a known worklet-safe built-in.

const root = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['app', 'components', 'hooks', 'lib', 'constants'];

/** Hooks whose function arguments are workletized by the babel plugin. */
const WORKLET_HOOKS = new Set([
  'useAnimatedStyle',
  'useDerivedValue',
  'useAnimatedProps',
  'useAnimatedReaction',
  'useFrameCallback',
  'useAnimatedScrollHandler',
  'runOnUI',
]);

/** Reanimated/worklets APIs and JS built-ins that are safe on the UI thread. */
const SAFE_CALLS = new Set([
  'interpolate', 'interpolateColor', 'withTiming', 'withSpring', 'withDelay',
  'withRepeat', 'withSequence', 'withDecay', 'cancelAnimation', 'runOnJS',
  'scheduleOnRN', 'scheduleOnUI', 'clamp', 'measure', 'scrollTo',
  'String', 'Number', 'Boolean',
]);

type Source = { file: string; sf: ts.SourceFile };

function parse(file: string, text: string): Source {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return { file, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind) };
}

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isFn = (n: ts.Node): n is Fn =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

function hasWorkletDirective(fn: Fn): boolean {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'worklet'
  );
}

/** Names of functions declared with a 'worklet' directive, across all sources. */
function workletNames(sources: Source[]): Set<string> {
  const names = new Set<string>();
  for (const { sf } of sources) {
    const visit = (n: ts.Node): void => {
      if (isFn(n) && hasWorkletDirective(n)) {
        if (ts.isFunctionDeclaration(n) && n.name) names.add(n.name.text);
        else if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
          names.add(n.parent.name.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return names;
}

/** Functions declared inside a worklet body are workletized with it. */
function localFunctionNames(body: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) names.add(n.name.text);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return names;
}

/** `file:line name()` for every unmarked plain-function call inside a worklet. */
function unmarkedWorkletCalls(sources: Source[]): string[] {
  const worklets = workletNames(sources);
  const hits: string[] = [];
  for (const { file, sf } of sources) {
    const checkBody = (body: ts.Node): void => {
      const local = localFunctionNames(body);
      const visit = (n: ts.Node): void => {
        // Only bare identifiers: `Math.round(...)`, `sv.get()`, `a.map(...)`
        // are property calls, which the worklets runtime handles.
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          if (!SAFE_CALLS.has(name) && !worklets.has(name) && !local.has(name)) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            hits.push(`${file}:${line + 1} ${name}()`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(body);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const hook = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (WORKLET_HOOKS.has(hook)) {
          for (const arg of n.arguments) if (isFn(arg) && arg.body) checkBody(arg.body);
        }
      }
      if (isFn(n) && hasWorkletDirective(n) && n.body) checkBody(n.body);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

function appSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(parse(path.relative(root, p), readFileSync(p, 'utf8')));
      }
    }
  };
  for (const d of SCANNED_DIRS) walk(path.join(root, d));
  return out;
}

describe('worklet bodies call only worklets (native UI-thread safety)', () => {
  it('finds no unmarked plain-function calls inside worklets in the app', () => {
    const sources = appSources();
    // Guard against a scan that passes by scanning nothing.
    expect(sources.length).toBeGreaterThan(50);
    expect(unmarkedWorkletCalls(sources)).toEqual([]);
  });

  it('keeps composerBottomPad a worklet (both screens call it in useAnimatedStyle)', () => {
    expect(workletNames(appSources()).has('composerBottomPad')).toBe(true);
  });

  // The scan is code; prove it fails when it should and passes the near-misses.
  it('flags a plain function called from useAnimatedStyle', () => {
    const bad = parse(
      'bad.tsx',
      `function pad(n: number) { return n + 10; }
       const s = useAnimatedStyle(() => ({ paddingBottom: pad(4) }));`,
    );
    expect(unmarkedWorkletCalls([bad])).toEqual(['bad.tsx:2 pad()']);
  });

  it('flags a plain function called from a worklet defined in another file', () => {
    const helper = parse('helper.ts', `export function pad(n: number) { return n + 10; }`);
    const user = parse(
      'user.ts',
      `export function style(n: number) { 'worklet'; return pad(n); }`,
    );
    expect(unmarkedWorkletCalls([helper, user])).toEqual(['user.ts:1 pad()']);
  });

  it('passes a worklet-marked helper, an in-worklet closure, and safe built-ins', () => {
    const good = parse(
      'good.tsx',
      `function pad(n: number) { 'worklet'; return n + 10; }
       const s = useAnimatedStyle(() => {
         const at = (k: number) => k * 2;
         return { paddingBottom: interpolate(pad(at(1)), [0, 1], [0, 1]), opacity: Math.round(0.4) };
       });`,
    );
    expect(unmarkedWorkletCalls([good])).toEqual([]);
  });
});
