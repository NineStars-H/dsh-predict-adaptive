import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(root, 'client.js'), 'utf8');

/**
 * Run the overlay component body against stand-in React bindings.
 *
 * `node --check` only proves the file parses. The browser half is never imported
 * by any other test, so a temporal-dead-zone read or a bad destructure inside
 * the component would ship undetected and blank the ghost entirely — which is
 * exactly what happened once. This executes it for real.
 */
async function renderOverlay({ draft = '', phase = 'plain', sessionId = 's1' } = {}) {
  const effects = [];
  const React = {
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: (fn) => { effects.push(fn); },
    useCallback: (fn) => fn,
  };
  const h = (type, props, ...children) => ({ type, props, children });

  // The component schedules its poll with `window.setTimeout` and talks to the
  // Host over `fetch`; neither exists in Node. The timer is a no-op so no poll
  // loop outlives the test, and `fetch` resolves to an empty reply. The
  // stand-ins stay installed for the whole test body: the mount effect starts an
  // async poll whose continuation runs after the synchronous part returns.
  const timers = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

  const start = SOURCE.indexOf('function PredictionOverlay');
  assert.ok(start >= 0, 'PredictionOverlay must exist in client.js');
  let depth = 0;
  let end = -1;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, 'PredictionOverlay body must be brace-balanced');

  // eslint-disable-next-line no-new-func -- the point is to execute the real body
  const factory = new Function('React', 'h', 'ROUTE', 'copy', `return (${SOURCE.slice(start, end)});`);
  const Overlay = factory(React, h, '/prompt-predict-adaptive', () => ({}));

  const props = {
    sessionId,
    inputActions: { captureInsertion: () => ({}), insertText: () => true, setDraft: () => {} },
    useInput: (selector) => selector({ draft, phase, attachmentIds: [], draftRev: 0 }),
  };
  const tree = Overlay(props);
  for (const fn of effects) fn();
  // Let the poll's continuation settle while the stand-ins are still installed.
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
  return { tree, timers: timers.length };
}

test('the ghost overlay renders without runtime errors', async () => {
  // An empty composer with no suggestion yet: the component must return null,
  // not throw. A throw here is invisible in the host UI — it just means no ghost.
  const { tree } = await renderOverlay();
  assert.equal(tree, null);
});

test('the ghost overlay survives every composer phase', async () => {
  await assert.doesNotReject(() => renderOverlay({ draft: '', phase: 'plain', sessionId: 's1' }));
  await assert.doesNotReject(() => renderOverlay({ draft: 'user is typing', phase: 'plain' }));
  await assert.doesNotReject(() => renderOverlay({ draft: '', phase: 'adjudicating' }));
});
