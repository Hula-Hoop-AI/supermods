// Agent Debugger: a step debugger for the agent loop.
//
// Pause points (each one a breakpoint kind, and every one of them in step mode):
//   prompt    prompt.submit   before the prompt enters; the text is editable
//   request   turn.step       before a model request; model and effort are editable
//   response  turn.step       the response, buffered, before it is shown or recorded; text is editable
//   tool      tool.call       before a tool runs; arguments are editable, or the call is skipped
//   result    tool.call       after a tool ran; the text the model will read is editable
//   turn-end  turn.complete   before the turn is reported done
//
// Holding: a hook has 10 s of its own time, but time inside a `$` call is free,
// so a hold waits on short `$.process.run(["sleep", ...])` calls until a button
// sets its decision (the pattern of the blast-radius sample).
//
// The pane is one list of events, newest first. An event opens in place to its
// fields (inputs while it is held) and to the conversation the model had before it.
//
// "Re-run from here" resets the conversation to the point before an event: the
// mod runs /compact through $.command.run (a compaction it raises with
// $.session.compact() would skip its own hook and summarize for real), its
// session.compact hook answers the kept messages in place of a summary, and a
// prompt (the person's message, or a plain "continue") carries the run on.
//
// $.session.messages() is the whole transcript, resets and compactions included;
// the model reads only what follows the last one, from `liveStart`.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

const PANE = "agent-debugger";
const POLL_SECONDS = "0.2";
const HOLD_LIMIT_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const LIST_STEP = 40;
const CONTEXT_MAX = 300;
const LINE_CHARS = 400;
const LONG_VALUE = 60;
const MAX_LINES = 40;
const IDLE_POLLS = 75;
const CONTINUE = "Continue from here.";
const VALUE_CHARS = 3000;

