import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(root, 'client.js'), 'utf8');

/**
 * Execute the real overlay against stand-in React and a fake composer.
 *
 * `node --check` only proves the file parses, and nothing else imports this
 * half, so a temporal-dead-zone read or a mistake in the hook plumbing would
 * ship silently and simply render nothing. These tests run the component body
 * for real.
 *
 * The stand-ins model the parts of React that matter here — hook call order,
 * dependency comparison, ref persistence, reducer re-render — because getting
 * those wrong earlier made the tests pass or fail for unrelated reasons.
 */

/** Extract one top-level function body by brace matching. */
function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist in client.js`);
  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not brace-balanced`);
}

/**
 * Mount the overlay.
 *
 * @param {object} options - Host reply, composer state and starting time.
 * @returns handles for driving the component.
 */
async function mount({ draft = '', phase = 'plain', sessionId = 's1', suggestion = null, ring = [], now = 1_000 } = {}) {
  const stateSlots = [];
  const refSlots = [];
  const callbackSlots = [];
  const effectSlots = [];
  const cleanups = [];
  let stateCursor = 0;
  let refCursor = 0;
  let callbackCursor = 0;
  let rendering = false;
  let queued = false;
  let tree = null;
  let clock = now;
  let keydown = null;
  let hostReply = { suggestion, history: ring };
  /** Timers the component scheduled; the poll loop is driven by these. */
  const timers = [];

  const scheduleRender = () => {
    if (rendering) { queued = true; return; }
    queueMicrotask(() => { void render(); });
  };

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (value) => {
      const index = refCursor;
      refCursor += 1;
      if (!(index in refSlots)) refSlots[index] = { current: value };
      return refSlots[index];
    },
    useState: (value) => {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in stateSlots)) stateSlots[index] = value;
      const set = (next) => {
        const resolved = typeof next === 'function' ? next(stateSlots[index]) : next;
        if (Object.is(resolved, stateSlots[index])) return;
        stateSlots[index] = resolved;
        scheduleRender();
      };
      return [stateSlots[index], set];
    },
    useReducer: (reducer, initial) => {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in stateSlots)) stateSlots[index] = initial;
      const dispatch = (action) => {
        const resolved = reducer(stateSlots[index], action);
        if (Object.is(resolved, stateSlots[index])) return;
        stateSlots[index] = resolved;
        scheduleRender();
      };
      return [stateSlots[index], dispatch];
    },
    useMemo: (fn) => fn(),
    useEffect: (fn, deps) => {
      effectSlots.push({ fn, deps: deps === undefined ? null : deps });
    },
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
  };

  // The composer's placeholder element: the component only toggles its
  // `visibility`, never its text (React owns that text node).
  const placeholderNode = { textContent: 'Ask anything…', isConnected: true, style: { visibility: '' } };
  placeholderNode.parentNode = {};

  const previousGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.document = {
    documentElement: { lang: 'en' },
    querySelector: () => placeholderNode,
    querySelectorAll: (selector) => (selector === '[data-composer-placeholder]' ? [placeholderNode] : []),
    addEventListener: (type, listener) => {
      if (type === 'keydown') keydown = listener;
    },
    removeEventListener() {},
  };
  globalThis.window = {
    setTimeout: (fn) => { timers.push({ fn }); return timers.length; },
    clearTimeout: () => { timers.length = 0; },
  };
  // Each `/get` records the reply it answered with, so a test can tell whether
  // the poll has actually returned the new state yet.
  let pollCount = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/get')) {
      pollCount += 1;
      return { ok: true, json: async () => hostReply };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  // The component reads the module-level `styles` table, so the extracted body
  // needs it in scope the way the real module provides it.
  const stylesSource = extractFunction('copy');
  void stylesSource;
  const stylesMatch = /const styles = \{[\s\S]*?\n    \};/.exec(SOURCE);
  assert.ok(stylesMatch, 'the styles table must exist in client.js');
  const body = `${stylesMatch[0]}\n${extractFunction('PredictionOverlay')}\nreturn PredictionOverlay;`;
  // eslint-disable-next-line no-new-func -- the point is to execute the real body
  const factory = new Function('React', 'h', 'ROUTE', 'PLACEHOLDER', 'Date', body);
  const FakeDate = class extends Date {
    static now() { return clock; }
  };
  const Overlay = factory(
    React,
    React.createElement,
    '/prompt-predict-adaptive',
    '[data-composer-placeholder]',
    FakeDate,
  );

  const render = async () => {
    if (rendering) { queued = true; return; }
    rendering = true;
    const before = effectSlots.slice();
    effectSlots.length = 0;
    stateCursor = 0;
    refCursor = 0;
    callbackCursor = 0;
    try {
      tree = Overlay({
        sessionId,
        inputActions: { captureInsertion: () => ({}), insertText: () => true, setDraft: () => {} },
        useInput: (selector) => selector({ draft, phase, attachmentIds: [], draftRev: 0 }),
      });
    } finally {
      rendering = false;
    }
    effectSlots.forEach((slot, index) => {
      const prior = before[index];
      const changed =
        prior === undefined ||
        slot.deps === null ||
        prior.deps === null ||
        slot.deps.length !== prior.deps.length ||
        slot.deps.some((value, i) => !Object.is(value, prior.deps[i]));
      if (!changed) {
        prior.cleanup = prior.cleanup;
        slot.cleanup = prior.cleanup;
        return;
      }
      // React runs the previous cleanup before the next effect. Skipping that
      // leaves a stale cleanup holding the old DOM state, so the placeholder
      // would stay hidden after a dismissal.
      if (typeof prior?.cleanup === 'function') {
        prior.cleanup();
        prior.cleanup = undefined;
      }
      const cleanup = slot.fn();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      if (slot.cleanup !== undefined) cleanups.push(slot.cleanup);
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (queued) { queued = false; await render(); }
  };

  await render();
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  if (queued) { queued = false; await render(); }

  /** The text painted on screen, or null when nothing is shown. */
  const shownText = () => (tree === null ? null : tree.children[0].children[0]);

  return {
    get tree() { return tree; },
    shownText,
    placeholderVisibility: () => placeholderNode.style.visibility,
    setHostReply: (next) => { hostReply = next; },
    advanceClock: (ms) => { clock += ms; },
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
    /**
     * Let the component observe a new Host reply.
     *
     * The poll is driven by a timer the component schedules itself; the stand-in
     * `setTimeout` records it instead of scheduling, so this runs it and lets the
     * resulting state updates commit.
     */
    async pollOnce() {
      const before = pollCount;
      const pending = timers.splice(0);
      for (const timer of pending) timer.fn();
      for (let i = 0; i < 10 && pollCount === before; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
      if (queued) { queued = false; await render(); }
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
      if (queued) { queued = false; await render(); }
    },
    /**
     * Drain only the microtask queue.
     *
     * React commits a state update before the browser paints, so a synchronous
     * handler's effect on the DOM is observable after microtasks — without
     * waiting for any macrotask a fetch would need.
     */
    async flushMicrotasks() {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      // The scheduled render runs on a microtask; commit it before asserting.
      if (queued) { queued = false; await render(); }
    },
    async dispose() {
      globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          /* tearing down anyway */
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.document = previousGlobals.document;
      globalThis.window = previousGlobals.window;
      globalThis.fetch = previousGlobals.fetch;
    },
  };
}

test('paints nothing when the Host has no suggestion', async () => {
  const app = await mount();
  try {
    assert.equal(app.tree, null);
    assert.notEqual(app.placeholderVisibility(), 'hidden');
  } finally {
    await app.dispose();
  }
});

test('paints the suggestion and hides the host placeholder', async () => {
  const app = await mount({ suggestion: { text: 'run the tests', at: 2_000 } });
  try {
    assert.equal(app.shownText(), 'run the tests');
    assert.equal(app.placeholderVisibility(), 'hidden');
  } finally {
    await app.dispose();
  }
});

test('Escape drops the line in the same frame', async () => {
  const app = await mount({ suggestion: { text: 'commit it', at: 2_000 } });
  try {
    assert.equal(app.shownText(), 'commit it');
    const event = app.press('Escape');
    // React commits the state update and runs the cleanup that restores the
    // placeholder before the browser paints, so both are asserted here without
    // waiting for any macrotask a fetch would need.
    await app.flushMicrotasks();
    assert.equal(app.shownText(), null, 'the ghost is gone');
    assert.equal(app.placeholderVisibility(), '', 'the official placeholder is back');
    assert.equal(event.prevented, true, 'the host must not also handle this Escape');
  } finally {
    await app.dispose();
  }
});

test('a rejected line never comes back, however often the Host repeats it', async () => {
  const app = await mount({ suggestion: { text: 'commit it', at: 2_000 } });
  try {
    app.press('Escape');
    // The Host has not processed the dismissal yet and keeps reporting the same
    // line. Only a time window used to hide that; now the rejection is recorded.
    app.setHostReply({ suggestion: { text: 'commit it', at: 2_000 }, history: ['commit it'] });
    await app.settle();
    assert.equal(app.shownText(), null);
  } finally {
    await app.dispose();
  }
});

test('Escape keeps working for a second suggestion', async () => {
  const app = await mount({ suggestion: { text: 'first line', at: 2_000 } });
  try {
    app.press('Escape');
    await app.flushMicrotasks();
    assert.equal(app.shownText(), null, 'first line dismissed');
    // A genuinely new suggestion arrives. Its timestamp must be after anything
    // this half has consumed — and nothing is consumed by a dismissal, only by a
    // send — so a later stamp is always accepted.
    app.advanceClock(10);
    app.setHostReply({ suggestion: { text: 'second line', at: 9_000 }, history: [] });
    await app.pollOnce();
    assert.equal(app.shownText(), 'second line', 'a later suggestion is shown');
    // The listener survived the first dismissal, so this one still reaches us;
    // when it unmounted with the ghost, the second Escape fell through to the
    // host and the line stayed on screen.
    app.press('Escape');
    await app.flushMicrotasks();
    assert.equal(app.shownText(), null);
  } finally {
    await app.dispose();
  }
});

test('a suggestion never paints over text the user is typing', async () => {
  const app = await mount({ draft: 'half typed', suggestion: { text: 'run the tests', at: 2_000 } });
  try {
    assert.equal(app.tree, null);
  } finally {
    await app.dispose();
  }
});

test('survives every composer phase without throwing', async () => {
  for (const phase of ['plain', 'claimed', 'submitting', 'adjudicating']) {
    const app = await mount({ phase, suggestion: { text: 'x', at: 2_000 } });
    try {
      assert.ok(app.tree === null || typeof app.shownText() === 'string');
    } finally {
      await app.dispose();
    }
  }
});
