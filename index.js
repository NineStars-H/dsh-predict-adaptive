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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Route prefix owned by this plugin; the Client half posts here. */
const ROUTE = "/prompt-predict-adaptive";
/** Directory name under the DSH home holding this plugin's single state file. */
const STATE_DIR = "prompt-predict-adaptive";
/**
 * How often the safety-net scan runs.
 *
 * The turn signals arrive by event, so this scan exists only to catch a session
 * that appeared without `agent/created` reaching the plugin and to notice a
 * `turn/end` the event path missed. Neither is time-critical, and the scan walks
 * the tail of every live session, so running it twice a second spends real work
 * on a path that is almost always a no-op. Five seconds still recovers long
 * before anyone would notice.
 */
const POLL_INTERVAL = 5000;

/**
 * This package's own version, read from its manifest.
 *
 * Reported by the `/diag` route so a running profile can be identified without
 * guessing which tag was installed. Read once at load; the file cannot change
 * while the process runs.
 */
const PLUGIN_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * The directive.
 *
 * Sent as the single user message, above the transcript. There is no reusable
 * prefix here to keep warm: every prediction is one self-contained message built
 * from scratch, so this text costs one prompt per call and nothing is cached
 * across calls. That is also why it is kept short.
 *
 * The model answers in JSON rather than plain text.
 *
 * Plain text forced this side to GUESS what it had received — the previous version
 * carried a battery of regexes trying to tell a user's line from an assistant's,
 * and every one of them could only reject a shape, never ask for a better one.
 * Codex's own implementation has the model declare the answer:
 * `{"suggestion": "..."}` or `{"suggestion": null}`. That removes the guessing,
 * makes "no suggestion" an explicit decision instead of a magic string, and lets
 * the instruction say what a good draft looks like instead of what to avoid.
 */
const INSTRUCTION = [
  "Predict the user's next message in this conversation.",
  "",
  "The transcript ends with an open USER turn, right after the assistant's reply. The user has read that reply and is typing now. Write what they are about to say.",
  "",
  "It is their own words: the thing they want done, in their register — the words they wrap around a command, the correction they fire back, or the part they typed before pasting the error.",
  "",
  "What reads as a prediction:",
  "- Their own message, at whatever length the thought needs. A terse line when that is what the moment calls for; two or three sentences when they are explaining a problem, describing what they saw, or pushing back on the reply.",
  "- Concrete: a file, a command, a check, a decision, or a specific correction to something the assistant just got wrong.",
  "- Same language they have been writing in.",
  "- They may be impatient, pleased, confused, or cutting the assistant off. Tone is part of the line.",
  "- Impatient still means a request. A line that scolds the assistant, or tells it off for asking, is not something anyone types to get work done — it just makes the next reply defensive.",
  "",
  /*
   * The part that matters most, and the easiest to get wrong.
   *
   * An agent often ends a turn by asking for something the user may not know how to
   * answer: a config choice, a tool, a term. The obvious failure is to write an
   * explanation of that question — it reads like help, but Tab sends it, and the
   * agent receives a paragraph of commentary instead of an instruction.
   *
   * So the rule is not "explain more". It is "answer for them, in their voice".
   *
   * The requirement this serves is "a correct and necessary instruction". Correct
   * and necessary are the standard; a draft that merely pushes the work back with
   * an edge to it fails both.
   */
  "When the reply asks the user to choose, configure, or approve something technical:",
  "- Write the instruction that gives the assistant what it needs, with the detail that makes it correct. The user does not have to understand the question for the message to be a good answer to it.",
  "- If the assistant can reasonably decide or check it itself, say so plainly — that is a complete instruction, and the most useful one when the user has no basis to choose.",
  "- When the choice genuinely needs the user — something irreversible, an external system, money, or a trade-off only they can weigh — name one option and say why, rather than listing the options back.",
  "- Never restate the question or explain the term. The draft is a message to the assistant, not a note to the user.",
  "- Do not invent settings, file names, versions or facts to fill a gap. Ask the assistant to check when you do not know.",
  "- Ordinary conversation stays ordinary: most turns are not a technical decision, and a chat reply should still read like one.",
  "",
  "Reply with JSON and nothing else:",
  '  {"suggestion": "<their next message>"}',
  "  {\"suggestion\": null}   when they have nothing left to say here",
  "",
  "Use null only when the conversation is genuinely closed — they are signing off, or nothing is outstanding. A thank-you or a short acknowledgement is not that: the user is usually still going.",
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
  /*
   * `adaptive` is OFF by default, and deliberately so.
   *
   * It appends the last couple of accepted and dismissed drafts to the prompt as a
   * style reference. Nothing has shown that this produces better predictions — no
   * controlled comparison has ever been run — and the mechanism has a known failure
   * mode: in a conversation whose follow-ups resemble each other, the examples read
   * as a template and the model returns the same sentence with different nouns.
   *
   * An unproven feature should not be on by default. The switch stays so the
   * comparison can be made once there is enough real data: the same conversation
   * with steering on and off, and a reason to believe it helps.
   */
  const adaptive = source.adaptive === true;
  // Both default on: they make a draft more actionable, and each can be turned
  // off from the plugin page when the extra prompt or the delay is unwanted.
  const workspace = source.workspace !== false;
  // Off by default: the diagnose endpoint spends a model call and forwards the
  // transcript, so it is opt-in for debugging only.
  const diagnostics = source.diagnostics === true;
  return { enabled: source.enabled !== false, mode, recentTurns, adaptive, workspace, diagnostics };
}

