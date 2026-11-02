import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { apply } from '../index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ auth = (req) => req.headers.cookie === 'valid' ? undefined : 401, stream, events, onStream, nodes } = {}) {
  const listeners = new Map();
  let route, dispose;
  const agent = {
    session: { id: 's1', get seq() { return events?.length ?? 1; }, surface: { nodes: nodes ?? [0] }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), eventAt: (seq) => events?.[seq] ?? {}, deriveEventMessage: (event) => (event?.data?.role !== undefined ? event.data : { role: 'user', content: 'hello' }) },
    ctx: { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } },
  };
  const connection = auth && { requestRejection: auth };
  // The plugin registers its turn signals on its own context, so these are the
  // listeners the tests drive. Each listener records the last registration per
  // event name.
  const globalListeners = new Map();
  const ctx = {
    get: (key) => key === 'connection' ? connection : undefined,
    // `onStream` lets a test inspect the request the plugin would have sent, which
    // is the only way to assert on prompt shape without a live provider.
    llm: {
      stream: async function* (request) {
        onStream?.(request);
        if (stream !== undefined) { yield* stream(request); return; }
        yield { type: 'text-delta', text: 'Continue testing' };
      },
    },
    agents: { list: () => [agent], get: () => agent },
    on: (name, fn) => { globalListeners.set(name, fn); return () => globalListeners.delete(name); },
    webServer: { register: (r) => { route = r.handler; return () => {}; } },
    effect: (fn) => { dispose = fn(); },
  };
  let poll;
  const originalInterval = globalThis.setInterval;
  if (events) globalThis.setInterval = (callback) => { poll = callback; return { unref() {} }; };
  try { apply(ctx, { enabled: true, mode: 'full', recentTurns: 6 }); }
  finally { globalThis.setInterval = originalInterval; }
  return {
    dispose: () => dispose(),
    // The dispatcher fuses the owning agent into every payload.
    trigger: () => globalListeners.get('agent/status')?.({ agent, status: 'idle' }),
    stopping: (turn) => globalListeners.get('agent/turn-stopping')?.({ agent, turn }),
    poll: () => poll(),
    async request(path, { method = 'GET', cookie = 'valid', origin = 'http://localhost', body } = {}) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { url: `/prompt-predict-adaptive/${path}`, method, headers: { host: 'localhost', cookie, ...(origin === null ? {} : { origin }) } });
      let status, output;
      const res = { writeHead: (s) => { status = s; }, end: (s) => { output = JSON.parse(s); } };
      await route(req, res);
      return { status, body: output };
    },
  };
}

test('authentication is required and unavailable authentication fails closed', async () => {
  const h = harness({ auth: (req) => req.headers.origin === 'http://evil' ? 403 : req.headers.cookie === 'valid' ? undefined : 401 });
  try {
    assert.equal((await h.request('get', { cookie: '' })).status, 401);
    for (const action of ['config', 'accepted', 'dismiss', 'drop', 'reset', 'diagnose']) {
      assert.equal((await h.request(action, { method: 'POST', cookie: '', body: {} })).status, 401);
    }
    assert.equal((await h.request('get', { origin: 'http://evil' })).status, 403);
    // A mutation WITHOUT an Origin header must still be admitted.
    //
    // The desktop page is served from `dsh-app://app`, and its proxy strips
    // Origin before forwarding to this route. Requiring the header therefore
    // rejected every mutation with 403, which is why dismiss, accept and send
    // silently never reached the Host. Forgery is covered by the SameSite=Strict
    // session cookie: another origin's request carries no credential and fails
    // the `requestRejection` check above with 401.
    assert.equal((await h.request('config', { method: 'POST', origin: null, body: {} })).status, 200);
    assert.equal((await h.request('get')).status, 200);
    assert.equal((await h.request('diagnose')).status, 405);
  } finally { h.dispose(); }
  const unavailable = harness({ auth: null });
  try { assert.equal((await unavailable.request('get')).status, 503); } finally { unavailable.dispose(); }
  const throws = harness({ auth: () => { throw Error('unavailable'); } });
  try { assert.equal((await throws.request('get')).status, 503); } finally { throws.dispose(); }
});

test('the transcript ends on an open USER turn so the model finishes a line', async () => {
  // Without the dangling label the input reads as a finished document plus a
  // task, and the model answers in an analyst's voice — a plan, or a restatement
  // of the assistant's last message — instead of the next thing the user types.
  const requests = [];
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'fix the parser' }] } },
    { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'Done, tests pass.' }] } },
  ];
  const h = harness({ events, nodes: [0, 1], onStream: (request) => requests.push(request) });
  try {
    h.trigger(); await delay(450);
    assert.equal(requests.length, 1, 'the model was asked once');
    const prompt = requests[0].messages[0].content[0].text;
    assert.ok(prompt.trimEnd().endsWith('USER:'), 'the transcript ends with an open USER turn');
    assert.ok(prompt.includes('ASSISTANT: Done, tests pass.'), 'and still carries the reply above it');
  } finally { h.dispose(); }
});

