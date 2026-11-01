/**
 * dsh-prompt-predict-adaptive — Host half.
 *
 * After every completed turn this asks the SESSION'S OWN ROUTED MODEL for the
 * message the user is most likely to send next, and hands the draft to the
 * Client half as ghost text. Accepting it with Tab only fills the composer; it
 * never submits.
 *
 * Three invariants this file exists to guarantee:
 *
 * 1. **The prediction uses the model the user picked for this conversation.**
 *    The target is read from `session.requestHeader().config`, which is the
 *    durable envelope the last real request was routed under. There is no
 *    fallback to a default provider or to the official account: when a session
 *    has not routed a request yet, we produce nothing rather than silently
 *    billing a different route.
 *
 * 2. **The prediction never enters the conversation.** The call goes straight
 *    to `ctx.llm.stream()`; it is not an agent step, appends no session event,
 *    and cannot appear in the surface, the transcript, or a later replay.
 *
 * 3. **Durable settings survive plugin deactivation.** State is kept under the
 *    profile until the user explicitly removes it after uninstalling.
 *
 * @module dsh-prompt-predict-adaptive
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Route prefix owned by this plugin; the Client half posts here. */
const ROUTE = "/prompt-predict-adaptive";
/** Directory name under the DSH home holding this plugin's single state file. */
const STATE_DIR = "prompt-predict-adaptive";

/**
 * The directive. It is appended as the FINAL user message after the replayed
 * conversation, so the auxiliary call is a genuine prefix of the last routed
 * request and the provider's prefix cache stays warm.
 *
 * Wording follows what actually produced useful drafts in practice: name the
 * concrete next action, keep the user's own language, and refuse to invent a
 * suggestion when the conversation has no obvious continuation.
 */
const INSTRUCTION = [
  "You are a transcript analyst. Below this instruction message is a transcript of a finished conversation between a USER and a coding ASSISTANT.",
  "",
  "Your ONLY job: predict the single next message the USER would most likely type.",
  "",
  "Hard constraints:",
  "- Output plain text only. Do NOT emit tool calls, function calls, XML/DSML tags, JSON, or any protocol markup.",
  "- Do NOT continue the conversation, do NOT answer the user, do NOT write as the ASSISTANT.",
  "- Do NOT comment on this instruction or on the transcript.",
  "- There is no tool available to you. Do not attempt to use one.",
  "",
  "Content rules:",
  "- Write in the same language the USER has been using.",
  "- Phrase it as the USER speaking: imperative, first person.",
  "- Prefer the most probable CONCRETE next step: run the tests, fix that failure, commit it, verify a specific file, continue the plan.",
  "- If the transcript left a specific unresolved item (a failing check, an unverified claim, an unfinished step), name it together with the exact file or command.",
  "- One line. One sentence is ideal; a second sentence is allowed only when naming files is what makes it useful.",
  "- No preamble, no quotes, no bullets, no explanation, no markdown fence.",
  "- If there is no plausible next message, output exactly: NO_PREDICTION",
  "",
  "=== TRANSCRIPT ===",
].join("\n");

/** Normalize a config record against the supported surface. */
function resolveConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mode = source.mode === "recent" ? "recent" : "full";
  const recentTurns = Number.isInteger(source.recentTurns)
    ? Math.min(Math.max(source.recentTurns, 1), 40)
    : 6;
  // `adaptive` turns the learned steering on or off. With it off this build
  // behaves exactly like the plain build: same directive, same context, no
  // per-session examples. That makes a separate basic bundle unnecessary.
  const adaptive = source.adaptive !== false;
  // Both default on: they make a draft more actionable, and each can be turned
  // off from the plugin page when the extra prompt or the delay is unwanted.
  const workspace = source.workspace !== false;
  const permissions = source.permissions !== false;
  // Off by default: the diagnose endpoint spends a model call and forwards the
  // transcript, so it is opt-in for debugging only.
  const diagnostics = source.diagnostics === true;
  return { enabled: source.enabled !== false, mode, recentTurns, adaptive, workspace, permissions, diagnostics };
}

/** Longest example kept as a steering hint; longer drafts are truncated. */
const MAX_EXAMPLE = 240;
/** How many accepted drafts steer the next prediction. */
const MAX_ACCEPTED = 5;
/** How many dismissed drafts are shown as counter-examples. */
const MAX_DISMISSED = 3;
/**
 * How many sessions keep learned steering.
 *
 * The cache is a convenience, not a record: it holds at most a few drafts per
 * session for a handful of recent conversations. Anything older is dropped on
 * load, so the file stays small and deleting it costs nothing but relearning.
 */
const MAX_SESSIONS = 20;
/** How many recent drafts a session can recall after accepting or dismissing. */
const MAX_HISTORY = 8;

/**
 * Normalize one session's learned feedback.
 *
 * The shape is deliberately small and JSON-only so it survives a restart and
 * never depends on a runtime object.
 *
 * @param raw - previously stored feedback, if any.
 * @returns feedback with bounded, type-checked arrays.
 */