/**
 * How much of an accepted draft is quoted back as a style hint.
 *
 * Short on purpose: a full sentence is enough to carry register, and a long one
 * invites the model to reuse it as a template.
 */
const STEERING_EXAMPLE = 80;
/**
 * Longest draft accepted, in characters.
 *
 * Generous on purpose: a user can legitimately write a paragraph, and the old
 * 400-character line cap combined with taking only the first line was what made
 * every suggestion read as a clipped fragment. This only rejects an essay.
 */
const MAX_DRAFT_CHARS = 1200;
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
  /*
   * Accepted drafts teach TONE, not subject matter.
   *
   * They used to be presented as "match these in voice, length and specificity"
   * with up to several full examples. In a conversation where the user's
   * follow-ups resemble each other, that reads as a template and the model keeps
   * producing the same sentence with different nouns — the "it keeps making
   * things up" complaint. Two short exemplars carry voice; more only narrow it.
   *
   * Dismissed drafts remain useful as a warning about shape, so they keep
   * examples too, but only the most recent few.
   */
  const accepted = feedback.accepted.slice(-2);
  const dismissed = feedback.dismissed.slice(-2);
  const lines = [
    "",
    "Style reference only. These are things this user said in THIS conversation: copy the register, not the wording, and do not reuse their subject unless the transcript is still about it.",
  ];
  if (accepted.length > 0) {
    lines.push("ACCEPTED (on target):");
    for (const item of accepted) {
      // One line each: a long exemplar becomes a template to reuse.
      lines.push(`- ${item.slice(0, STEERING_EXAMPLE).replace(/\s+/g, " ").trim()}`);
    }
  }
  if (dismissed.length > 0) {
    lines.push("DISMISSED (avoid this shape):");
    for (const item of dismissed) {
      lines.push(`- ${item.slice(0, STEERING_EXAMPLE).replace(/\s+/g, " ").trim()}`);
    }
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
  /*
   * End on an open "USER:" turn.
   *
   * Without it the input reads as a finished document plus a task, and the model
   * answers in an analyst's voice — lists of what to do next, or a restatement of
   * the assistant's own last message. A dangling speaker label makes the job
   * "finish this line" rather than "describe this", which is the whole difference
   * between a prediction and a summary.
   */
  lines.push("USER:");
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
/**
 * Read the model's reply as `{"suggestion": string | null}`.
 *
 * The model is asked for JSON so this side never has to guess what it received.
 * The previous plain-text version carried a battery of regexes trying to tell a
 * user's line from an assistant's, and each could only reject a shape after the
 * fact — it could never ask the model to answer differently. Codex's own
 * implementation has the model declare the result, and so does this.
 *
 * `null` is the model saying "nothing to say here", which is a far better signal
 * than a magic string that has to be filtered out later.
 *
 * Tolerates the usual drift: a markdown fence around the JSON, a stray sentence
 * before it, or a bare string instead of the object.
 *
 * @param raw - accumulated assistant text.
 * @returns the draft, or an empty string when the model suggested nothing usable.
 */
function cleanPrediction(raw) {
  const text = (raw ?? "").trim();
  if (text.length === 0) return "";

  // The JSON object may be fenced or preceded by a sentence. Take the outermost
  // braces rather than assuming the whole reply is the document.
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  let parsed;
  if (open >= 0 && close > open) {
    try {
      parsed = JSON.parse(text.slice(open, close + 1));
    } catch {
      /* fall through to the plain-text path below */
    }
  }

  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const value = parsed.suggestion;
    // The explicit "nothing to say" answer.
    if (value === null) return "";
    if (typeof value === "string") return normalizeDraft(value);
    return "";
  }

  /*
   * No JSON. A provider that ignored the format still said something, and
   * discarding a usable line would be worse than accepting it — the whole reason
   * this function exists is to avoid throwing away good drafts. Treat the reply as
   * the draft, including the bare `null` an unformatted model may emit.
   */
  return normalizeDraft(text);
}

/**
 * Turn one candidate string into a draft the composer can hold.
 *
 * Only the unambiguous cases are rejected. A separator-density rule was tried for
 * to-do lists and dropped: measured against this user's real accepted drafts it
 * separated them from a known-bad example by under one separator per character, so
 * it would have thrown away good predictions to catch a bad one. A wrong draft
 * costs one Escape; a filter that eats good drafts costs the feature.
 *
 * @param value - the suggested text.
 * @returns a single-line draft, or "" when it is unusable.
 */