test('a to-do list handed to the user is not offered as a prediction', async () => {
  // The reported failure: a draft that read like the assistant's next step.
  // An unambiguous list shape is rejected; an ordinary request is kept.
  const h = harness({ stream: async function* () { yield { type: 'text-delta', text: '一是不压工具栏，二是预测不编造。' }; } });
  try {
    h.trigger(); await delay(450);
    const draft = (await h.request('get?sessionId=s1')).body.suggestion;
    assert.equal(draft, null, 'the enumerated list is rejected');
  } finally { h.dispose(); }

  const ok = harness({ stream: async function* () { yield { type: 'text-delta', text: '把 adaptive 学习关掉再出一版给我对比。' }; } });
  try {
    ok.trigger(); await delay(450);
    const draft = (await ok.request('get?sessionId=s1')).body.suggestion;
    assert.equal(draft?.text, '把 adaptive 学习关掉再出一版给我对比。', 'a normal request survives');
  } finally { ok.dispose(); }
});

test('a manual clear recalls the line while a send clears it', async () => {
  // Both transitions empty the composer, so the Client cannot tell them apart and
  // reports nothing but "the composer is empty". The Host decides from the
  // session log: a send appended a `user/message`, a manual clear did not.
  const events = [];
  const h = harness({ events });
  try {
    h.trigger(); await delay(450);
    const first = (await h.request('get?sessionId=s1')).body.suggestion;
    await h.request('accepted', { method: 'POST', body: { sessionId: 's1' } });

    // Manual clear: the log gained nothing.
    await h.request('drop', { method: 'POST', body: { sessionId: 's1' } });
    const cleared = (await h.request('get?sessionId=s1')).body;
    assert.equal(cleared.suggestion ?? cleared.history[0], first.text, 'the line is painted again');
    assert.deepEqual(cleared.history, [first.text], 'and it is recallable');

    // A real send: the log gains a user message, which is the proof.
    h.trigger(); await delay(450);
    events.push({ type: 'user/message' });
    await h.request('drop', { method: 'POST', body: { sessionId: 's1' } });
    const sent = (await h.request('get?sessionId=s1')).body;
    assert.deepEqual(sent.history, [], 'a send leaves nothing to recall');
    assert.equal(sent.suggestion, null);
  } finally { h.dispose(); }
});

test('every mutation works when the desktop proxy has stripped Origin', async () => {
  // This is the regression that mattered.
  //
  // The page is served from `dsh-app://app`; Electron's proxy deletes `origin`
  // (and rewrites host and cookie) before forwarding here. A rule requiring the
  // header for non-GET requests therefore answered 403 to every mutation, so
  // dismiss, accept and send silently never reached the Host — and the visible
  // symptom was only "the ghost came back".
  const h = harness();
  try {
    h.trigger(); await delay(450);
    const suggestion = (await h.request('get?sessionId=s1')).body.suggestion;
    assert.ok(suggestion !== null, 'a suggestion exists to act on');

    // Each of these is what the Client sends through the proxy: no Origin.
    for (const action of ['dismiss', 'accepted', 'drop', 'reset']) {
      const response = await h.request(action, {
        method: 'POST',
        origin: null,
        body: { sessionId: 's1', text: suggestion.text },
      });
      assert.equal(response.status, 200, `${action} must be admitted without an Origin header`);
    }
  } finally { h.dispose(); }
});

test('the diag route reports what the bridge has served', async () => {
  // Without this, "did the mutation arrive" can only be answered from DevTools.
  const h = harness();
  try {
    h.trigger(); await delay(450);
    await h.request('get?sessionId=s1');
    await h.request('dismiss', { method: 'POST', body: { sessionId: 's1', text: 'x' } });
    const response = await h.request('diag');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(typeof response.body.version === 'string');
    assert.ok(response.body.counts.dismiss >= 1, 'the mutation is counted');
    assert.ok(response.body.counts.get >= 1, 'reads are counted');
    const outcomes = (response.body.requests ?? []).map((entry) => `${entry.outcome}:${entry.action}`);
    assert.ok(outcomes.includes('ok:dismiss'), 'the mutation is logged');
  } finally { h.dispose(); }
});

test('polling does not discard a prediction already based on the newly completed turn', async () => {
  const events = [{ type: 'user/message' }, { type: 'turn/end', data: { turn: 1 } }];
  const h = harness({ events });
  try {
    h.poll();
    events.push({ type: 'user/message' }, { type: 'turn/end', data: { turn: 2 } });
    h.trigger(); await delay(450);
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Continue testing');
    h.poll();
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Continue testing');
    events.push({ type: 'user/message' });
    h.poll();
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion, null);
  } finally { h.dispose(); }
});