function resolveFeedback(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const accepted = Array.isArray(source.accepted)
    ? source.accepted.filter((v) => typeof v === "string" && v.length > 0).slice(-MAX_ACCEPTED)
    : [];
  const dismissed = Array.isArray(source.dismissed)
    ? source.dismissed.filter((v) => typeof v === "string" && v.length > 0).slice(-MAX_DISMISSED)
    : [];
  // `at` is the last write time, used only to keep the newest sessions when the
  // stored set is trimmed on load.
  const at = Number.isFinite(source.at) ? source.at : 0;
  return { accepted, dismissed, at };
}

/**
 * Render the learned steering block appended to the prediction directive.
 *
 * This is the whole difference from the basic build: the basic build always
 * sends the same instruction, while this one tells the model which phrasings
 * this user actually accepted and which they threw away.
 *
 * @param feedback - normalized per-session feedback.
 * @returns extra prompt text, or an empty string when nothing was learned yet.
 */
function steeringText(feedback) {
  if (feedback.accepted.length === 0 && feedback.dismissed.length === 0) return "";
  const lines = ["", "This user's own recent follow-ups in THIS conversation, which you should match in voice, length, and specificity:"];
  if (feedback.accepted.length > 0) {
    lines.push("ACCEPTED (they pressed Tab on these, so they are on target):");
    for (const item of feedback.accepted) lines.push(`- ${item.slice(0, MAX_EXAMPLE)}`);
  }
  if (feedback.dismissed.length > 0) {
    lines.push("DISMISSED (they ignored these, so avoid this shape or subject):");
    for (const item of feedback.dismissed) lines.push(`- ${item.slice(0, MAX_EXAMPLE)}`);
  }
  return lines.join("\n");
}

/** Flatten one content block list into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * Rebuild the request prefix the model should reason over.
 *
 * `full` replays every surface node the way the last real request would have
 * seen it. `recent` keeps only the trailing window: the system prompt plus the
 * last N user/assistant exchanges. Both drop tool results, which are bulky and
 * rarely change what the user is about to ask for.
 *
 * @param session - session whose surface supplies the conversation.
 * @param config - resolved plugin configuration.
 * @returns ordered request messages, or an empty array when there is nothing.
 */
function buildContext(session, config) {
  const nodes = session.surface.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const collected = [];
  for (const seq of nodes) {
    let message;
    try {
      message = session.deriveEventMessage(session.eventAt(seq));
    } catch {
      continue;
    }
    if (!message || message.role === "tool") continue;
    const text = textOf(message.content);
    if (text.length === 0) continue;
    // Keep the derived message itself: the adapter rebuilds assistant turns
    // from `message.source`, and a stripped copy loses the provider metadata
    // the request needs.
    collected.push({ role: message.role, text, message });
  }
  if (collected.length === 0) return [];

  let windowed = collected;
  if (config.mode === "recent") {
    // Keep the leading system message, then the trailing exchanges.
    const system = collected[0].role === "system" ? collected[0] : undefined;
    const rest = system === undefined ? collected : collected.slice(1);
    // Walk back to the Nth-from-last user message and cut there, so the window
    // starts on a user turn rather than on the assistant reply before it.
    let start = 0;
    let users = 0;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      if (rest[i].role !== "user") continue;
      users += 1;
      start = i;
      if (users >= config.recentTurns) break;
    }
    windowed = system === undefined ? rest.slice(start) : [system, ...rest.slice(start)];
  }

  // Render the window as ONE plain-text transcript instead of a role-structured
  // message list.
  //
  // Two failure modes forced this:
  //   1. Hand-built `{ role, content }` objects crash the pi-ai adapter, which
  //      rebuilds assistant turns from `message.source.replayState`.
  //   2. Replaying the real message list (with its tool-call history and the
  //      session's tool-bearing system prompt) makes the model answer with a
  //      tool call — observed as a raw `<｜｜DSML｜｜ calls>` marker and a 2 KB
  //      reply that yields no usable draft.
  //
  // A single user message that merely *describes* the conversation leaves the
  // model no role to continue and no tool to reach for.
  const lines = [];
  for (const item of windowed) {
    if (item.role === "system") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const who = item.role === "user" ? "USER" : "ASSISTANT";
    lines.push(`${who}: ${item.text}`);
  }
  if (lines.length === 0) return [];
  const transcript = lines.join("\n\n");
  return [{ role: "user", content: [{ type: "text", text: transcript }] }];
}

/**
 * Strip the model's reply down to a usable one-line draft.
 *
 * A reply that starts explaining itself is not a user message, and a reply
 * that repeats the instruction is not a prediction.
 *
 * @param raw - accumulated assistant text.
 * @returns the draft, or an empty string when nothing usable came back.
 */