function normalizeDraft(value) {
  let reply = String(value).trim();
  if (reply.length === 0) return "";
  if (/^(?:null|none|no_prediction)[.。]?$/i.test(reply)) return "";

  // Strip surrounding quotes and a leading bullet or heading marker.
  reply = reply.replace(/^\s*(?:[-*•]|#+)\s+/, "").trim();
  reply = reply.replace(/^["'`“”「」]+/, "").replace(/["'`“”「」]+$/, "").trim();
  if (reply.length === 0) return "";

  // A cap, not a style rule: it only rejects a model that ignored the instruction
  // and wrote an essay. A paragraph is a legitimate user message.
  if (reply.length > MAX_DRAFT_CHARS) return "";

  // Wrapping is collapsed rather than preserved: the composer shows two lines and
  // a hard newline would be inserted verbatim by Tab.
  return reply.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
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
  /*
   * No permission block.
   *
   * There used to be one, describing the session's sandbox and approval posture.
   * It could not do anything: a prediction never runs a tool, so the posture never
   * limits what the model can produce — it only told the model that certain
   * actions were unavailable, which pushed drafts toward hedging ("看看能不能改")
   * instead of the thing the user actually wants to say.
   *
   * Read-only is a property of the call itself, not a policy to declare: the
   * request carries `tools: []` and its reply is only ever shown as text.
   */
  const request = {
    provider: routed.provider,
    model: routed.model,
    messages: [
      { role: "user", content: [{ type: "text", text: `${instruction}${workspace}\n${transcript}` }] },
    ],
    // Declared empty rather than omitted, which is what Codex's own implementation
    // sends. Omission leaves the adapter free to fall back to the session's tool
    // surface; an explicit empty list says there is nothing to call, and the
    // `<｜｜DSML｜｜ calls>` style answer disappears with it.
    tools: [],
    sessionId: agent.session.id,
    ...signal === undefined ? {} : { signal },
  };

  let raw = "";
  const chunks = [];
  let finishKind = null;
  /*
   * Token accounting for this call.
   *
   * The provider reports `{ type: "usage", usage }` just before `finish`, with
   * inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens already summed
   * into totalTokens. Predictions are paid for on every turn, so the settings page
   * shows the running cost rather than leaving it invisible.
   *
   * Absent for some providers, so every field is optional: a missing report must
   * not read as "this call was free".
   */
  let usage = null;
  for await (const chunk of ctx.llm.stream(request)) {
    if (chunks.length < 12) chunks.push(chunk.type);
    if (chunk.type === "text-delta") raw += chunk.text;
    else if (chunk.type === "usage" && chunk.usage !== null && typeof chunk.usage === "object") {
      const u = chunk.usage;
      usage = {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        cacheWriteTokens: Number(u.cacheWriteTokens) || 0,
      };
    } else if (chunk.type === "finish") {
      finishKind = chunk.reason.kind;
      if (chunk.reason.kind === "error") {
        // Surface the provider's own words. A silent empty result is
        // indistinguishable from a broken plugin, and the common case here is a
        // quota/rate limit the user can act on by switching model.
        const failure = chunk.reason.failure;
        return {
          text: "",
          usage,
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
  return { text: cleanPrediction(raw), provider: routed.provider, model: routed.model, usage, debug: { chunks, finishKind, rawLen: raw.length } };
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
   * Every suggestion, with the conversation state that produced it.
   *
   * `feedback.json` only keeps the drafts the user acted on, which is enough to
   * steer the next prediction but not enough to work out WHY a draft was wrong:
   * the text alone does not say what the assistant had just written, what the user
   * asked before it, or whether the draft was ever shown. This log exists for
   * that — it records the round's boundary and the tail of the transcript beside
   * each draft, so a bad prediction can be explained instead of guessed at.
   *
   * Bounded on purpose: the newest HISTORY_LIMIT entries survive, because an
   * unbounded log of conversation text is exactly the kind of quiet growth this
   * plugin should not leave behind.
   */
  const historyFile = join(stateDir, "suggestions.json");
  const HISTORY_LIMIT = 120;
  /** How much of the transcript is kept beside each draft. */
  const HISTORY_CONTEXT_CHARS = 1200;

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

  /** The suggestion log, newest last. Loaded once, written back on each entry. */
  let suggestionLog = [];
  try {
    const parsed = JSON.parse(readFileSync(historyFile, "utf8"));
    if (Array.isArray(parsed)) suggestionLog = parsed.filter((item) => item && typeof item === "object");
  } catch {
    /* first run, or removed with a previous uninstall */
  }

  /**
   * Append one suggestion with the state that produced it.
   *
   * Written on every prediction, shown or not, because the interesting case is
   * often the one the user never saw. `outcome` is filled in later by
   * `stampOutcome`, so a single record answers "what was suggested, in what
   * context, and did it land".
   *
   * @param sessionId - owning session.
   * @param draft - the text the model produced, empty when it produced nothing.
   * @param meta - round boundary, transcript tail, failure reason, usage.
   */
  function logSuggestion(sessionId, draft, meta) {
    const entry = {
      at: Date.now(),
      session: String(sessionId),
      text: typeof draft === "string" ? draft : "",
      outcome: "pending",
      ...meta,
    };
    suggestionLog.push(entry);
    if (suggestionLog.length > HISTORY_LIMIT) {
      suggestionLog.splice(0, suggestionLog.length - HISTORY_LIMIT);
    }
    persistSuggestionLog();
    return entry;
  }

  /**
   * Record what became of a suggestion.
   *
   * The newest matching entry is stamped rather than a new one appended, so the
   * log stays one line per prediction: what was offered, and what the user did.
   */
  function stampOutcome(sessionId, text, outcome) {
    for (let i = suggestionLog.length - 1; i >= 0; i -= 1) {
      const entry = suggestionLog[i];
      if (entry.session !== String(sessionId)) continue;
      if (entry.outcome !== "pending") continue;
      if (text !== undefined && entry.text !== text) continue;
      entry.outcome = outcome;
      entry.resolvedAt = Date.now();
      persistSuggestionLog();
      return;
    }
  }

  /** Write the suggestion log back. Best effort, like every other state file. */
  function persistSuggestionLog() {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(historyFile, JSON.stringify(suggestionLog, null, 2), "utf8");
    } catch {
      /* the log is a diagnostic aid, not part of the feature working */
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

  /** Read an agent's session id without letting a disposed agent throw. */
  function sessionIdOf(agent) {
    try {
      const id = agent?.session?.id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Per-session trigger debounce state.
   *
   * Keyed by session id rather than by agent, because the dispatchers deliver the
   * agent in the payload and one session has exactly one live agent.
   */
  const triggerStates = new Map();
  function triggerState(sessionId, agent) {
    let state = triggerStates.get(sessionId);
    if (state === undefined) {
      state = { pending: null, turn: 0, agent };
      triggerStates.set(sessionId, state);
    }
    state.agent = agent;
    return state;
  }

  /** Remember a live agent so a trigger can predict for it later. */
  function ensureBound(agent) {
    try {
      if (!agentDisposers.has(agent)) agentDisposers.set(agent, bindAgent(agent));
    } catch {
      /* the agent is going away; the log poll will bind it if it survives */
    }
  }

  /**
   * Collapse the trigger burst for one session into a single prediction.
   *
   * A turn emits `agent/turn-stopping`, then `turn/end`, then `agent/status:
   * idle`. All three describe the same turn, so they are debounced together and
   * the highest turn number seen wins. The delay is short on purpose: it only
   * collapses a burst, and every millisecond here is latency the user sees
   * before the ghost appears.
   */
  function scheduleFor(sessionId, reason, turn) {
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) return;
    const state = triggerState(sessionId, agent);
    if (Number.isInteger(turn)) state.turn = Math.max(state.turn, turn);
    if (state.pending !== null) clearTimeout(state.pending);
    state.pending = setTimeout(() => {
      state.pending = null;
      const settled = state.turn;
      state.turn = 0;
      diagnostics.stopping += 1;
      diagnostics.lastAt = Date.now();
      runPrediction(agent, sessionId, settled);
    }, 150);
    if (reason === "turn-end") diagnostics.turnEnd += 1;
  }

  /**
   * Register the three turn signals once for the whole plugin.
   *
   * They are registered on the PLUGIN's own context, not on `agent.ctx`.
   *
   * `agent/status`, `agent/turn-stopping` and `session/event` are dispatched
   * through `@deepseek-ai/dsh-scope`, whose filter is:
   *
   *     scopeIdentityOf(listenerCtx) === undefined || === the emitting identity
   *
   * A listener registered on `agent.ctx` carries that agent's tag, so it only
   * matches its own agent — which sounds right but in practice meant none of
   * these ever fired, leaving the 2 s log poll as the real trigger and adding up
   * to two seconds of latency to every suggestion. A listener on an untagged
   * root context receives them all, so the payload's own `agent` (fused in by
   * the dispatcher) identifies the session instead.
   */
  function bindTriggers() {
    // 1) The loop's own stopping boundary. Fires before the turn closes, and its
    //    payload carries the turn number, so it identifies the turn exactly.
    const disposeStopping = ctx.on("agent/turn-stopping", (payload) => {
      const agent = payload?.agent;
      if (agent === undefined) return;
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined) return;
      ensureBound(agent);
      scheduleFor(sessionId, "stopping", payload?.turn);
    });

    // 2) Agent went idle: covers paths that end without a normal turn close.
    const disposeStatus = ctx.on("agent/status", (payload) => {
      if (payload?.status !== "idle") return;
      const agent = payload?.agent;
      if (agent === undefined) return;
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined) return;
      ensureBound(agent);
      diagnostics.idle += 1;
      scheduleFor(sessionId, "idle");
    });

    // 3) Durable turn boundary: the appended `turn/end` record.
    const disposeEvent = ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      // Only a settled turn is worth predicting against; a forked or
      // interrupted turn leaves the conversation mid-thought.
      if (reason?.kind === "forked" || reason?.kind === "aborted" || reason?.kind === "interrupted") return;
      const sessionId = typeof session?.id === "string" ? session.id : undefined;
      if (sessionId === undefined) return;
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) return;
      scheduleFor(sessionId, "turn-end", event.data?.turn);
    });

    return () => {
      disposeEvent();
      disposeStatus();
      disposeStopping();
    };
  }

  /**
   * Track one agent so a trigger or the poll can predict for it.
   *
   * This no longer registers listeners: the turn signals are global now (see
   * `bindTriggers`). What is per-agent is only the bookkeeping, plus cancelling
   * anything still in flight when the agent goes away.
   *
   * @returns a disposer that forgets the agent and aborts its in-flight work.
   */
  function bindAgent(agent) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return () => {};
    triggerState(sessionId, agent);
    return () => {
      const state = triggerStates.get(sessionId);
      if (state !== undefined && state.pending !== null) {
        clearTimeout(state.pending);
        state.pending = null;
      }
      triggerStates.delete(sessionId);
    };
  }

  /**
   * Bumped whenever the composer is submitted, dismissed, or cleared.
   *
   * A prediction started before that describes a conversation state the user has
   * already left; letting it land would drop a stale line into the fresh
   * composer. Each attempt records the epoch it began under and discards its own
   * result if the epoch moved on.
   */
  const dropEpoch = new Map();
  // The polling fallback can observe a submission after a fast prediction for
  // that same completed turn has already started or finished.
  const predictionUserSeq = new Map();
  const predictionTurnKey = new Map();
  /**
   * Texts this session has rejected, and when it last submitted.
   *
   * Both live here rather than in the Client because the Client unmounts when the
   * page switches conversation: a rejection stored there would be forgotten and
   * the line would come back on the next visit, and a submission instant stored
   * there would be lost the same way. Keeping them on the Host makes
   * "this line is rejected" a property of the session, not of one mounted view.
   */
  const rejected = new Map();
  const consumedAt = new Map();

  /**
   * Remember a rejected text for this session, bounded so it cannot grow.
   */
  function reject(sessionId, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const list = rejected.get(sessionId) ?? [];
    if (list.includes(text)) return;
    rejected.set(sessionId, [...list, text].slice(-MAX_HISTORY * 4));
  }

  /**
   * A small ring of recent bridge requests, plus per-action counters.
   *
   * Kept in memory only. It answers "did my mutation actually reach the Host, and
   * what did it answer" — the question that took a DevTools session to settle the
   * last time a POST was silently refused.
   */
  const requestLog = [];
  const requestCounts = { get: 0, diag: 0, resetusage: 0, accepted: 0, dismiss: 0, drop: 0, config: 0, reset: 0, other: 0 };
  /**
   * Token accounting, so the cost of predicting is visible instead of implied.
   *
   * Predictions are billed on every turn and the user never sees a number for
   * them, which is exactly the kind of spend that should be shown rather than
   * discovered on a bill.
   *
   * `recent` keeps the last RECENT_LIMIT calls for the "recent turns" figure; the
   * totals cover the process lifetime so a long session's cost is answerable.
   * A call whose provider reported nothing is counted in `unmetered` rather than
   * as a free one.
   */
  const RECENT_LIMIT = 20;
  const usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unmetered: 0 };
  const usageRecent = [];

  /** Fold one call's provider-reported usage into the running figures. */
  function recordUsage(usage) {
    usageTotals.calls += 1;
    if (usage === null || usage === undefined) {
      usageTotals.unmetered += 1;
      return;
    }
    usageTotals.inputTokens += usage.inputTokens;
    usageTotals.outputTokens += usage.outputTokens;
    usageTotals.cacheReadTokens += usage.cacheReadTokens;
    usageTotals.cacheWriteTokens += usage.cacheWriteTokens;
    usageRecent.push({
      at: Date.now(),
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    });
    if (usageRecent.length > RECENT_LIMIT) usageRecent.splice(0, usageRecent.length - RECENT_LIMIT);
  }

  /**
   * The figures the settings page shows.
   *
   * `recent` is the trailing window the user asked for; `totals` is the lifetime
   * of this process. Both are reported because a single number cannot answer both
   * "what does one turn cost" and "what has this cost me so far".
   */
  function usageReport() {
    const sum = (key, list) => list.reduce((total, item) => total + item[key], 0);
    /*
     * Fresh and cached tokens are reported apart rather than folded together.
     *
     * A cache read is billed at a discount, so adding it into the fresh count
     * makes a warm call look more expensive than it is and a cold one look
     * cheaper. `recentTotal` is therefore the plain attention count — tokens the
     * model actually read and wrote — with cache shown on its own line.
     */
    return {
      recentCalls: usageRecent.length,
      recentInput: sum("input", usageRecent),
      recentOutput: sum("output", usageRecent),
      recentCacheRead: sum("cacheRead", usageRecent),
      recentCacheWrite: sum("cacheWrite", usageRecent),
      recentTotal: sum("input", usageRecent) + sum("output", usageRecent),
      calls: usageTotals.calls,
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      cacheReadTokens: usageTotals.cacheReadTokens,
      cacheWriteTokens: usageTotals.cacheWriteTokens,
      unmeteredCalls: usageTotals.unmetered,
    };
  }

  function recordRequest(outcome, action, method, status) {
    const bucket = Object.hasOwn(requestCounts, action) ? action : "other";
    requestCounts[bucket] += 1;
    requestLog.push({
      at: Date.now(),
      outcome,
      action,
      method,
      status,
    });
    if (requestLog.length > 200) requestLog.splice(0, requestLog.length - 200);
  }

  /**
   * The newest submission sequence, and which turn the log tail describes.
   *
   * `turn` is the turn NUMBER, never a sequence number. A sequence number of
   * `turn/end` changes the instant that event is appended, so the event trigger
   * and the polling fallback disagreed about which turn they were looking at and
   * billed the same one twice. The number is final for the whole turn.
   *
   * While a turn is running its `turn/end` does not exist yet, so the closed turn
   * plus one is the open one. That is how a trigger without a turn in its own
   * payload (notably `agent/status`) still names the same turn the poll will.
   */
  function logBoundary(session) {
    let lastUser = -1;
    let closed = 0;
    let closedSeq = -1;
    let started = 0;
    for (let seq = Math.max(0, session.seq - 400); seq < session.seq; seq += 1) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      if (event.type === "user/message") {
        lastUser = seq;
        continue;
      }
      if (event.type !== "turn/start" && event.type !== "turn/end") continue;
      const seen = event.data?.turn;
      if (!Number.isInteger(seen)) continue;
      if (seen > started) started = seen;
      if (event.type === "turn/end" && seen >= closed) {
        closed = seen;
        closedSeq = seq;
      }
    }
    // A submission newer than the last closed turn means that turn is running.
    const running = lastUser > closedSeq;
    const turn = running ? Math.max(started, closed + 1) : Math.max(started, closed);
    return { lastUser, turn };
  }

  /**
   * Forget everything pending for a session and cancel work still in flight.
   *
   * This is the ONE "invalidate" primitive: a dismissal, a submission and a
   * composer clear all mean the same thing — whatever the Host is about to
   * produce belongs to a conversation state the user has already left. Bumping
   * the epoch makes any in-flight result discard itself even if the adapter
   * ignores the abort signal, which is why a dismissed line can never come back
   * a few seconds later.
   */
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

  /**
   * A short tail of the conversation a suggestion was generated from.
   *
   * The draft alone cannot explain a bad prediction: without knowing what the
   * assistant had just written, "refresh and check the two points" and a genuine
   * user follow-up look identical. Keeping the tail makes a wrong draft
   * diagnosable instead of mysterious.
   *
   * Deliberately short. This is stored beside every prediction in a bounded log,
   * so a generous excerpt would multiply into megabytes over a long conversation.
   *
   * @returns the trailing characters of the rendered transcript, or "".
   */
  function transcriptTailOf(session) {
    try {
      const nodes = session.surface.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) return "";
      const parts = [];
      for (let i = nodes.length - 1; i >= 0 && parts.join("\n").length < HISTORY_CONTEXT_CHARS; i -= 1) {
        const message = session.deriveEventMessage(session.eventAt(nodes[i]));
        if (message === undefined || message === null) continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = textOf(message.content);
        if (text.length === 0) continue;
        parts.unshift(`${message.role === "user" ? "USER" : "ASSISTANT"}: ${text}`);
      }
      const joined = parts.join("\n\n");
      return joined.length > HISTORY_CONTEXT_CHARS ? joined.slice(-HISTORY_CONTEXT_CHARS) : joined;
    } catch {
      return "";
    }
  }

  /** Ask for a prediction for one agent, superseding any in-flight one. */
  function runPrediction(agent, sessionId, turnHint) {
    if (!live.enabled) return;
    // Resolve the turn that is about to be predicted for. Triggers that know it
    // pass it; the rest recover it from the log. `turn/start` is appended before
    // the turn runs, so a completed turn is always readable here even after its
    // `user/message` has slid out of the 400-event window.
    let turn = Number.isInteger(turnHint) ? turnHint : 0;
    try {
      const boundary = logBoundary(agent.session);
      if (boundary.turn > turn) turn = boundary.turn;
      predictionUserSeq.set(sessionId, boundary.lastUser);
    } catch {
      predictionUserSeq.delete(sessionId);
    }
    // One prediction per turn, whichever trigger speaks first. This is the only
    // thing that stops the event trigger and the polling fallback from charging
    // the same turn twice; returning here spends nothing.
    if (turn > 0) {
      if (predictionTurnKey.get(sessionId) === turn) return;
      predictionTurnKey.set(sessionId, turn);
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
          // Logged too: a round that produced nothing is the most useful record
          // there is when someone asks why no suggestion appeared.
          logSuggestion(sessionId, "", {
            turn,
            reason,
            transcriptTail: transcriptTailOf(agent.session),
            provider: result.provider ?? null,
            model: result.model ?? null,
          });
        } else {
          drafts.set(sessionId, { text: result.text, provider: result.provider, model: result.model, at: Date.now() });
          recordUsage(result.usage);
          diagnostics.lastError = null;
          lastError.delete(sessionId);
          lastGlobalError = null;
          logSuggestion(sessionId, result.text, {
            turn,
            transcriptTail: transcriptTailOf(agent.session),
            provider: result.provider ?? null,
            model: result.model ?? null,
            usage: result.usage ?? null,
          });
        }
      },
      (error) => {
        if (inflight.get(sessionId) !== controller || controller.signal.aborted || (dropEpoch.get(sessionId) ?? 0) !== epoch) return;
        inflight.delete(sessionId);
        const message = String(error && error.message ? error.message : error);
        diagnostics.lastError = message;
        lastError.set(sessionId, message);
        lastGlobalError = message;
        logSuggestion(sessionId, "", { turn, reason: message, transcriptTail: transcriptTailOf(agent.session) });
      },
    );
  }

  // Bind every agent that already exists, then every one created later.
  const agentDisposers = new Map();
  // The turn signals are global (see `bindTriggers`), so they are registered
  // once here rather than per agent.
  const disposeTriggers = bindTriggers();
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
      let lastTurnSeq = -1;
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
            lastTurnSeq = seq;
          } else if (event.type === "user/message") {
            lastUser = seq;
          }
        }
      } catch {
        continue;
      }

      // A new user message means the composer was submitted. Whatever was
      // pending belongs to the previous composer, so drop it. This is the
      // authoritative version of the signal: it does not depend on the Client
      // reporting its phase, which may never change in some composer states.
      const previousUsers = lastUserSeq.get(sessionId);
      lastUserSeq.set(sessionId, lastUser);
      const submitted = previousUsers !== undefined && lastUser > previousUsers;
      if (submitted) {
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
      // The user sent their own message AFTER this turn closed instead of
      // taking the suggestion: they have moved past it, so predicting its
      // successor would paint a stale ghost over the freshly emptied composer
      // and bill another model call for it. That ordering is exactly what makes
      // the ghost seem to "come back" right after a send.
      //
      // A submission that arrived BEFORE the turn closed is the opposite case —
      // it is the turn that just finished being answered — and must still be
      // predicted for.
      if (submitted && lastUser > lastTurnSeq) continue;
      // A turn the user stopped, interrupted, or forked is not a conversation
      // waiting for its next line: they took over deliberately. Suggesting
      // anything there reads as nagging, so stay quiet.
      if (lastTurnReason === "aborted" || lastTurnReason === "interrupted" || lastTurnReason === "forked") continue;
      diagnostics.turnEnd += 1;
      diagnostics.lastAt = Date.now();
      runPrediction(agent, sessionId, lastTurn);
    }
  }, POLL_INTERVAL);
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
      if (rejection !== undefined) {
        recordRequest("rejected", action, req.method, rejection);
        return send(rejection === 403 ? 403 : 401, { ok: false, error: "unauthorized" });
      }

      // No separate `Origin` requirement here.
      //
      // The page is served from the desktop app's `dsh-app://app` scheme, and its
      // proxy strips `Origin` before forwarding to this route — so demanding the
      // header rejected EVERY mutation with 403, which is why dismiss, accept and
      // send silently never reached the Host. Cross-site forgery is already
      // covered: the session cookie is `SameSite=Strict`, so another origin's
      // request carries no credential and `requestRejection` answers 401 above.

      try {
        if (action === "get") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          // `get` is polled continuously, so it is counted but not logged: it
          // would drown the mutations that actually explain a bug.
          requestCounts.get += 1;
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
            // Texts this session rejected. The Client cannot keep this itself: it
            // unmounts whenever the page switches conversation, so a rejection
            // stored there would be forgotten and the line would return on the
            // next visit. This is the durable answer to "is this line rejected".
            dismissed: [...(rejected.get(sessionId) ?? [])],
            // Instant of the last submission. Anything produced at or before it
            // belongs to the composer the user already left.
            consumedAt: consumedAt.get(sessionId) ?? 0,
            // Why the last attempt produced nothing, when it did. A session asks
            // for its own reason; the settings page has no session and gets the
            // most recent one instead.
            error: sessionId.length > 0 ? lastError.get(sessionId) ?? null : lastGlobalError,
            learned: learned === undefined
              ? { accepted: 0, dismissed: 0 }
              : { accepted: learned.accepted.length, dismissed: learned.dismissed.length },
            // What predicting has cost so far, so the spend is visible rather than
            // only implied by a number on a bill.
            usage: usageReport(),
            diagnostics: { ...diagnostics, boundAgents: agentDisposers.size },
          });
        }
        if (action === "resetusage") {
          // Zero the counters. A user comparing "before" and "after" a setting
          // change needs a way to start counting from now; without it the lifetime
          // figures only ever grow and stop answering the question.
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          usageTotals.calls = 0;
          usageTotals.inputTokens = 0;
          usageTotals.outputTokens = 0;
          usageTotals.cacheReadTokens = 0;
          usageTotals.cacheWriteTokens = 0;
          usageTotals.unmetered = 0;
          usageRecent.length = 0;
          recordRequest('ok', action, req.method, 200);
          return send(200, { ok: true, usage: usageReport() });
        }
        if (action === "history") {
          /*
           * The suggestion log: what was offered, in what context, and what became
           * of it.
           *
           * `limit` caps the page; `session` narrows to one conversation. The full
           * transcript tail is only returned for the entries actually asked for, so
           * opening the settings page does not pull a megabyte of conversation
           * text over the bridge.
           */
          const limitRaw = Number(url.searchParams.get("limit"));
          const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, HISTORY_LIMIT) : 30;
          const sessionFilter = url.searchParams.get("session");
          const matching = sessionFilter === null || sessionFilter.length === 0
            ? suggestionLog
            : suggestionLog.filter((entry) => entry.session === sessionFilter);
          const page = matching.slice(-limit).reverse();
          return send(200, {
            ok: true,
            total: matching.length,
            limit,
            entries: page.map((entry) => ({
              at: entry.at,
              session: entry.session,
              text: entry.text,
              outcome: entry.outcome,
              turn: entry.turn ?? null,
              reason: entry.reason ?? null,
              provider: entry.provider ?? null,
              model: entry.model ?? null,
              usage: entry.usage ?? null,
              transcriptTail: entry.transcriptTail ?? "",
            })),
          });
        }
        if (action === "diag") {
          // A plain GET so it works from any browser tab, a form, or `curl`.
          //
          // This exists because a whole class of bugs here is invisible from the
          // outside: the Client sends a mutation, the Host refuses or never
          // receives it, and the only symptom is "the ghost came back". Recording
          // the last few requests makes that visible without DevTools.
          return send(200, {
            ok: true,
            version: PLUGIN_VERSION,
            requests: requestLog.slice(-40),
            counts: requestCounts,
            sessions: {
              drafts: [...drafts.keys()],
              rejected: [...rejected.entries()].map(([id, list]) => [id, list.length]),
              consumedAt: [...consumedAt.entries()],
              history: [...history.entries()].map(([id, list]) => [id, list.length]),
            },
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
          if (typeof body.diagnostics === "boolean") live.diagnostics = body.diagnostics;
          persist();
          return send(200, { ok: true, config: { ...live } });
        }
        if (action === "dismiss") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string") {
            const entry = drafts.get(body.sessionId);
            // Record the rejection durably, whether or not the draft is still in
            // the map: the Client reports the exact text it was showing.
            reject(body.sessionId, typeof body.text === "string" ? body.text : entry?.text);
            // A dismissal is a negative example only when a draft was actually
            // shown; closing the ghost before anything appeared teaches nothing.
            if (entry !== undefined && entry.text.length > 0 && live.adaptive) {
              const learned = feedbackFor(body.sessionId);
              learned.dismissed = [...learned.dismissed, entry.text].slice(-MAX_DISMISSED);
              learned.at = Date.now();
              persistFeedback();
            }
            // A dismissal is final AND cancels work still in flight. Without the
            // cancellation a prediction that was already running when Esc was
            // pressed would land a moment later and paint the rejected line back
            // — the "I deleted it and it came back" behaviour.
            consumePending(body.sessionId);
            stampOutcome(body.sessionId, typeof body.text === "string" ? body.text : entry?.text, "dismissed");
          }
          recordRequest('ok', action, req.method, 200);
          return send(200, { ok: true });
        }
        if (action === "drop") {
          // The composer went empty. Decide which of the two cases it was.
          //
          // The Client cannot tell: `InputState.phase` is `plain` for an ordinary
          // send too, and the composer clears before this process has appended the
          // `user/message` that proves a send. So the log is the only authority,
          // and it is read HERE, on the Host, where the append has already
          // happened by the time the request arrives in practice.
          //
          //   a `user/message` appeared since the last prediction
          //     -> a send: forget the draft and the ring, nothing should return.
          //   nothing new in the log
          //     -> a manual clear (Tab-then-clear, or typing then deleting):
          //        forget only the pending draft, keep the ring so the ghost
          //        comes straight back.
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string") {
            const sessionId = body.sessionId;
            let submitted = false;
            const agent = ctx.agents.get(sessionId);
            if (agent !== undefined) {
              try {
                const boundary = logBoundary(agent.session);
                submitted = boundary.lastUser > (predictionUserSeq.get(sessionId) ?? -1);
              } catch {
                /* no readable log: treat it as a manual clear, the safer default */
              }
            }
            // A Client that knows better may say so, but only to override the
            // default when the log could not be read at all.
            if (typeof body.submitted === "boolean" && agent === undefined) submitted = body.submitted;

            if (submitted) {
              consumedAt.set(sessionId, Date.now());
              rejected.set(sessionId, []);
              drafts.delete(sessionId);
              history.delete(sessionId);
              // The user sent their own message instead of taking the draft.
              stampOutcome(sessionId, undefined, "superseded");
            } else {
              // Manual clear: the line was never acted on, so it stays available.
              // Move the pending draft into the ring so `history[0]` can answer
              // immediately, then drop the draft itself; the Client paints
              // `suggestion ?? history[0]`, so the ghost returns on the next read
              // without waiting for a new prediction.
              const pending = drafts.get(sessionId);
              if (pending !== undefined && pending.text.length > 0) {
                history.set(sessionId, pushHistory(history.get(sessionId), pending.text));
                drafts.delete(sessionId);
              }
              // Invalidate anything still in flight for the composer just left.
              dropEpoch.set(sessionId, (dropEpoch.get(sessionId) ?? 0) + 1);
            }
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
          recordRequest('ok', action, req.method, 200);
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
            stampOutcome(body.sessionId, entry.text, "accepted");
          }
          recordRequest('ok', action, req.method, 200);
          return send(200, { ok: true });
        }
        if (action === "reset") {
          if (req.method !== "POST") return send(405, { ok: false, error: "POST required" });
          const body = await readJson(req);
          if (typeof body.sessionId === "string" && body.sessionId.length > 0) feedback.delete(body.sessionId);
          else feedback.clear();
          persistFeedback();
          recordRequest('ok', action, req.method, 200);
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
    rejected.clear();
    consumedAt.clear();
    triggerStates.clear();
    disposeTriggers();
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
  adaptive: false,
  workspace: true,
  diagnostics: false,
  mode: "full",
  recentTurns: 6,
};

export default { apply, inject };