test('an event and a later polling observation of the same turn make only one prediction', async () => {
  const events = [{ type: 'user/message' }, { type: 'turn/end', data: { turn: 1 } }];
  let calls = 0;
  const h = harness({ events, stream: async function* () { calls++; yield { type: 'text-delta', text: 'Test suggestion' }; } });
  try {
    h.poll();
    events.push({ type: 'user/message' });
    h.poll();
    events.push({ type: 'turn/end', data: { turn: 2 } });
    h.trigger(); await delay(450);
    h.poll(); await delay(10);
    assert.equal(calls, 1);
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Test suggestion');
  } finally { h.dispose(); }
});

test('polling triggers a completed turn even when submission and completion arrive together', async () => {
  const events = [{ type: 'user/message' }, { type: 'turn/end', data: { turn: 1 } }];
  const h = harness({ events });
  try {
    h.poll();
    events.push({ type: 'user/message' }, { type: 'turn/end', data: { turn: 2 } });
    h.poll(); await delay(10);
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Continue testing');
  } finally { h.dispose(); }
});

test('a new user message invalidates old work even as the 400-event window slides', async () => {
  const events = [{ type: 'user/message' }, ...Array.from({ length: 399 }, () => ({}))];
  const h = harness({ events });
  try {
    h.poll(); h.trigger(); await delay(450);
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Continue testing');
    events.push({ type: 'user/message' });
    h.poll();
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion, null);
  } finally { h.dispose(); }
});

test('idle before turn/end and polling afterwards do not generate twice', async () => {
  const events = [{ type: 'user/message' }, { type: 'turn/end', data: { turn: 1 } }];
  let calls = 0;
  const h = harness({ events, stream: async function* () { calls++; yield { type: 'text-delta', text: 'Test suggestion' }; } });
  try {
    h.poll(); events.push({ type: 'user/message' }); h.poll();
    h.trigger(); await delay(450);
    events.push({ type: 'turn/end', data: { turn: 2 } });
    h.poll(); await delay(10);
    assert.equal(calls, 1);
  } finally { h.dispose(); }
});

test('sending after a turn closed does not bring the ghost back', async () => {
  // The plugin is already watching while turn 1 runs, so its baseline is
  // recorded BEFORE turn 1 closes. Then: turn 1 ends, the event trigger
  // predicts for it, and the user ignores the suggestion and sends their own
  // message. The next poll sees both the completed turn and the new submission;
  // it must not bill a second prediction whose draft would paint over the
  // freshly emptied composer and sit there until the user speaks again.
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message' }];
  let calls = 0;
  const h = harness({ events, stream: async function* () { calls++; yield { type: 'text-delta', text: `draft ${calls}` }; } });
  try {
    h.poll(); await delay(10);
    // Turn 1 closes while the plugin is watching.
    events.push({ type: 'turn/end', data: { turn: 1 } });
    h.stopping(1); await delay(450);
    assert.equal(calls, 1, 'the completed turn is predicted once');
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'draft 1');
    // The user sends their own message instead of taking it.
    events.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message' });
    h.poll(); await delay(20);
    assert.equal(calls, 1, 'the abandoned turn is not predicted again');
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion, null, 'the ghost stays gone');
  } finally { h.dispose(); }
});

test('a long turn bills once even after its user message leaves the scan window', async () => {
  // A tool-heavy turn appends enough events that the `user/message` that opened
  // it is no longer inside the 400-event tail the boundary scan reads. The turn
  // number must still identify the turn, so the stopping trigger and the poll
  // that follows agree instead of charging twice.
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message' }, { type: 'turn/end', data: { turn: 1 } }];
  let calls = 0;
  const h = harness({ events, stream: async function* () { calls++; yield { type: 'text-delta', text: 'Long turn draft' }; } });
  try {
    h.poll(); await delay(10);
    // The turn being measured: submission, then hundreds of tool events.
    events.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message' });
    for (let i = 0; i < 120; i += 1) {
      events.push({ type: 'step/start' }, { type: 'assistant/message' }, { type: 'tool/call' }, { type: 'tool/result' }, { type: 'step/end' });
    }
    h.stopping(2); await delay(450);
    assert.equal(calls, 1, 'the stopping trigger predicts once');
    events.push({ type: 'turn/end', data: { turn: 2 } });
    h.poll(); await delay(20);
    assert.equal(calls, 1, 'the poll does not bill the same turn again');
  } finally { h.dispose(); }
});

