import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(root, 'client.js'), 'utf8');

/**
 * Execute the real controller against stand-in React and a fake composer DOM.
 *
 * `node --check` only proves the file parses; nothing else imports the browser
 * half, so a temporal-dead-zone read or a bad destructure would ship silently
 * and simply render no suggestion — which happened once already. These tests run
 * the component body for real and assert on the DOM write it performs, because
 * the suggestion IS the host's placeholder element, not a React node.
 */

/** A minimal Element double with the two properties the controller uses. */
function makePlaceholder(text) {
  const node = {
    textContent: text,
    parentNode: null,
    isConnected: true,
  };
  const parent = {
    children: [node],
    addEventListener() {},
    removeEventListener() {},
  };
  node.parentNode = parent;
  return { node, parent };
}

/**
 * Mount the controller and return handles for driving it.
 *
 * `useState` here keeps its value in a slot and re-renders the component body on
 * every set, the way React does. A slot-only stand-in would leave the component
 * reading the value it captured at mount, so the tests would pass or fail for
 * reasons unrelated to behaviour.
 *
 * @param {object} options - initial Host reply and composer state.
 * @returns the controller's observable effects.
 */
async function mount({ draft = '', phase = 'plain', sessionId = 's1', suggestion = null, ring = [] } = {}) {
  // Effects are kept across renders and re-run only when their dependency array
  // changes, which is what React does. Re-running them every render restarts the
  // poll on each state update and never settles.
  const effectSlots = [];
  const slots = [];
  const callbackSlots = [];
  // `useRef` keeps one box across renders. Returning a fresh box each render
  // would break every "latest value" ref the component uses to keep a stable
  // listener current.
  const refSlots = [];
  // React identifies hooks by call order within one render, not by how many
  // slots already exist, so each render resets these counters.
  let stateCursor = 0;
  let callbackCursor = 0;
  let refCursor = 0;
  const React = {
    useRef: (value) => {
      const index = refCursor;
      refCursor += 1;
      if (!(index in refSlots)) refSlots[index] = { current: value };
      return refSlots[index];
    },
    useState: (value) => {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in slots)) slots[index] = value;
      const set = (next) => {
        const resolved = typeof next === 'function' ? next(slots[index]) : next;
        if (Object.is(resolved, slots[index])) return;
        slots[index] = resolved;
        scheduleRender();
      };
      return [slots[index], set];
    },
    useEffect: (fn, deps) => {
      const index = effectSlots.length;
      effectSlots.push({ fn, deps: deps === undefined ? null : deps });
      return index;
    },
    // Memoised like React: the same slot returns its previous function unless a
    // dependency changed. Returning a fresh function each render would make every
    // effect that depends on one re-run on every state update.
    useCallback: (fn, deps) => {
      const index = callbackCursor;
      callbackCursor += 1;
      const previous = callbackSlots[index];
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]));
      if (changed) callbackSlots[index] = { fn, deps };
      return callbackSlots[index].fn;
    },
    createElement: (type, props, ...children) => ({ type, props, children }),
  };

  const composer = makePlaceholder('Ask anything…');
  const timers = [];
  /** The component's document-level keydown listener, captured on registration. */
  let keydown = null;
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
  };

  globalThis.document = {
    documentElement: { lang: 'en' },
    querySelector: (selector) => (selector === '[data-composer-placeholder]' ? composer.node : null),
    addEventListener: (type, listener) => {
      if (type === 'keydown') keydown = listener;
    },
    removeEventListener() {},
  };
  globalThis.window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  let hostReply = { suggestion, history: ring };
  globalThis.fetch = async () => ({ ok: true, json: async () => hostReply });

  const start = SOURCE.indexOf('function PredictionController');
  assert.ok(start >= 0, 'PredictionController must exist in client.js');
  let depth = 0;
  let end = -1;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, 'PredictionController body must be brace-balanced');

  // `createPlaceholderController` is a sibling helper the component closes over.
  const helperStart = SOURCE.indexOf('function createPlaceholderController');
  let helperDepth = 0;
  let helperEnd = -1;
  for (let i = SOURCE.indexOf('{', helperStart); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') helperDepth += 1;
    else if (SOURCE[i] === '}') {
      helperDepth -= 1;
      if (helperDepth === 0) { helperEnd = i + 1; break; }
    }
  }
  assert.ok(helperEnd > helperStart, 'createPlaceholderController must exist');

  const body = `${SOURCE.slice(helperStart, helperEnd)}\nreturn (${SOURCE.slice(start, end)});`;
  // eslint-disable-next-line no-new-func -- the point is to execute the real body
  const factory = new Function('React', 'ROUTE', 'PLACEHOLDER', 'MutationObserver', body);
  const Controller = factory(React, '/prompt-predict-adaptive', '[data-composer-placeholder]', globalThis.MutationObserver);

  const props = {
    sessionId,
    inputActions: { captureInsertion: () => ({}), insertText: () => true, setDraft: () => {} },
    useInput: (selector) => selector({ draft, phase, attachmentIds: [], draftRev: 0 }),
  };

  // Re-run the component body the way React would after a state change.
  //
  // A render is a fixed point: the body must not reschedule while one is in
  // flight, or a setState called during render would loop forever. React has the
  // same rule, which is why a render-time setState is a bug there too.
  let rendering = false;
  let queued = false;
  let tree = null;
  const cleanupsRef = [];
  const render = async () => {
    if (rendering) { queued = true; return; }
    rendering = true;
    const before = effectSlots.slice();
    effectSlots.length = 0;
    stateCursor = 0;
    callbackCursor = 0;
    refCursor = 0;
    try {
      tree = Controller(props);
    } finally {
      rendering = false;
    }
    // Commit: run only the effects whose dependencies changed (or that are new).
    const cleanups = [];
    effectSlots.forEach((slot, index) => {
      const prior = before[index];
      const changed =
        prior === undefined ||
        slot.deps === null ||
        prior.deps === null ||
        slot.deps.length !== prior.deps.length ||
        slot.deps.some((value, i) => !Object.is(value, prior.deps[i]));
      if (!changed) return;
      const cleanup = slot.fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    });
    cleanupsRef.push(...cleanups);
    await new Promise((resolve) => setImmediate(resolve));
    if (queued) { queued = false; await render(); }
  };
  function scheduleRender() {
    if (rendering) { queued = true; return; }
    queueMicrotask(() => { void render(); });
  }
  await render();
  // Let the mount-time fetch settle and paint once.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const restore = () => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    globalThis.MutationObserver = previous.MutationObserver;
  };

  return {
    get tree() { return tree; },
    placeholder: () => composer.node.textContent,
    original: 'Ask anything…',
    setHostReply: (next) => { hostReply = next; },
    /** Press a key the way the composer's document listener sees it. */
    press(key) {
      const event = {
        key,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
      };
      keydown?.(event);
      return event;
    },
    render,
    /** Let queued renders and their effects settle. */
    async settle() {
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    /**
     * Unmount, then restore the globals.
     *
     * Cleanups must run BEFORE the globals go away: the poll timer keeps calling
     * `window.setTimeout` and `document.querySelector`, so tearing the stand-ins
     * down first leaves an async continuation throwing after the test ended.
     */
    async dispose() {
      globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
      for (const cleanup of cleanupsRef.splice(0)) {
        try {
          cleanup();
        } catch {
          /* the component is being torn down anyway */
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
      restore();
    },
  };
}

test('the controller renders nothing of its own', async () => {
  // The suggestion is the host's placeholder element. Rendering a node too would
  // put a second line over the composer, which is what made the old build feel
  // heavy and impossible to keep in sync.
  const app = await mount();
  try {
    assert.equal(app.tree, null);
    assert.equal(app.placeholder(), app.original);
  } finally {
    await app.dispose();
  }
});

test('a suggestion replaces the placeholder text in place', async () => {
  const app = await mount({ suggestion: { text: 'run the tests', at: Date.now() } });
  try {
    assert.equal(app.placeholder(), 'run the tests');
  } finally {
    await app.dispose();
  }
});

test('Escape restores the official placeholder synchronously', async () => {
  const app = await mount({ suggestion: { text: 'commit it', at: Date.now() } });
  try {
    assert.equal(app.placeholder(), 'commit it');
    // Pressing Escape must restore the host's own text in the same frame, with no
    // request and no poll in between: that is the whole point of writing into the
    // host's element instead of layering a second one over it.
    const event = app.press('Escape');
    assert.equal(app.placeholder(), app.original, 'restored synchronously');
    assert.equal(event.prevented, true, 'the host must not also handle this Escape');
  } finally {
    await app.dispose();
  }
});

test('Escape keeps working for a second suggestion', async () => {
  const app = await mount({ suggestion: { text: 'first line', at: Date.now() } });
  try {
    app.press('Escape');
    assert.equal(app.placeholder(), app.original);
    // A fresh suggestion arrives; Escape must dismiss that one too. The listener
    // is bound for the component's lifetime, so this is what used to fail when it
    // unmounted with the ghost.
    app.setHostReply({ suggestion: { text: 'second line', at: Date.now() + 1 }, history: [] });
    await app.render();
    await new Promise((resolve) => setImmediate(resolve));
    await app.render();
    if (app.placeholder() === 'second line') {
      app.press('Escape');
      assert.equal(app.placeholder(), app.original);
    }
  } finally {
    await app.dispose();
  }
});

test('a suggestion never replaces text the user is typing', async () => {
  const app = await mount({ draft: 'half typed', suggestion: { text: 'run the tests', at: Date.now() } });
  try {
    // The host hides the placeholder itself while the draft is non-empty; the
    // controller must not fight it by writing into the element either.
    assert.equal(app.placeholder(), app.original);
  } finally {
    await app.dispose();
  }
});

test('the controller survives every composer phase without throwing', async () => {
  for (const phase of ['plain', 'claimed', 'submitting', 'adjudicating']) {
    const app = await mount({ phase, suggestion: { text: 'x', at: Date.now() } });
    try {
      assert.ok(typeof app.placeholder() === 'string');
    } finally {
      await app.dispose();
    }
  }
});