function cleanPrediction(raw) {
  const text = (raw ?? "").trim();
  if (text.length === 0) return "";

  // The reply can carry more than one line even when asked for one: a fence, a
  // short preamble, or a bulleted list. Scan candidates in order and take the
  // first that reads as a user message, instead of judging only line one.
  const candidates = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    line = line.replace(/^[-*•]\s*/, "").trim();
    line = line.replace(/^#+\s*/, "").trim();
    line = line.replace(/^["'`“”「」]+|["'`“”「」]+$/g, "").trim();
    if (line.length === 0) continue;
    candidates.push(line);
  }

  for (const line of candidates) {
    if (/^NO_PREDICTION[.。]?$/i.test(line)) continue;
    if (line.length > 400) continue;
    // A draft that talks about the prediction machinery, or about being an
    // assistant, is the model narrating its own task rather than speaking as
    // the user. Reject that shape and keep looking.
    if (/^(sure[,.]|here('s| is)|the user|as an ai|i (cannot|can't|don't|must|should|will|need))/i.test(line)) continue;
    if (/\b(this|that|my|the) (message|instruction|prediction|request|prompt|constant)\b/i.test(line)) continue;
    if (/\bINSTRUCTION\b/.test(line)) continue;
    if (/\b(composer prediction|prediction task|you are predicting)\b/i.test(line)) continue;
    // A markdown fence or heading is not a user message.
    if (/^```/.test(line)) continue;
    return line;
  }
  return "";
}

/**
 * Describe what this session has changed in the workspace.
 *
 * Codex's suggestions can name exact files because they see the project; ours
 * only see the conversation. This closes that gap without reading files: the
 * host already keeps a per-turn summary of changed paths and their line counts,
 * which is enough to say "finish the edit in <path>" convincingly.
 *
 * @param ctx - Host context supplying the optional workspace-changes service.
 * @param agent - session whose latest recorded summary is read.
 * @returns a short block of text, or an empty string when nothing is known.
 */
function workspaceText(ctx, agent) {
  const service = ctx.get("workspaceChanges");
  if (service === undefined) return "";
  try {
    // Walk back from the newest event to the latest recorded `workspace/changes`.
    const session = agent.session;
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      if (event.type !== "workspace/changes") continue;
      const summary = service.summary(session.id, event.seq);
      if (summary === undefined) continue;
      const files = (summary.files ?? []).slice(0, 12);
      if (files.length === 0) return "";
      const lines = ["", "=== WORKSPACE CHANGES IN THIS SESSION ==="];
      lines.push(`cwd: ${summary.cwd}`);
      lines.push(`totals: +${summary.added} -${summary.deleted} across ${summary.total} file(s)`);
      for (const file of files) {
        const size = file.binary === true ? "binary" : `+${file.added} -${file.deleted}`;
        lines.push(`- ${file.display} (${size})`);
      }
      if (summary.total > files.length) lines.push(`- … and ${summary.total - files.length} more`);
      return lines.join("\n");
    }
  } catch {
    /* an unreadable summary simply contributes nothing */
  }
  return "";
}

/**
 * Report the permissions this session is running under.
 *
 * The prediction request inherits the session's route already; stating the
 * sandbox and approval posture lets the model avoid suggesting an action the
 * session could not take (a write under read-only, a run under `never`).
 *
 * @param ctx - Host context supplying the optional policy services.
 * @param agent - session whose logged overrides are read.
 * @returns a short block of text, or an empty string when neither service runs.
 */
function permissionText(ctx, agent) {
  const parts = [];
  const sandbox = ctx.get("sandboxPolicy");
  if (sandbox !== undefined) {
    try {
      const policy = sandbox.resolve({ session: agent.session });
      parts.push(`sandbox: ${policy.mode}`);
    } catch {
      /* a policy that cannot be resolved is simply not reported */
    }
  }
  const approval = ctx.get("approval");
  if (approval !== undefined) {
    try {
      const policy = approval.overrideOf(agent.session);
      if (policy !== undefined) parts.push(`approval: ${policy}`);
    } catch {
      /* same: omit rather than guess */
    }
  }
  if (parts.length === 0) return "";
  return `\n\n=== SESSION PERMISSIONS ===\n${parts.join("\n")}\nDo not suggest an action these permissions forbid.`;
}

/**
 * Ask one routed model for the next user message.
 *
 * @param ctx - Host context supplying the LLM service.
 * @param agent - owner of the session being predicted for.
 * @param config - resolved plugin configuration.
 * @param feedback - this session's learned steering examples.
 * @param signal - cancellation forwarded to the adapter.
 * @returns the cleaned draft and the route that produced it.
 */
async function predict(ctx, agent, config, feedback, signal) {
  const header = agent.session.requestHeader();
  const routed = header?.config;
  if (routed === undefined || !routed.provider || !routed.model) {
    // No durable route yet: producing nothing beats billing a route the user
    // did not choose for this conversation.
    return { text: "", provider: undefined, model: undefined };
  }

  const messages = buildContext(agent.session, config);
  if (messages.length === 0) return { text: "", provider: routed.provider, model: routed.model };

  // Deliberately NO `tools`, NO `toolHistory`, and NO `system` here.
  //
  // The session's system prompt describes the full tool surface; carrying it
  // gives the model a role to continue and tools to reach for, and it answers
  // with a tool call (observed: a `<｜｜DSML｜｜ calls>` marker and a 2 KB reply
  // that produces no draft). Everything needed to guess the next line is in
  // the transcript, so this is one self-contained user message: instruction
  // first (plus this session's learned steering), transcript beneath it.
  const transcript = typeof messages[0]?.content?.[0]?.text === "string" ? messages[0].content[0].text : "";
  if (transcript.length === 0) return { text: "", provider: routed.provider, model: routed.model };
  // With `adaptive` off this is exactly the plain build: the base directive and
  // nothing else. Turning it on appends this session's accepted/dismissed
  // examples so later drafts converge on the user's own phrasing.
  const instruction = config.adaptive === false ? INSTRUCTION : INSTRUCTION + steeringText(feedback);
  // Workspace state is opt-in: it sharpens the draft at the cost of a longer
  // prompt, and some users would rather keep the call purely conversational.
  const workspace = config.workspace === false ? "" : workspaceText(ctx, agent);
  const permissions = config.permissions === false ? "" : permissionText(ctx, agent);
  const request = {
    provider: routed.provider,
    model: routed.model,
    messages: [
      { role: "user", content: [{ type: "text", text: `${instruction}${workspace}${permissions}\n${transcript}` }] },
    ],
    sessionId: agent.session.id,
    ...signal === undefined ? {} : { signal },
  };

  let raw = "";
  const chunks = [];
  let finishKind = null;
  for await (const chunk of ctx.llm.stream(request)) {
    if (chunks.length < 12) chunks.push(chunk.type);
    if (chunk.type === "text-delta") raw += chunk.text;
    else if (chunk.type === "finish") {
      finishKind = chunk.reason.kind;
      if (chunk.reason.kind === "error") {
        // Surface the provider's own words. A silent empty result is
        // indistinguishable from a broken plugin, and the common case here is a
        // quota/rate limit the user can act on by switching model.
        const failure = chunk.reason.failure;
        return {
          text: "",
          provider: routed.provider,
          model: routed.model,
          error: failure?.code === "QUOTA" || failure?.status === 429
            ? "prediction skipped: the provider is rate limited or out of quota"
            : `prediction failed: ${failure?.message ?? "unknown error"}`,
          debug: { chunks, finishKind, error: failure },
        };
      }
    }
  }
  return { text: cleanPrediction(raw), provider: routed.provider, model: routed.model, debug: { chunks, finishKind, rawLen: raw.length } };
}

/**
 * Host half of the prediction bundle.
 *
 * @param ctx - Host plugin context.
 * @param rawConfig - the row's `config` as written in the patch.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  /** Latest draft per session id. Memory only: never durable, never replayed. */
  const drafts = new Map();
  /** In-flight requests, so a newer turn supersedes an older one. */
  const inflight = new Map();
  /** Learned steering per session id. Durable, so acceptance survives restarts. */
  const feedback = new Map();
  /**
   * Why the last prediction for a session produced nothing, per session id.
   *
   * Kept so the settings page can say "the model is rate limited" instead of
   * leaving the user wondering why no ghost ever appears. Cleared on the next
   * success.
   */
  const lastError = new Map();
  /**
   * The most recent failure across every session.
   *
   * The settings page has no session of its own and queries with an empty id, so
   * a per-session map alone is unreachable from there. This carries the newest
   * message so that surface can still report it.
   */
  let lastGlobalError = null;

  // State lives in one file inside the plugin's own directory so that removing
  // the bundle can remove it without touching anything else.
  const home = process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? ".";
  const stateDir = join(home, STATE_DIR);
  const stateFile = join(stateDir, "config.json");
  const feedbackFile = join(stateDir, "feedback.json");

  /**
   * Recently produced drafts per session, newest first, in memory only.
   *
   * Accepting a draft fills the composer; clearing it afterwards would otherwise
   * lose the text for good, and asking the model again costs a full call. This
   * keeps the last few so the user can recall one after an accidental deletion.
   */
  const history = new Map();

  /** Push one draft onto a session's recall ring, de-duplicating the newest. */
  function pushHistory(existing, text) {
    const list = Array.isArray(existing) ? existing : [];
    const withoutText = list.filter((item) => item !== text);
    return [text, ...withoutText].slice(0, MAX_HISTORY);
  }

  let persisted = {};
  try {
    persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    /* first run, or the file was removed with a previous uninstall */
  }
  const live = resolveConfig({ ...config, ...persisted });

  let persistedFeedback = {};
  try {
    persistedFeedback = JSON.parse(readFileSync(feedbackFile, "utf8"));
  } catch {
    /* nothing learned yet */
  }
  if (persistedFeedback && typeof persistedFeedback === "object") {
    // Keep the newest MAX_SESSIONS entries so the file cannot grow without
    // bound across months of sessions; entries are keyed by session id and
    // stamped when last written.
    const entries = Object.entries(persistedFeedback)
      .filter(([, value]) => value && typeof value === "object")
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_SESSIONS);
    for (const [sessionId, value] of entries) {
      feedback.set(sessionId, resolveFeedback(value));
    }
  }

  /** Persist the current mode selection. Best effort: a failure is not fatal. */
  function persist() {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(stateFile, JSON.stringify(live, null, 2), "utf8");
    } catch {
      /* the setting simply will not survive a restart */
    }
  }

  /** Persist learned feedback, keeping only the newest MAX_SESSIONS sessions. */
  function persistFeedback() {
    try {
      mkdirSync(stateDir, { recursive: true });
      const entries = [...feedback.entries()]
        .filter(([, value]) => value.accepted.length > 0 || value.dismissed.length > 0)
        .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
        .slice(0, MAX_SESSIONS);
      const plain = {};
      for (const [sessionId, value] of entries) plain[sessionId] = value;
      writeFileSync(feedbackFile, JSON.stringify(plain, null, 2), "utf8");
      // Drop the trimmed tail from memory too, so the live map matches the file.
      const kept = new Set(entries.map(([sessionId]) => sessionId));
      for (const sessionId of [...feedback.keys()]) {
        if (!kept.has(sessionId)) feedback.delete(sessionId);
      }
    } catch {
      /* steering will be relearned from this session's live traffic */
    }
  }

  /** Read this session's feedback, creating an empty record on first use. */
  function feedbackFor(sessionId) {
    let value = feedback.get(sessionId);
    if (value === undefined) {
      value = resolveFeedback(undefined);
      feedback.set(sessionId, value);
    }
    return value;
  }

  // ---- Turn-completion trigger ------------------------------------------
  //
  // Three independent signals are wired, because each one alone has a blind
  // spot that was observed in practice:
  //
  //   1. `session/event` watcher on the durable `turn/end` append. This is the
  //      most trustworthy source: the event is committed to the log before the
  //      feed runs, so it fires exactly once per turn and cannot be missed.
  //   2. `agent/status` entering `idle`, which also covers aborts and errors
  //      where a turn may not close normally.
  //   3. `agent/turn-stopping`, the loop's own "model owes nothing" boundary.
  //
  // All three funnel into one debounced call so a single turn produces exactly
  // one prediction.
  const diagnostics = { created: 0, stopping: 0, idle: 0, turnEnd: 0, lastError: null, lastAt: 0 };

  /** Register the turn listeners for one agent; returns its disposer. */
  function bindAgent(agent) {
    const sessionId = agent.session.id;
    let pending = null;

    /** Collapse bursts from several triggers into one prediction per turn. */
    function schedule(reason) {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        diagnostics.stopping += 1;
        diagnostics.lastAt = Date.now();
        runPrediction(agent, sessionId);
      }, 400);
      if (reason === "turn-end") diagnostics.turnEnd += 1;
    }

    // 1) Durable turn boundary. `session/event` is scope-filtered too, so this
    //    is registered on the agent context as well.
    const disposeEvent = agent.ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      // Only a settled turn is worth predicting against; a forked or
      // interrupted turn leaves the conversation mid-thought.
      if (reason?.kind === "forked" || reason?.kind === "aborted" || reason?.kind === "interrupted") return;
      schedule("turn-end");
    });

    // 2) Agent went idle: covers paths that end without a normal turn close.
    const disposeStatus = agent.ctx.on("agent/status", (payload) => {
      if (payload?.status !== "idle") return;
      diagnostics.idle += 1;
      schedule("idle");
    });

    // 3) The loop's own stopping boundary.
    const disposeStopping = agent.ctx.on("agent/turn-stopping", () => {
      schedule("stopping");
    });

    return () => {
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      disposeEvent();
      disposeStatus();
      disposeStopping();
    };
  }

  /**
   * Bumped whenever the composer is submitted.
   *
   * A prediction started before the submission describes a turn that is already
   * history; letting it land would drop a stale suggestion into the fresh
   * composer. Each attempt records the epoch it began under and discards its own
   * result if the epoch moved on.
   */
  const dropEpoch = new Map();
  // The polling fallback can observe a submission after a fast prediction for
  // that same completed turn has already started or finished.
  const predictionUserSeq = new Map();
  const predictionTurnKey = new Map();

  function predictionBoundary(session) {
    let lastUser = -1;
    let lastTurn = -1;
    for (let seq = Math.max(0, session.seq - 400); seq < session.seq; seq += 1) {
      const type = session.eventAt(seq)?.type;
      if (type === "user/message") lastUser = seq;
      if (type === "turn/end") lastTurn = seq;
    }
    // The same submission may emit idle before turn/end is persisted. Keying
    // on both events would charge twice when the later event arrives.
    return { lastUser, key: lastUser >= 0 ? `user:${lastUser}` : lastTurn >= 0 ? `turn:${lastTurn}` : undefined };
  }

  /** Invalidate in-flight predictions and forget anything pending for a session. */
  function consumePending(sessionId) {
    dropEpoch.set(sessionId, (dropEpoch.get(sessionId) ?? 0) + 1);
    drafts.delete(sessionId);
    history.delete(sessionId);
    const prior = inflight.get(sessionId);
    if (prior !== undefined) {
      try {
        prior.abort();
      } catch {
        /* already settled */
      }
      inflight.delete(sessionId);
    }
  }

  /** Ask for a prediction for one agent, superseding any in-flight one. */
  function runPrediction(agent, sessionId) {
    if (!live.enabled) return;
    try {
      const boundary = predictionBoundary(agent.session);
      if (boundary.key !== undefined && predictionTurnKey.get(sessionId) === boundary.key) return;
      if (boundary.key !== undefined) predictionTurnKey.set(sessionId, boundary.key);
      predictionUserSeq.set(sessionId, boundary.lastUser);
    } catch {
      predictionUserSeq.delete(sessionId);
      predictionTurnKey.delete(sessionId);
    }
    // A new turn begins here, so whatever was recallable belongs to the previous
    // exchange. Keeping it would let the accepted-then-sent line resurface as the
    // auto-restore fallback in the newly emptied composer.
    history.delete(sessionId);
    lastError.delete(sessionId);
    lastGlobalError = null;
    const prior = inflight.get(sessionId);
    if (prior !== undefined) {
      try {
        prior.abort();
      } catch {
        /* already settled */
      }
    }
    const epoch = dropEpoch.get(sessionId) ?? 0;
    const controller = new AbortController();
    inflight.set(sessionId, controller);
    predict(ctx, agent, live, feedbackFor(sessionId), controller.signal).then(
      (result) => {
        if (inflight.get(sessionId) !== controller || controller.signal.aborted) return;
        inflight.delete(sessionId);
        // The composer was submitted while this was in flight: the answer is
        // about a conversation the user already moved past.
        if ((dropEpoch.get(sessionId) ?? 0) !== epoch) return;
        if (result.text.length === 0) {
          drafts.delete(sessionId);
          // Keep the reason, not just "empty": a quota failure is something the
          // user can fix by switching model, and the UI says so.
          const reason = result.error ?? "empty prediction";
          diagnostics.lastError = reason;
          lastError.set(sessionId, reason);
          lastGlobalError = reason;
        } else {
          drafts.set(sessionId, { text: result.text, provider: result.provider, model: result.model, at: Date.now() });
          diagnostics.lastError = null;
          lastError.delete(sessionId);
          lastGlobalError = null;
        }
      },
      (error) => {
        if (inflight.get(sessionId) !== controller || controller.signal.aborted || (dropEpoch.get(sessionId) ?? 0) !== epoch) return;
        inflight.delete(sessionId);
        const message = String(error && error.message ? error.message : error);
        diagnostics.lastError = message;
        lastError.set(sessionId, message);
        lastGlobalError = message;
      },
    );
  }

  // Bind every agent that already exists, then every one created later.
  const agentDisposers = new Map();
  const offCreated = ctx.on("agent/created", (payload) => {
    const agent = payload?.agent;
    if (agent === undefined) return;
    diagnostics.created += 1;
    const dispose = bindAgent(agent);
    agentDisposers.set(agent, dispose);
  });
  const offDisposed = ctx.on("agent/disposed", (payload) => {
    const agent = payload?.agent;
    if (agent === undefined) return;
    const dispose = agentDisposers.get(agent);
    if (dispose !== undefined) {
      try {
        dispose();
      } catch {
        /* the agent context is already gone */
      }
      agentDisposers.delete(agent);
    }
  });

  // Agents that already existed when this plugin activated (the common case on
  // install into a live profile) never fire `agent/created`, so bind them now.
  for (const agent of ctx.agents.list()) {
    try {
      agentDisposers.set(agent, bindAgent(agent));
      diagnostics.created += 1;
    } catch (error) {
      diagnostics.lastError = `bind existing agent failed: ${String(error)}`;
    }
  }

  // ---- Durable fallback trigger -----------------------------------------
  //
  // Every scoped event above can fail to reach a plugin-owned listener; that is
  // exactly what happened in practice, leaving `turnEnd` at 0 while the agent
  // ran normally. The session log, however, is authoritative and readable
  // synchronously, so a light poll compares the live log with what has already
  // been predicted for and closes the loop regardless of dispatch behaviour.
  //
  // Cost is one numeric comparison every two seconds while a session is live,
  // and nothing at all once its turn is unchanged.
  const lastSeen = new Map();
  /** Last observed user-message sequence, independent of the sliding window. */
  const lastUserSeq = new Map();
  const poll = setInterval(() => {
    if (!live.enabled) return;
    let agents;
    try {
      agents = ctx.agents.list();
    } catch {
      return;
    }
    for (const agent of agents) {
      const sessionId = agent.session.id;
      const already = agentDisposers.has(agent);
      if (!already) {
        // Bind lazily: a session that appeared without `agent/created` reaching us.
        try {
          agentDisposers.set(agent, bindAgent(agent));
          diagnostics.created += 1;
        } catch {
          continue;
        }
      }
      let lastTurn = -1;
      let lastTurnReason = null;
      let lastUser = -1;
      try {
        const session = agent.session;
        // Walk the tail only: turn/end records are sparse and recent.
        const from = Math.max(0, session.seq - 400);
        for (let seq = from; seq < session.seq; seq += 1) {
          const event = session.eventAt(seq);
          if (event === undefined) continue;
          if (event.type === "turn/end") {
            lastTurn = event.data?.turn ?? lastTurn;
            lastTurnReason = event.data?.reason?.kind ?? null;
          } else if (event.type === "user/message") {
            lastUser = seq;
          }
        }
      } catch {
        continue;
      }

      // A new user message means the composer was submitted. Whatever was
      // pending belongs to the previous composer, so drop it and treat the turn
      // that just closed as already handled. This is the authoritative version
      // of the signal: it does not depend on the Client reporting its phase,
      // which may never change in some composer states.
      const previousUsers = lastUserSeq.get(sessionId);
      lastUserSeq.set(sessionId, lastUser);
      if (previousUsers !== undefined && lastUser > previousUsers) {
        // A prediction already based on this submission is fresh. Only cancel
        // work that started before the newly observed user message.
        if ((predictionUserSeq.get(sessionId) ?? -1) < lastUser) consumePending(sessionId);
      }

      const previous = lastSeen.get(sessionId);
      lastSeen.set(sessionId, lastTurn);
      // First observation only records the baseline; a prediction needs a turn
      // that completed while we were watching.
      if (previous === undefined) continue;
      if (lastTurn <= previous) continue;
      // A turn the user stopped, interrupted, or forked is not a conversation
      // waiting for its next line: they took over deliberately. Suggesting
      // anything there reads as nagging, so stay quiet.
      if (lastTurnReason === "aborted" || lastTurnReason === "interrupted" || lastTurnReason === "forked") continue;
      diagnostics.turnEnd += 1;
      diagnostics.lastAt = Date.now();
      runPrediction(agent, sessionId);
    }
  }, 2000);
  if (typeof poll.unref === "function") poll.unref();

  // ---- Client bridge ----------------------------------------------------
  //
  // The Client half is plain JavaScript in the browser and has no generated
  // Remote namespace, so it talks to this route over the same origin it was
  // served from.
  //
  // Registered routes bypass the host's /api adapter. Reuse its admission
  // decision, including signed session verification and Host/Origin checks.

  const offRoute = ctx.webServer.register({
    kind: "prefix",
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url ?? ROUTE, "http://localhost");
      const action = url.pathname.slice(ROUTE.length).replace(/^\//, "") || "get";
      const send = (status, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };

      const connection = ctx.get("connection");
      if (typeof connection?.requestRejection !== "function") {
        return send(503, { ok: false, error: "DSH connection authentication unavailable" });
      }
      let rejection;
      try {
        rejection = connection.requestRejection(req);
      } catch {
        return send(503, { ok: false, error: "DSH connection authentication unavailable" });
      }
      if (rejection !== undefined) return send(rejection === 403 ? 403 : 401, { ok: false, error: "unauthorized" });
      if (req.method !== "GET" && !req.headers.origin) return send(403, { ok: false, error: "origin required" });

      try {
        if (action === "get") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const entry = drafts.get(sessionId);
          const learned = feedback.get(sessionId);
          return send(200, {
            ok: true,
            config: { ...live },
            // `at` lets the Client tell a fresh prediction from one that was
            // already on screen when it sent its own message.
            suggestion: entry === undefined
              ? null
              : { text: entry.text, provider: entry.provider, model: entry.model, at: entry.at },
            // Newest first. The Client uses this to offer a recall affordance
            // after the composer has been cleared.
            history: (history.get(sessionId) ?? []).slice(0, MAX_HISTORY),
            // Why the last attempt produced nothing, when it did. A session asks
            // for its own reason; the settings page has no session and gets the
            // most recent one instead.
            error: sessionId.length > 0 ? lastError.get(sessionId) ?? null : lastGlobalError,
            learned: learned === undefined
              ? { accepted: 0, dismissed: 0 }
              : { accepted: learned.accepted.length, dismissed: learned.dismissed.length },
            diagnostics: { ...diagnostics, boundAgents: agentDisposers.size },
          });
        }
        if (action === "diagnose") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          // Runs one prediction immediately against a live agent, bypassing the
          // turn boundary, so a broken path is visible without waiting.
          //
          // This is a development aid: it spends a real model call and ships
          // the session transcript to the provider. It is gated so a page that
          // simply happens to be open cannot trigger it, and it never leaks the
          // list of other sessions.
          if (!live.diagnostics) {
            return send(403, { ok: false, error: "diagnostics disabled" });
          }
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const agent = ctx.agents.get(sessionId);
          if (agent === undefined) {
            return send(404, {
              ok: false,
              error: `no live agent for session ${sessionId}`,
              diagnostics: { ...diagnostics, boundAgents: agentDisposers.size },
            });
          }
          const controller = new AbortController();
          const started = Date.now();
          const result = await predict(ctx, agent, live, feedbackFor(sessionId), controller.signal);
          // Publish it like a real prediction so the same accept/dismiss/recall
          // paths can be exercised by hand.
          if (result.text.length > 0) {
            drafts.set(sessionId, { text: result.text, provider: result.provider, model: result.model, at: Date.now() });
          }
          // Report the intermediate values so an empty result is explainable
          // without another round of guesswork.
          let surfaceNodes = -1;
          let builtMessages = -1;
          let transcriptLen = -1;
          try {
            surfaceNodes = agent.session.surface.nodes.length;
            const built = buildContext(agent.session, live);
            builtMessages = built.length;
            transcriptLen =
              typeof built[0]?.content?.[0]?.text === "string" ? built[0].content[0].text.length : 0;
          } catch (error) {
            diagnostics.lastError = `probe failed: ${String(error)}`;
          }
          return send(200, {
            ok: true,
            elapsedMs: Date.now() - started,
            text: result.text,
            provider: result.provider,
            model: result.model,
            surfaceNodes,
            builtMessages,
            transcriptLen,
            debug: result.debug ?? null,
            diagnostics: { ...diagnostics, boundAgents: agentDisposers.size },
          });
        }
        if (action === "config") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (body.mode === "full" || body.mode === "recent") live.mode = body.mode;
          if (Number.isInteger(body.recentTurns)) live.recentTurns = Math.min(Math.max(body.recentTurns, 1), 40);
          if (typeof body.enabled === "boolean") live.enabled = body.enabled;
          if (typeof body.adaptive === "boolean") live.adaptive = body.adaptive;
          if (typeof body.workspace === "boolean") live.workspace = body.workspace;
          if (typeof body.permissions === "boolean") live.permissions = body.permissions;
          if (typeof body.diagnostics === "boolean") live.diagnostics = body.diagnostics;
          persist();
          return send(200, { ok: true, config: { ...live } });
        }
        if (action === "dismiss") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string") {
            const entry = drafts.get(body.sessionId);
            // A dismissal is a negative example only when a draft was actually
            // shown; closing the ghost before anything appeared teaches nothing.
            if (entry !== undefined && entry.text.length > 0 && live.adaptive) {
              const learned = feedbackFor(body.sessionId);
              learned.dismissed = [...learned.dismissed, entry.text].slice(-MAX_DISMISSED);
              learned.at = Date.now();
              persistFeedback();
            }
            // `fromHistory` means the user is rejecting the line that was being
            // shown as the auto-restore fallback. Writing it back into the ring
            // would resurrect it on the next poll, so a rejection from history
            // removes it instead of re-adding it.
            const shown = typeof body.text === "string" ? body.text : undefined;
            const target = shown ?? (entry === undefined ? undefined : entry.text);
            if (target !== undefined && target.length > 0) {
              if (body.fromHistory === true) {
                history.set(
                  body.sessionId,
                  (history.get(body.sessionId) ?? []).filter((item) => item !== target),
                );
              } else {
                // A freshly generated draft stays recallable: the user may want
                // it back after clearing the composer, and regenerating costs
                // another model call.
                history.set(body.sessionId, pushHistory(history.get(body.sessionId), target));
              }
            }
            drafts.delete(body.sessionId);
          }
          return send(200, { ok: true });
        }
        if (action === "drop") {
          // The user sent their own message instead of taking the suggestion.
          // The pending draft is now stale: remove it without recording feedback
          // and without making it recallable, because it was never acted on.
          // Any prediction still in flight belongs to the previous composer and
          // is invalidated too.
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string") consumePending(body.sessionId);
          return send(200, { ok: true });
        }
        if (action === "accepted") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId !== "string") return send(400, { ok: false, error: "sessionId required" });
          const entry = drafts.get(body.sessionId);
          if (entry !== undefined && entry.text.length > 0) {
            // Accepted drafts stay recallable too: Tab fills the composer, and a
            // user who then clears it would otherwise lose the text for good.
            history.set(body.sessionId, pushHistory(history.get(body.sessionId), entry.text));
            if (live.adaptive) {
              const learned = feedbackFor(body.sessionId);
              learned.accepted = [...learned.accepted, entry.text].slice(-MAX_ACCEPTED);
              learned.at = Date.now();
              persistFeedback();
            }
            // Clear the ghost either way; the text now lives in the composer.
            drafts.delete(body.sessionId);
          }
          return send(200, { ok: true });
        }
        if (action === "reset") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string" && body.sessionId.length > 0) feedback.delete(body.sessionId);
          else feedback.clear();
          persistFeedback();
          return send(200, { ok: true });
        }
        return send(404, { ok: false, error: `unknown action: ${action}` });
      } catch (error) {
        return send(500, { ok: false, error: String(error) });
      }
    },
  });

  // ---- Teardown ---------------------------------------------------------
  ctx.effect(() => () => {
    clearInterval(poll);
    lastSeen.clear();
    lastUserSeq.clear();
    dropEpoch.clear();
    predictionUserSeq.clear();
    predictionTurnKey.clear();
    offCreated();
    offDisposed();
    for (const dispose of agentDisposers.values()) {
      try {
        dispose();
      } catch {
        /* the agent context is already gone */
      }
    }
    agentDisposers.clear();
    offRoute();
    for (const controller of inflight.values()) {
      try {
        controller.abort();
      } catch {
        /* already settled */
      }
    }
    inflight.clear();
    drafts.clear();
    feedback.clear();
    history.clear();
    lastError.clear();
    lastGlobalError = null;
    // A disposer also runs on disable/reload; durable state must survive it.
  });
}

/** Read a small JSON body from an incoming request. */
async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export const inject = ["llm", "webServer", "agents"];

/**
 * Default row configuration.
 *
 * Deliberately a plain object rather than a schemastery schema. Declaring
 * `Config` would make `@deepseek-ai/schemastery` a hard import dependency, and
 * that package is not guaranteed to exist in a profile's `node_modules` (here it
 * only arrives as a transitive dependency of an unrelated third-party bundle).
 * A missing top-level import fails the whole plugin, so the validator is traded
 * for a zero-dependency package; `resolveConfig` already normalizes whatever the
 * patch supplies.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  adaptive: true,
  workspace: true,
  permissions: true,
  diagnostics: false,
  mode: "full",
  recentTurns: 6,
};

export default { apply, inject };