test('a turn with no user message in the window still bills once', async () => {
  // Continuation turns can close without a fresh `user/message` nearby. A
  // sequence-numbered boundary changed when `turn/end` was appended and billed
  // such a turn twice; the turn number does not move.
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }];
  let calls = 0;
  const h = harness({ events, stream: async function* () { calls++; yield { type: 'text-delta', text: 'Continuation draft' }; } });
  try {
    h.poll(); await delay(10);
    events.push({ type: 'turn/start', data: { turn: 2 } });
    h.stopping(2); await delay(450);
    assert.equal(calls, 1);
    events.push({ type: 'turn/end', data: { turn: 2 } });
    h.poll(); await delay(20);
    assert.equal(calls, 1);
  } finally { h.dispose(); }
});

test('a dismissed suggestion stays dismissed instead of coming back from history', async () => {
  // The Client paints `suggestion ?? history[0]`, so a line left in the recall
  // ring is re-shown on the very next poll. A fresh draft used to be written
  // back into that ring on dismissal, which made Escape look broken: the ghost
  // vanished and then reappeared a couple of seconds later.
  const h = harness();
  try {
    h.trigger(); await delay(450);
    const fresh = (await h.request('get?sessionId=s1')).body;
    assert.equal(fresh.suggestion.text, 'Continue testing');
    assert.deepEqual(fresh.history, [], 'nothing recallable before dismissing');

    await h.request('dismiss', { method: 'POST', body: { sessionId: 's1', text: fresh.suggestion.text, fromHistory: false } });
    const after = (await h.request('get?sessionId=s1')).body;
    assert.equal(after.suggestion, null, 'the ghost is gone');
    assert.deepEqual(after.history, [], 'and it is not recallable either');

    // A dismissal of the auto-restore fallback behaves the same way.
    h.trigger(); await delay(450);
    const second = (await h.request('get?sessionId=s1')).body;
    await h.request('dismiss', { method: 'POST', body: { sessionId: 's1', text: second.suggestion.text, fromHistory: true } });
    const after2 = (await h.request('get?sessionId=s1')).body;
    assert.equal(after2.suggestion, null);
    assert.deepEqual(after2.history, []);
  } finally { h.dispose(); }
});

test('settings and learned feedback survive disposal and reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-predict-test-'));
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = dir;
  let h;
  try {
    h = harness();
    assert.equal((await h.request('config', { method: 'POST', body: { mode: 'recent', recentTurns: 3 } })).status, 200);
    h.trigger(); await delay(450);
    assert.equal((await h.request('get?sessionId=s1')).body.suggestion.text, 'Continue testing');
    await h.request('accepted', { method: 'POST', body: { sessionId: 's1' } });
    const config = readFileSync(join(dir, 'prompt-predict-adaptive', 'config.json'), 'utf8');
    const feedback = readFileSync(join(dir, 'prompt-predict-adaptive', 'feedback.json'), 'utf8');
    h.dispose(); h = null;
    assert.equal(readFileSync(join(dir, 'prompt-predict-adaptive', 'config.json'), 'utf8'), config);
    assert.equal(readFileSync(join(dir, 'prompt-predict-adaptive', 'feedback.json'), 'utf8'), feedback);
    h = harness();
    const result = (await h.request('get?sessionId=s1')).body;
    assert.equal(result.config.mode, 'recent'); assert.equal(result.config.recentTurns, 3);
    assert.equal(result.learned.accepted, 1);
  } finally {
    h?.dispose();
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('superseded or dropped prediction failures cannot replace current state', async () => {
  const pending = [];
  const h = harness({ stream: () => (async function* () { const value = await new Promise((resolve, reject) => pending.push({ resolve, reject })); yield { type: 'text-delta', text: value }; })() });
  try {
    h.trigger(); await delay(450);
    h.trigger(); await delay(450);
    assert.equal(pending.length, 2);
    pending[1].resolve('New suggestion'); await delay(10);
    pending[0].reject(Error('old failure')); await delay(10);
    let state = (await h.request('get?sessionId=s1')).body;
    assert.equal(state.suggestion.text, 'New suggestion'); assert.equal(state.error, null);
    h.trigger(); await delay(450);
    // A send, not a manual clear: the Client reports `submitted: true` and, with
    // no live session log to consult here, the Host takes that at its word.
    await h.request('drop', { method: 'POST', body: { sessionId: 's1', submitted: true } });
    pending[2].reject(Error('dropped failure')); await delay(10);
    state = (await h.request('get?sessionId=s1')).body;
    assert.equal(state.suggestion, null); assert.equal(state.error, null);
    h.trigger(); await delay(450);
    pending[3].reject(Error('current failure')); await delay(10);
    assert.equal((await h.request('get?sessionId=s1')).body.error, 'current failure');
  } finally { h.dispose(); }
});