const KINDS = ["prompt", "request", "response", "tool", "result", "turn-end"];
const KIND_LABEL = {
  prompt: "prompt",
  request: "model request",
  response: "model response",
  tool: "tool call",
  result: "tool result",
  "turn-end": "turn end",
  info: "info",
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TABS = ["events", "breakpoints"];

// "play" runs to the next breakpoint; "step" pauses at every pause point.
let mode = "play";
let breaks = new Set();
// Tool breakpoints: the listed tools less `toolsOff`; `otherTools` speaks for the unlisted (MCP) ones.
let toolNames = [];
let toolsOff = new Set();
let otherTools = true;
let toolsOpen = false;
let includeAgents = false;

let events = [];
let seq = 0;
// Holds in the order they began; the pane acts on the first.
let holds = [];
let turnId = null;

let tab = "events";
let listShown = LIST_STEP;
let expandedId = null;
let ctxOpen = false;
let snapshot = { messages: [], context: null };
// The transcript row the live conversation starts at: 0 until a reset or compaction is seen.
let liveStart = 0;
// The re-run being prepared: { evId, upTo, prompt, status }.
let rerun = null;
// The rewrite the next compaction applies: { evId, upTo }; set only around the mod's own /compact.
let pendingRewrite = null;
// What that compaction came to: { kept } or { error }.
let rewriteDone = null;
let note = "";
// tool_use_id -> the text that replaces the tool's result as the model reads it.
const resultOverrides = new Map();

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "debugger",
      description: "Open the agent debugger, or control it: play, pause, step, stop",
      argumentHint: "[play|pause|step|stop]",
      immediate: true,
    });
    // A hot reload starts the module's variables over; the breakpoints come back from the store.
    await loadSettings($);
    await loadTools($);
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("command.run", { command: "debugger" }, async ($, e) => {
    const what = e.args.trim().toLowerCase();
    if (what === "play" || what === "pause" || what === "step" || what === "stop") {
      await act($, what);
      return { text: `Debugger: ${what}.` };
    }
    const opened = await $.ui.open({ id: PANE, title: "Debugger" });
    await refreshSnapshot($);
    await loadTools($);
    $.ui.invalidate("ui.render");
    return { text: opened.isPlaced ? "Debugger pane opened." : "Debugger is on, but there is no room for its pane here. Use /debugger play|pause|step|stop." };
  });

  on("prompt.submit", async ($, e, next) => {
    // Only the person's own idle prompt is a pause point; commands and deliveries pass.
    if (e.origin?.kind !== "composer" || e.turnId !== undefined || e.text.startsWith("/")) {
      return next(e);
    }
    const ev = record("prompt", clip(e.text, 80), { text: e.text });
    if (!shouldPause("prompt")) {
      return next(e);
    }
    const h = await hold($, next, ev, { text: e.text });
    if (h.decision === "stop" || h.decision === "aborted") {
      return { drop: "Stopped in the debugger before the prompt was sent." };
    }
    if (h.edit.text !== e.text) {
      ev.detail = { ...ev.detail, editedText: h.edit.text };
      return next({ ...e, text: h.edit.text });
    }
    return next(e);
  });

  on("turn.start", ($, e, next) => {
    turnId = e.turnId;
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) {
      await refreshSnapshot($);
    }
    const ev = record("request", `${e.model} · ${e.messageCount} messages`, { ...e }, e.agentId);
    let input = e;
    if (shouldPause("request", e.agentId)) {
      const h = await hold($, next, ev, { model: e.model, effort: e.effort === undefined ? "" : String(e.effort) });
      if (h.decision === "stop" || h.decision === "aborted") {
        return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: null, usage: null };
      }
      input = withStepEdits(e, h.edit, ev);
    }

    if (!shouldPause("response", e.agentId)) {
      const result = yield* next(input);
      record("response", describeResponse(result), responseDetail(result), e.agentId);
      return result;
    }

    // Buffered: nothing is shown or recorded until the hold is answered.
    const chunks = [];
    const stream = next(input);
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const result = await stream.result;
    const texts = {};
    for (const chunk of chunks) {
      if (chunk.kind === "text") {
        texts[chunk.index] = (texts[chunk.index] ?? "") + chunk.text;
      }
    }
    const rev = record("response", describeResponse(result), responseDetail(result), e.agentId);
    const h = await hold($, next, rev, { texts: { ...texts } });
    const edited = Object.keys(texts).filter((index) => h.edit.texts[index] !== texts[index]);
    if (edited.length === 0) {
      yield* chunks;
      return result;
    }
    rev.detail = { ...rev.detail, editedText: h.edit.texts };
    const sent = new Set();
    for (const chunk of chunks) {
      if (chunk.kind !== "text" || !edited.includes(String(chunk.index))) {
        yield chunk;
      } else if (!sent.has(chunk.index)) {
        sent.add(chunk.index);
        // An emptied block is dropped by yielding none of its chunks.
        if (h.edit.texts[chunk.index] !== "") {
          yield { ...chunk, text: h.edit.texts[chunk.index] };
        }
      }
    }
    return { ...result, answer: Object.keys(texts).map((index) => h.edit.texts[index]).join("") };
  });

  on("tool.call", async ($, e, next) => {
    const { tool, tool_use_id: id, agentId, ...args } = e;
    const ev = record("tool", `${tool} ${clip(JSON.stringify(args), 60)}`, { tool, tool_use_id: id, args }, agentId);
    let input = e;
    if (shouldPause("tool", agentId, tool)) {
      const h = await hold($, next, ev, { args: editable(args) });
      if (h.decision === "stop" || h.decision === "aborted") {
        return { deny: "The user stopped this turn in the debugger before the call ran. Do not retry it unless asked." };
      }
      if (h.decision === "skip") {
        return { deny: "The user skipped this tool call in the debugger. Do not retry it unless asked." };
      }
      const changed = parsedEdits(args, h.edit.args);
      if (Object.keys(changed).length > 0) {
        ev.detail = { ...ev.detail, editedArgs: changed };
        input = { ...e, ...changed };
      }
    }

    const ran = await next(input);
    const text = ran.deny !== undefined ? `denied: ${ran.deny}` : (ran.text ?? "");
    const rev = record("result", `${tool} ${ran.isError ? "error " : ""}${clip(text, 60)}`, { tool, tool_use_id: id, isError: ran.isError === true, text }, agentId);
    if (ran.deny === undefined && shouldPause("result", agentId, tool)) {
      const h = await hold($, next, rev, { text });
      if (h.edit.text !== text && h.decision !== "aborted") {
        rev.detail = { ...rev.detail, editedText: h.edit.text };
        resultOverrides.set(id, h.edit.text);
      }
    }
    return ran;
  });

  // An edited tool result is rewritten where the row is stored, so the model reads the edit.
  on("session.append", { door: "tool-result" }, ($, e, next) => {
    if (resultOverrides.size === 0) {
      return next(e);
    }
    let isChanged = false;
    const content = e.message.content.map((block) => {
      if (block.type !== "tool_result" || !resultOverrides.has(block.tool_use_id)) {
        return block;
      }
      const text = resultOverrides.get(block.tool_use_id);
      resultOverrides.delete(block.tool_use_id);
      isChanged = true;
      return { ...block, content: [{ type: "text", text }] };
    });
    return isChanged ? next({ ...e, message: { ...e.message, content } }) : next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e);
    }
    const ev = record("turn-end", `${e.reason} · ${Math.round(e.durationMs / 100) / 10}s`, { reason: e.reason, durationMs: e.durationMs, usage: e.usage ?? null, answer: e.answer });
    // Stepping ends with its turn: the turn's end stops only on its own breakpoint,
    // and the next turn runs to breakpoints again.
    if (e.reason !== "aborted" && breaks.has("turn-end")) {
      await hold($, next, ev, {});
    }
    mode = "play";
    turnId = null;
    $.ui.invalidate("ui.render");
    return next(e);
  });

  // A re-run's compaction is answered with the kept messages in place of a summary.
  on("session.compact", async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === "precompute") {
      return next(e);
    }
    const rowsBefore = await countRows($);
    if (pendingRewrite === null) {
      const out = await next(e);
      if (out.skip === undefined) {
        forgetContext($, rowsBefore);
      }
      return out;
    }
    const plan = pendingRewrite;
    pendingRewrite = null;
    const refuse = (error) => ((rewriteDone = { error }), { skip: `Agent Debugger: ${error}` });
    try {
      // e.messages is the live conversation: the transcript's rows from `offset` on.
      const offset = rowsBefore === null ? 0 : rowsBefore - e.messages.length;
      if (offset < 0 || plan.upTo - offset <= 0) {
        return refuse("that point is before the last reset or compaction, so it can no longer be re-run from.");
      }
      const messages = kept(e.messages, plan.upTo - offset);
      if (messages.length === 0) {
        return refuse("nothing would be left of the conversation. Use /clear and send the prompt again.");
      }
      rewriteDone = { kept: messages.length };
      relive($, plan, offset, rowsBefore, messages.length);
      return { messages };
    } catch {
      return refuse("could not rebuild the conversation; it is unchanged.");
    }
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => drawPane($, $.ui.resolve(e)));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (holds.length === 0 || e.props?.hasSurvey) {
      return next(e);
    }
    const t = $.ui.resolve(e);
    const below = await next(e);
    const row = drawBand($, t);
    return below ? t.Box({ flexDirection: "column", children: [row, below] }) : row;
  });
}

// ---- Events and holds -----------------------------------------------------

function record(kind, label, detail, agentId) {
  seq += 1;
  // `ctx`: how many messages the conversation held when the event happened (as last read).
  const ev = { id: seq, kind, label: clean(label), detail, agentId, status: "", ctx: agentId === undefined ? snapshot.messages.length : null };
  events.push(ev);
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  }
  return ev;
}

function shouldPause(kind, agentId, tool) {
  if (agentId !== undefined && !includeAgents) {
    return false;
  }
  if (mode === "step") {
    return true;
  }
  if (!breaks.has(kind)) {
    return false;
  }
  if (kind !== "tool" && kind !== "result") {
    return true;
  }
  return toolNames.includes(tool) ? !toolsOff.has(tool) : otherTools;
}

/** Holds the calling hook until a control answers; resolves the hold with its `decision` and `edit`. */
async function hold($, next, ev, edit) {
  const h = { ev, edit, decision: null };
  holds.push(h);
  ev.status = "paused";
  ev.why = mode === "step" && !(ev.kind === "turn-end") ? "stepping" : "breakpoint";
  tab = "events";
  if (rerun === null) {
    expandedId = ev.id;
    ctxOpen = false;
  }
  try {
    await refreshSnapshot($);
    if (ev.agentId === undefined) {
      ev.ctx = snapshot.messages.length;
    }
    await $.ui.open({ id: PANE, title: "Debugger" });
    $.ui.invalidate("ui.render");
    const startedAt = await $.clock.now();
    while (h.decision === null) {
      if (next.signal.aborted) {
        h.decision = "aborted";
        break;
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        h.decision = "continue";
        break;
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
  } catch (error) {
    // Anything unexpected lets the event go on unchanged, and says so.
    h.decision = h.decision ?? "continue";
    note = `Could not pause at #${ev.id}: ${clip(error?.message ?? error, 160)}`;
  } finally {
    holds = holds.filter((one) => one !== h);
    ev.status = h.decision;
    $.ui.invalidate("ui.render");
  }
  return h;
}

/** The controls: what a button, the band or `/debugger <what>` does. */
async function act($, what) {
  if (what === "play") {
    mode = "play";
    for (const h of holds) {
      h.decision = h.decision ?? "continue";
    }
  } else if (what === "pause") {
    mode = "step";
  } else if (what === "step") {
    mode = "step";
    if (holds[0]) {
      holds[0].decision = holds[0].decision ?? "step";
    }
  } else if (what === "skip") {
    if (holds[0]?.ev.kind === "tool") {
      holds[0].decision = holds[0].decision ?? "skip";
    }
  } else if (what === "stop") {
    for (const h of holds) {
      h.decision = h.decision ?? "stop";
    }
    if (turnId !== null) {
      try {
        await $.turn.abort({ turnId });
      } catch {
        // the turn had already ended
      }
    }
  }
  $.ui.invalidate("ui.render");
}

async function refreshSnapshot($) {
  try {
    const rows = await $.session.messages();
    const usage = await $.session.usage();
    snapshot = {
      messages: rows.map((m) => ({
        role: m.role,
        text: m.text,
        tools: m.toolUses.map((use) => ({ tool: use.tool, input: use.input })),
        results: (m.toolResults ?? []).map((one) => ({ text: one.text, isError: one.isError })),
      })),
      context: usage.context ?? null,
    };
  } catch {
    // keep the last snapshot
  }
}

/** The breakpoints are kept per session in the store, so a reload of the mod does not lose them. */
async function loadSettings($) {
  try {
    const saved = await $.store.get("breakpoints");
    if (saved === undefined || saved === null || saved.sessionId !== (await $.session.id())) {
      return;
    }
    breaks = new Set((saved.breaks ?? []).filter((kind) => KINDS.includes(kind)));
    toolsOff = new Set(saved.toolsOff ?? []);
    otherTools = saved.otherTools !== false;
    includeAgents = saved.includeAgents === true;
  } catch {
    // start from no breakpoints
  }
}

/** A breakpoint setting changed: keep it and draw it. */
async function settingsChanged($) {
  $.ui.invalidate("ui.render");
  try {
    await $.store.set("breakpoints", { sessionId: await $.session.id(), breaks: [...breaks], toolsOff: [...toolsOff], otherTools, includeAgents });
  } catch {
    // the setting still holds for this load
  }
}

/** Picking tools means stopping on them: with neither tool event checked, "tool call" is checked too. */
function armTools() {
  if (!breaks.has("tool") && !breaks.has("result")) {
    breaks.add("tool");
  }
}

function toolSummary() {
  const on = toolNames.filter((name) => !toolsOff.has(name));
  const total = toolNames.length + 1;
  const count = on.length + (otherTools ? 1 : 0);
  return count === total ? "all tools" : count === 0 ? "no tools" : on.length <= 3 && !otherTools ? on.join(", ") : `${count} of ${total} tools`;
}

async function countRows($) {
  try {
    return (await $.session.messages()).length;
  } catch {
    return null;
  }
}

/** After a reset or compaction, earlier events' context is no longer what the model reads. */
function forgetContext($, rowsBefore) {
  for (const ev of events) {
    ev.ctx = null;
  }
  liveStart = rowsBefore ?? snapshot.messages.length;
  ctxOpen = false;
  $.ui.invalidate("ui.render");
}

/** The breakpoint list's tools: the built-in ones, and any other this session has called. */
async function loadTools($) {
  try {
    const listed = (await $.tool.list()).map((one) => one.name).filter((name) => !name.startsWith("mcp__"));
    const called = events.map((ev) => ev.detail?.tool).filter((name) => typeof name === "string");
    const names = [...new Set([...listed, ...called])].sort();
    // A tool newly listed keeps the answer "other tools" gave for it.
    if (!otherTools) {
      names.filter((name) => !toolNames.includes(name)).forEach((name) => toolsOff.add(name));
    }
    toolNames = names;
  } catch {
    // keep the last list
  }
}

function withStepEdits(e, edit, ev) {
  const out = { ...e };
  const model = edit.model.trim();
  if (model !== "" && model !== e.model) {
    out.model = model;
  }
  const before = e.effort === undefined ? "" : String(e.effort);
  if (edit.effort !== "" && edit.effort !== before) {
    out.effort = EFFORTS.includes(edit.effort) ? edit.effort : Number(edit.effort);
  }
  if (out.model !== e.model || out.effort !== e.effort) {
    ev.detail = { ...ev.detail, sentModel: out.model, sentEffort: out.effort };
  }
  return out;
}

/** Arguments as the fields show them: strings as they are, everything else as JSON. */
function editable(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/** The arguments whose field changed, parsed back; a field that no longer parses keeps the original. */
function parsedEdits(args, edited) {
  const before = editable(args);
  const out = {};
  for (const key of Object.keys(args)) {
    if (edited[key] === before[key]) {
      continue;
    }
    if (typeof args[key] === "string") {
      out[key] = edited[key];
      continue;
    }
    try {
      out[key] = JSON.parse(edited[key]);
    } catch {
      note = `Kept the original "${key}": the edit was not valid JSON.`;
    }
  }
  return out;
}

/**
 * After a re-run's reset the list shows the live session alone: the events from the point on are
 * gone, and the earlier ones point at the kept messages, which the transcript appends as new rows.
 */
function relive($, plan, offset, rowsBefore, keptCount) {
  const base = rowsBefore ?? snapshot.messages.length;
  events = events.filter((ev) => ev.id < plan.evId);
  for (const ev of events) {
    ev.ctx = ev.ctx === null || ev.ctx < offset ? null : base + Math.min(ev.ctx - offset, keptCount);
  }
  liveStart = base;
  ctxOpen = false;
  expandedId = null;
  $.ui.invalidate("ui.render");
}

/** The conversation a re-run keeps: the first `count` live messages. */
function kept(messages, count) {
  const out = messages.slice(0, count);
  // A tool call whose result falls after the point would be left unanswered.
  while (out.length > 0 && out[out.length - 1].role === "assistant" && out[out.length - 1].toolUses.length > 0) {
    out.pop();
  }
  return out;
}

function startRerun(ev) {
  rerun = {
    evId: ev.id,
    upTo: ev.ctx,
    // Re-running from a prompt sends that prompt again unless it is changed.
    prompt: ev.kind === "prompt" ? (ev.detail.editedText ?? ev.detail.text) : "",
    status: "",
  };
}

/** Stops the running turn, resets the conversation to the re-run's point, and sends its prompt. */
async function runRerun($) {
  const plan = rerun;
  if (plan === null || plan.status === "working") {
    return;
  }
  plan.status = "working";
  $.ui.invalidate("ui.render");
  try {
    for (const h of holds) {
      h.decision = h.decision ?? "stop";
    }
    if (turnId !== null) {
      try {
        await $.turn.abort({ turnId });
      } catch {
        // the turn had already ended
      }
    }
    for (let i = 0; i < IDLE_POLLS && turnId !== null; i += 1) {
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    if (turnId !== null) {
      throw new Error("the running turn did not stop");
    }
    const text = plan.prompt.trim() === "" ? CONTINUE : plan.prompt;
    pendingRewrite = { evId: plan.evId, upTo: plan.upTo };
    rewriteDone = null;
    await $.command.run({ command: "compact", args: "" });
    if (pendingRewrite !== null) {
      pendingRewrite = null;
      throw new Error("the reset did not reach the debugger, so /compact ran as usual");
    }
    if (rewriteDone?.kept === undefined) {
      throw new Error(rewriteDone?.error ?? "the reset did not apply");
    }
    record("info", `re-ran from #${plan.evId}, keeping ${rewriteDone.kept} messages`, { keptMessages: rewriteDone.kept, prompt: text });
    rerun = null;
    await $.prompt.submit({ text, asUser: true });
  } catch (error) {
    pendingRewrite = null;
    plan.status = `Could not re-run: ${clip(error?.message ?? error, 200)}`;
  }
  $.ui.invalidate("ui.render");
}

function describeResponse(result) {
  const tools = result.toolUses.map((use) => use.name).join(", ");
  const said = clip(result.answer, 50);
  return [said, tools && `→ ${tools}`, result.stopReason && `(${result.stopReason})`].filter(Boolean).join(" ") || "(empty)";
}

function responseDetail(result) {
  return { answer: result.answer, toolUses: result.toolUses, stopReason: result.stopReason, usage: result.usage };
}

// ---- Drawing --------------------------------------------------------------

function drawPane($, t) {
  const { Box, Text, Button } = t;
  const press = (what) => () => void act($, what);
  const isPaused = holds.length > 0;
  return Box({
    flexDirection: "column",
    paddingX: 1,
    gap: 1,
    children: [
      Text({ bold: true, color: isPaused ? "yellow" : turnId !== null ? "green" : undefined, wrap: "truncate-end", children: statusLine() }),
      Box({
        flexDirection: "row",
        gap: 1,
        flexWrap: "wrap",
        children: [
          Button({ key: "pause", label: "⏸ Pause", hotkey: "p", onPress: press("pause") }),
          Button({ key: "step", label: "⏭ Step", hotkey: "s", onPress: press("step") }),
          Button({ key: "stop", label: "⏹ Stop", hotkey: "x", onPress: press("stop") }),
          Button({ key: "play", label: isPaused ? "▶ Continue" : "▶ Play", hotkey: "c", variant: isPaused ? "primary" : "secondary", onPress: press("play") }),
        ],
      }),
      Box({
        flexDirection: "row",
        gap: 2,
        children: TABS.map((name) =>
          Button({
            key: `tab-${name}`,
            label: name === tab ? `[${name}]` : name,
            plain: true,
            dimColor: name !== tab,
            onPress: () => {
              tab = name;
              void openTab($);
            },
          }),
        ),
      }),
      note !== "" ? Text({ color: "cyan", wrap: "wrap", children: clean(note) }) : null,
      tab === "breakpoints" ? drawBreakpoints($, t) : drawEvents($, t),
    ],
  });
}

async function openTab($) {
  if (tab === "breakpoints") {
    await loadTools($);
  }
  $.ui.invalidate("ui.render");
}

function drawBand($, t) {
  const { Box, Text, Button } = t;
  const press = (what) => () => void act($, what);
  const h = holds[0];
  return Box({
    flexDirection: "row",
    gap: 1,
    paddingX: 1,
    children: [
      Text({ bold: true, color: "yellow", wrap: "truncate-end", children: `⏸ ${KIND_LABEL[h.ev.kind]} · ${clip(h.ev.label, 50)}` }),
      Button({ key: "band-step", label: "Step", plain: true, onPress: press("step") }),
      Button({ key: "band-stop", label: "Stop", plain: true, onPress: press("stop") }),
      Button({ key: "band-play", label: "Continue", plain: true, onPress: press("play") }),
    ],
  });
}

function statusLine() {
  const h = holds[0];
  if (h) {
    const queued = holds.length > 1 ? ` (+${holds.length - 1} waiting)` : "";
    const why = h.ev.why === "stepping" ? "stepping: every event stops until you press Continue or the turn ends" : "breakpoint";
    return `⏸ PAUSED at ${KIND_LABEL[h.ev.kind]} (${why}) · ${clip(h.ev.label, 50)}${queued}`;
  }
  const tools = breaks.has("tool") || breaks.has("result") ? ` · ${toolSummary()}` : "";
  const armed = mode === "step" ? "stepping: stops at every event until you press Play or the turn ends" : breaks.size > 0 ? `breakpoints: ${[...breaks].map((kind) => KIND_LABEL[kind]).join(", ")}${tools}` : "no breakpoints";
  return turnId !== null ? `● RUNNING · ${armed}` : `○ IDLE · ${armed}`;
}

/** The events, newest first, so the one being held is at the top; each opens in place. */
function drawEvents($, t) {
  const { Box, Text, Button } = t;
  const redraw = () => $.ui.invalidate("ui.render");
  if (events.length === 0) {
    return Text({ dimColor: true, wrap: "wrap", children: "No events yet. Press Pause to stop at the next event, or set breakpoints, then send a prompt." });
  }
  const rows = [];
  for (const ev of events.slice(-listShown).reverse()) {
    const isOpen = ev.id === expandedId;
    const mark = ev.status === "paused" ? "⏸ " : ev.status === "skip" ? "⤫ " : wasEdited(ev) ? "✎ " : "";
    rows.push(
      Button({
        key: `ev-${ev.id}`,
        label: clip(`${isOpen ? "▾" : "▸"} #${ev.id} ${mark}${KIND_LABEL[ev.kind]}${ev.agentId ? " (agent)" : ""} · ${ev.label}`, 110),
        plain: true,
        dimColor: !isOpen && ev.status !== "paused",
        onPress: () => {
          expandedId = isOpen ? null : ev.id;
          ctxOpen = false;
          rerun = null;
          redraw();
        },
      }),
    );
    if (isOpen) {
      rows.push(drawOpenEvent($, t, ev));
    }
  }
  return Box({
    flexDirection: "column",
    children: [
      ...rows,
      events.length > listShown
        ? Button({ key: "older", label: `Show ${Math.min(LIST_STEP, events.length - listShown)} older events`, plain: true, dimColor: true, onPress: () => ((listShown += LIST_STEP), redraw()) })
        : null,
    ],
  });
}

function wasEdited(ev) {
  const d = ev.detail ?? {};
  return d.editedText !== undefined || d.editedArgs !== undefined || d.sentModel !== undefined;
}

/** An open event: its fields (inputs while it is held), then the conversation the model had before it. */
function drawOpenEvent($, t, ev) {
  const { Box, Text, Button } = t;
  const h = holds.find((one) => one.ev === ev);
  const isRerun = rerun !== null && rerun.evId === ev.id;
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: h ? "yellow" : undefined,
    paddingX: 1,
    marginLeft: 2,
    marginBottom: 1,
    children: [
      ...(h ? drawEditors($, t, h) : drawFields(t, ev)),
      ev.ctx === null
        ? Text({ dimColor: true, wrap: "wrap", children: ev.agentId ? "Context is not tracked for a subagent's events." : "The conversation was reset or compacted after this event, so its context is gone." })
        : isRerun
          ? null
          : Box({
              flexDirection: "row",
              gap: 3,
              marginTop: 1,
              children: [
                Button({
                  key: "ctx-toggle",
                  label: `${ctxOpen ? "▾" : "▸"} context before (${Math.max(0, ev.ctx - liveStart)} messages)`,
                  plain: true,
                  onPress: () => {
                    ctxOpen = !ctxOpen;
                    void openContext($);
                  },
                }),
                // Offered on an event picked from the list, not on the one a pause just opened.
                h ? null : Button({ key: "rerun-open", label: "↻ Re-run from here", plain: true, onPress: () => (startRerun(ev), void openContext($)) }),
              ],
            }),
      isRerun ? drawRerun($, t, ev) : null,
      ev.ctx !== null && !isRerun && ctxOpen ? drawTranscript(t, ev.ctx) : null,
    ],
  });
}

async function openContext($) {
  await refreshSnapshot($);
  $.ui.invalidate("ui.render");
}

/** The re-run panel: what it does, an optional message to send, and the context it keeps. */
function drawRerun($, t, ev) {
  const { Box, Text, Button, Input } = t;
  const plan = rerun;
  const setPrompt = (v) => (plan.prompt = v);
  return Box({
    flexDirection: "column",
    marginTop: 1,
    gap: 1,
    children: [
      Text({ bold: true, color: "yellow", children: `↻ Re-run from #${ev.id}` }),
      Text({
        wrap: "wrap",
        children: `This resets the session to the point just before this event. The model keeps the ${Math.max(0, plan.upTo - liveStart)} messages below and forgets everything after them; the running turn is stopped and the run continues from there. Files changed and commands already run are not undone.`,
      }),
      Input({ key: "rerun-prompt", label: "message (optional)", placeholder: `empty sends "${CONTINUE}"`, value: plan.prompt, submitLabel: "✓", onInput: setPrompt, onSubmit: setPrompt }),
      Box({
        flexDirection: "row",
        gap: 2,
        children: [
          Button({ key: "rerun-go", label: "Re-run now", variant: "primary", onPress: () => void runRerun($) }),
          Button({ key: "rerun-cancel", label: "Cancel", onPress: () => ((rerun = null), $.ui.invalidate("ui.render")) }),
        ],
      }),
      plan.status !== "" ? Text({ color: plan.status === "working" ? "cyan" : "red", wrap: "wrap", children: plan.status === "working" ? "Resetting the session…" : plan.status }) : null,
      drawTranscript(t, plan.upTo),
    ],
  });
}

/** The live conversation up to `end` as the model reads it, as text. */
function drawTranscript(t, end) {
  const { Box, Text } = t;
  const { messages } = snapshot;
  const last = Math.min(end, messages.length);
  const first = Math.max(liveStart, last - CONTEXT_MAX);
  const rows = [Text({ dimColor: true, wrap: "wrap", children: `The ${Math.max(0, last - liveStart)} messages the model has at this point, oldest first (the system prompt and tool definitions are not shown).${first > liveStart ? ` Showing the last ${CONTEXT_MAX}.` : ""}` })];
  for (let index = first; index < last; index += 1) {
    const m = messages[index];
    rows.push(
      Box({
        flexDirection: "column",
        marginTop: 1,
        children: [
          Text({ bold: true, color: m.role === "user" ? "cyan" : "magenta", children: `#${index - liveStart} ${m.role.toUpperCase()}` }),
          m.text !== "" ? Text({ wrap: "wrap", children: clean(m.text).slice(0, VALUE_CHARS) }) : null,
          ...m.tools.map((use) => Text({ dimColor: true, wrap: "wrap", children: `→ calls ${use.tool} ${clip(shown(use.input), LINE_CHARS)}` })),
          ...m.results.map((one) => Text({ dimColor: true, wrap: "wrap", children: `← tool ${one.isError ? "error" : "result"}: ${clip(one.text, LINE_CHARS)}` })),
        ],
      }),
    );
  }
  return Box({ flexDirection: "column", marginTop: 1, children: rows });
}

function field(t, label, value) {
  const { Text } = t;
  return Text({ wrap: "wrap", children: [Text({ dimColor: true, children: `${label}  ` }), Text({ children: clean(value).slice(0, VALUE_CHARS) || "(empty)" })] });
}

function shown(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function usageText(usage) {
  return usage ? `${usage.input_tokens ?? "?"} in · ${usage.output_tokens ?? "?"} out` : "none reported";
}

/** An event's fields as text, once it is no longer held. */
function drawFields(t, ev) {
  const d = ev.detail ?? {};
  const rows = [];
  const add = (label, value) => rows.push(field(t, label, value));
  if (ev.kind === "prompt") {
    add("prompt", d.text);
    d.editedText !== undefined && add("sent as", d.editedText);
  } else if (ev.kind === "request") {
    add("model", d.sentModel ?? d.model);
    add("effort", shown(d.sentEffort ?? d.effort ?? "default"));
    add("messages", String(d.messageCount));
    d.sentModel !== undefined && add("asked for", `${d.model} · ${shown(d.effort ?? "default")}`);
  } else if (ev.kind === "response") {
    add("text", d.answer || "(no text)");
    for (const use of d.toolUses ?? []) {
      add("calls", `${use.name} ${shown(use.input)}`);
    }
    add("stop", shown(d.stopReason ?? "none"));
    add("tokens", usageText(d.usage));
    d.editedText !== undefined && add("shown as", Object.values(d.editedText).join(""));
  } else if (ev.kind === "tool") {
    add("tool", d.tool);
    for (const [key, value] of Object.entries(d.args ?? {})) {
      add(key, shown(value));
    }
    for (const [key, value] of Object.entries(d.editedArgs ?? {})) {
      add(`${key} ran as`, shown(value));
    }
  } else if (ev.kind === "result") {
    add("tool", d.tool);
    add(d.isError ? "error" : "result", d.text);
    d.editedText !== undefined && add("model read", d.editedText);
  } else if (ev.kind === "info") {
    add("note", ev.label);
  } else {
    add("ended", d.reason);
    add("took", `${Math.round((d.durationMs ?? 0) / 100) / 10}s`);
    add("tokens", usageText(d.usage));
  }
  return rows;
}

/** A held event's fields as inputs; each writes into the hold's `edit`, read when it continues. */
function drawEditors($, t, h) {
  const { Box, Text, Button, Input, Select } = t;
  const d = h.ev.detail ?? {};
  const id = h.ev.id;
  // An Input is one line on every surface. A value of several lines gets a field per line, so it
  // reads and edits as a block; one too long for that is shown whole above a single field.
  const input = (key, label, value, set) => {
    const one = (suffix, text, fieldLabel, write) => Input({ key: `edit-${id}-${key}${suffix}`, label: fieldLabel, value: text, submitLabel: "✓", onInput: write, onSubmit: write });
    const lines = value.split("\n");
    if (lines.length > 1 && lines.length <= MAX_LINES) {
      const write = (at) => (v) => ((lines[at] = v), set(lines.join("\n")));
      return Box({ flexDirection: "column", children: [Text({ dimColor: true, children: label }), ...lines.map((line, at) => one(`-${at}`, line, undefined, write(at)))] });
    }
    const box = one("", value, label, set);
    return value.length > LONG_VALUE || lines.length > 1 ? Box({ flexDirection: "column", children: [field(t, `${label} now`, value), box] }) : box;
  };
  if (h.ev.kind === "prompt") {
    return [input("text", "prompt", h.edit.text, (v) => (h.edit.text = v))];
  }
  if (h.ev.kind === "request") {
    return [
      input("model", "model", h.edit.model, (v) => (h.edit.model = v)),
      Select({
        key: `edit-${id}-effort`,
        label: "effort",
        value: h.edit.effort,
        options: [{ value: "", label: "default" }, ...EFFORTS.map((value) => ({ value }))],
        onSelect: (v) => (h.edit.effort = v),
      }),
      field(t, "messages", String(d.messageCount)),
    ];
  }
  if (h.ev.kind === "response") {
    return [
      ...Object.keys(h.edit.texts).map((index) => input(`text-${index}`, "text", h.edit.texts[index], (v) => (h.edit.texts[index] = v))),
      ...(d.toolUses ?? []).map((use) => field(t, "calls", `${use.name} ${shown(use.input)}`)),
      field(t, "stop", shown(d.stopReason ?? "none")),
    ];
  }
  if (h.ev.kind === "tool") {
    return [
      field(t, "tool", d.tool),
      ...Object.keys(h.edit.args).map((key) => input(`arg-${key}`, key, h.edit.args[key], (v) => (h.edit.args[key] = v))),
      Box({ flexDirection: "row", children: [Button({ key: `skip-${id}`, label: "Skip this call", onPress: () => void act($, "skip") })] }),
    ];
  }
  if (h.ev.kind === "result") {
    return [field(t, "tool", d.tool), input("text", "result", h.edit.text, (v) => (h.edit.text = v))];
  }
  return drawFields(t, h.ev);
}

function drawBreakpoints($, t) {
  const { Box, Text, Button } = t;
  const redraw = () => $.ui.invalidate("ui.render");
  const changed = () => void settingsChanged($);
  const isArmed = breaks.has("tool") || breaks.has("result");
  const check = (isOn, label) => `${isOn ? "[x]" : "[ ]"} ${label}`;
  return Box({
    flexDirection: "column",
    gap: 1,
    children: [
      Text({ dimColor: true, wrap: "wrap", children: "Play runs until a checked event. Pause and Step stop at every event of the current turn, checked or not; when the turn ends, only the checked events stop again." }),
      Box({
        flexDirection: "column",
        children: KINDS.map((kind) =>
          Button({
            key: `bp-${kind}`,
            label: `${breaks.has(kind) ? "[x]" : "[ ]"} ${KIND_LABEL[kind]}`,
            plain: true,
            onPress: () => {
              breaks.has(kind) ? breaks.delete(kind) : breaks.add(kind);
              changed();
            },
          }),
        ),
      }),
      Box({
        flexDirection: "column",
        children: [
          Button({ key: "bp-tools", label: `${toolsOpen ? "▾" : "▸"} tool call and tool result stop on: ${toolSummary()}${isArmed ? "" : " (neither is checked above)"}`, plain: true, onPress: () => ((toolsOpen = !toolsOpen), redraw()) }),
          ...(toolsOpen
            ? [
                Box({
                  flexDirection: "row",
                  gap: 3,
                  marginLeft: 2,
                  children: [
                    Button({ key: "bp-tools-all", label: "Select all", plain: true, onPress: () => ((toolsOff = new Set()), (otherTools = true), armTools(), changed()) }),
                    Button({ key: "bp-tools-none", label: "Deselect all", plain: true, onPress: () => ((toolsOff = new Set(toolNames)), (otherTools = false), changed()) }),
                  ],
                }),
                ...toolNames.map((name) =>
                  Box({
                    flexDirection: "row",
                    marginLeft: 2,
                    children: [
                      Button({
                        key: `bp-tool-${name}`,
                        label: check(!toolsOff.has(name), name),
                        plain: true,
                        onPress: () => {
                          if (toolsOff.has(name)) {
                            toolsOff.delete(name);
                            armTools();
                          } else {
                            toolsOff.add(name);
                          }
                          changed();
                        },
                      }),
                    ],
                  }),
                ),
                Box({ flexDirection: "row", marginLeft: 2, children: [Button({ key: "bp-tools-other", label: check(otherTools, "other tools (MCP and unlisted)"), plain: true, onPress: () => ((otherTools = !otherTools), otherTools && armTools(), changed()) })] }),
              ]
            : []),
        ],
      }),
      Box({
        flexDirection: "row",
        children: [
          Button({
            key: "bp-agents",
            label: `${includeAgents ? "[x]" : "[ ]"} also pause inside subagents`,
            plain: true,
            onPress: () => {
              includeAgents = !includeAgents;
              changed();
            },
          }),
        ],
      }),
    ],
  });
}

// ---- Text -----------------------------------------------------------------

/** Text an element may hold: tab and newline are the only control characters allowed. */
function clean(text) {
  return String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function clip(text, max) {
  const flat = clean(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
