#!/usr/bin/env -S npx tsx
/**
 * Task routing + sessions smoke test (pure, headless, no network).
 *
 * Pins the three things a routed agent must never get wrong:
 *   1. the classifier — "переведи 5 CYBER" is money, not translation;
 *   2. the router — a cheap kind goes to the cheap provider, a critical one
 *      never does by accident, and a broken route falls back loudly;
 *   3. the escalation — the moment a cheap turn reaches for a tool it is
 *      lifted back onto the operator's own provider.
 *
 * Run: npm run tasks:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../src/runtime.js";
import { SessionStore } from "../src/memory/sessions.js";
import { recapHeader, transcriptFor, humanDuration } from "../src/memory/recap.js";
import { answerStamp, SwitchableModelProvider } from "../src/models/routing.js";
import { servedBy } from "../src/models/openrouter.js";
import { resolveEnvTaskRoutes } from "../src/models/index.js";
import { TaskKind, classifyTask, formatTaskRoute, parseTaskRoute } from "../src/models/tasks.js";
import { parseFreeModels } from "../src/models/openrouter.js";
import {
  ModelTier,
  type Action,
  type Character,
  type Memory,
  type MemoryStore,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

// ------------------------------------------------------------- classifier

const cases: [string, TaskKind][] = [
  ["переведи 5 CYBER на 0x1234", TaskKind.MONEY],
  ["продай все выгодные позиции", TaskKind.MONEY],
  ["купи LAIN на 3 CYBER", TaskKind.MONEY],
  ["what's my balance?", TaskKind.MONEY],
  ["переведи этот текст на английский", TaskKind.TRANSLATE],
  ["translate the readme", TaskKind.TRANSLATE],
  ["почини баг в бридже", TaskKind.CODE],
  ["отрефактори этот скрипт", TaskKind.CODE],
  ["напиши пост про новый кошелёк", TaskKind.WRITE],
  ["напиши мне короткий твит про запуск", TaskKind.WRITE],
  ["собери дайджест новостей по Solana", TaskKind.DIGEST],
  ["что нового в экосистеме?", TaskKind.DIGEST],
  ["проанализируй метрики за неделю", TaskKind.ANALYSIS],
  ["сравни отчёты за два месяца", TaskKind.ANALYSIS],
  ["как дела? скучала?", TaskKind.CHAT],
  ["поставь чайник", TaskKind.CHAT],
  ["", TaskKind.CHAT],
];
for (const [text, want] of cases) {
  const got = classifyTask(text).kind;
  check(`classify: ${text.slice(0, 28) || "(empty)"}`.padEnd(38), got === want);
}
check(
  "classify names its signal   ",
  classifyTask("собери дайджест").signal.includes("дайджест"),
);

// ----------------------------------------------------------------- routes

check("route: bare provider       ", parseTaskRoute("cyberia")?.provider === "cyberia");
const withModel = parseTaskRoute("openrouter:deepseek/deepseek-chat-v3:free");
check(
  "route: model keeps its colons",
  withModel?.provider === "openrouter" && withModel?.model === "deepseek/deepseek-chat-v3:free",
);
check("route: none clears         ", parseTaskRoute("none") === undefined);
check(
  "route: round-trips           ",
  formatTaskRoute({ provider: "openrouter", model: "x:free" }) === "openrouter:x:free",
);

const env = (map: Record<string, string>) => (key: string) => map[key];

const cheapEnv = resolveEnvTaskRoutes(env({ LAINOS_TASK_CHEAP: "openrouter:openrouter/free" }), "claude");
check("cheap knob covers digests  ", cheapEnv[TaskKind.DIGEST]?.route.provider === "openrouter");
check("cheap knob covers memory   ", cheapEnv[TaskKind.MEMORY]?.source === "cheap");
check("cheap knob spares money    ", cheapEnv[TaskKind.MONEY] === undefined);
check("cheap knob spares code     ", cheapEnv[TaskKind.CODE] === undefined);
check("cheap knob spares chat     ", cheapEnv[TaskKind.CHAT] === undefined);

const explicitEnv = resolveEnvTaskRoutes(
  env({ LAINOS_TASK_CHEAP: "openrouter", LAINOS_TASK_DIGEST: "cyberia" }),
  "claude",
);
check("explicit kind beats cheap  ", explicitEnv[TaskKind.DIGEST]?.route.provider === "cyberia");
check("explicit kind is 'env'     ", explicitEnv[TaskKind.DIGEST]?.source === "env");

const autoEnv = resolveEnvTaskRoutes(env({ CYBERIA_AI_KEY: "sk-cyb-x" }), "claude");
check("free key adopted for cheap ", autoEnv[TaskKind.TRANSLATE]?.route.provider === "cyberia");
const sameEnv = resolveEnvTaskRoutes(env({ CYBERIA_AI_KEY: "sk-cyb-x" }), "cyberia");
check("no route to the base itself", sameEnv[TaskKind.TRANSLATE] === undefined);
const offEnv = resolveEnvTaskRoutes(env({ CYBERIA_AI_KEY: "sk-cyb-x", LAINOS_TASK_CHEAP: "none" }), "claude");
check("cheap=none keeps one model ", offEnv[TaskKind.DIGEST] === undefined);

// ------------------------------------------------------- switchable router

/** A provider that answers instantly and remembers what it was asked. */
class SpyProvider implements ModelProvider {
  readonly seen: ModelRequest[] = [];
  constructor(readonly name: string) {}
  modelFor(tier: ModelTier): string {
    return `${this.name}-${tier}`;
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.seen.push(request);
    return { text: `answered by ${this.name}`, toolCalls: [], model: this.modelFor(request.tier), provider: this.name };
  }
}

const base = new SpyProvider("claude");
const cheap = new SpyProvider("openrouter");
const persisted: Record<string, string>[] = [];
const router = new SwitchableModelProvider({
  initial: base,
  kind: "claude",
  envKind: "claude",
  assemble: () => base,
  persist: () => {},
  routes: { [TaskKind.DIGEST]: { route: { provider: "openrouter" }, source: "cheap" } },
  buildRoute: (route) => (route.provider === "openrouter" ? cheap : undefined),
  persistRoutes: (routes) => persisted.push(routes),
});

const ask = (task?: TaskKind) =>
  router.generate({ tier: ModelTier.MEDIUM, task, system: "s", messages: [{ role: "user", content: "hi" }] });

await ask(TaskKind.DIGEST);
check("digest goes to the cheap route", cheap.seen.length === 1 && base.seen.length === 0);
await ask(TaskKind.MONEY);
check("money stays on the base      ", base.seen.length === 1);
await ask();
check("untagged work stays on base  ", base.seen.length === 2);

const set = router.setTaskRoute(TaskKind.TRANSLATE, "openrouter:x/y:free");
check("setTaskRoute reports the row ", typeof set !== "string" && set.provider === "openrouter");
check("setTaskRoute persists        ", persisted.at(-1)?.translate === "openrouter:x/y:free");
const bad = router.setTaskRoute(TaskKind.WRITE, "nonesuch");
check("unbuildable route fails loud ", typeof bad === "string" && bad.includes("unavailable"));
const cleared = router.setTaskRoute(TaskKind.TRANSLATE, null);
check("clearing returns to the base ", typeof cleared !== "string" && cleared.source === "base");
check(
  "table lists every kind       ",
  router.taskRoutes().length === 8 && router.taskRoutes().every((r) => Boolean(r.provider)),
);

// ------------------------------------------------------------- provenance
//
// The id we ask for is not the id that answers: `lain-free` is an alias of
// Cyberia's gateway (which rewrites `model` back to what was requested and
// names the real one in provider/served_by) and `openrouter/free` is a router.

check(
  "served: gateway names upstream",
  servedBy("lain-free", { model: "lain-free", provider: "groq" }).upstream === "groq",
);
check(
  "served: fallback wins over id ",
  servedBy("lain-free", { model: "lain-free", served_by: "lain-nvidia" }).model === "lain-nvidia",
);
check(
  "served: router resolves model ",
  servedBy("openrouter/free", { model: "deepseek/deepseek-chat-v3:free" }).model ===
    "deepseek/deepseek-chat-v3:free",
);
check("served: bare body keeps ours ", servedBy("lain-free", {}).model === "lain-free");
check(
  "served: no echo of itself     ",
  servedBy("openrouter/free", { model: "openrouter/free", provider: "openrouter/free" }).upstream ===
    undefined,
);
check(
  "stamp reads left to right     ",
  answerStamp({ task: TaskKind.DIGEST, provider: "cyberia", model: "lain-free", upstream: "groq" }) ===
    "📰 digest · cyberia/lain-free ← groq",
);
check(
  "stamp shows an escalation     ",
  answerStamp({ task: TaskKind.CHAT, escalatedFrom: TaskKind.DIGEST, provider: "claude", model: "opus" }).startsWith(
    "💬 chat↑ (was digest)",
  ),
);

// ------------------------------------------------------------- escalation

class ToolThenTextProvider implements ModelProvider {
  readonly tasks: (TaskKind | undefined)[] = [];
  readonly name = "spy";
  private calls = 0;
  modelFor(tier: ModelTier): string {
    return `spy-${tier}`;
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.tasks.push(request.task);
    this.calls += 1;
    if (this.calls === 1) {
      return { text: "", toolCalls: [{ name: "peek", input: {} }], model: "spy", provider: "spy" };
    }
    return { text: "done", toolCalls: [], model: "spy", provider: "spy" };
  }
}

class ArrayMemory implements MemoryStore {
  readonly rows: Memory[] = [];
  async add(memory: Memory) {
    this.rows.push(memory);
  }
  async recent(roomId: string, limit: number) {
    return this.rows.filter((m) => m.roomId === roomId).slice(-limit);
  }
  async search() {
    return [];
  }
  async remember() {}
  async facts() {
    return [];
  }
}

const character: Character = {
  name: "Lain",
  bio: [],
  lore: [],
  topics: [],
  adjectives: [],
  examples: [],
  style: { all: [], chat: [], post: [] },
  plugins: [],
};

const peek: Action = {
  name: "peek",
  similes: [],
  description: "look at something",
  examples: [],
  async validate() {
    return true;
  },
  async handler() {
    return { ok: true, text: "peeked" };
  },
};

const spy = new ToolThenTextProvider();
const tmp = await mkdtemp(join(tmpdir(), "lainos-tasks-"));
const store = new SessionStore(tmp);
const runtime = new AgentRuntime({
  character,
  memory: new ArrayMemory(),
  model: spy,
  sessions: store,
  settings: { LAINOS_MODEL_TRANSCRIPTS: "0" },
});
runtime.use({ name: "t", description: "test", actions: [peek] });

const events: string[] = [];
const turn = await runtime.handleMessageStream(
  { roomId: "tui-test", userId: "u", text: "собери дайджест новостей" },
  (ev) => {
    if (ev.type === "task") events.push(`${ev.kind}${ev.escalated ? "!" : ""}`);
  },
);
check("cheap turn starts cheap      ", spy.tasks[0] === TaskKind.DIGEST);
check("tool use escalates the turn  ", spy.tasks[1] === TaskKind.CHAT);
check("escalation is announced      ", events.join(",") === "digest,chat!");
check("result names what it became  ", turn.task === TaskKind.CHAT && turn.escalatedFrom === TaskKind.DIGEST);
check("result carries the provider  ", turn.provider === "spy");

// --------------------------------------------------------------- sessions

const recorded = await store.resolve("tui-test");
check("the turn wrote a session     ", Boolean(recorded) && recorded!.turns === 1);
check("session titles itself        ", recorded!.title.startsWith("собери дайджест"));
check("session counts the tool      ", recorded!.tools.peek === 1);
check("session counts the kind      ", recorded!.tasks[TaskKind.CHAT] === 1);

await store.record({ roomId: "cli-2", userText: "hello", model: "m", task: TaskKind.CHAT });
const list = await store.list(10);
check("list is newest first         ", list[0].roomId === "cli-2");
check("list filters by client       ", (await store.list(10, { client: "tui" })).length === 1);
check("resolve by index             ", (await store.resolve("1"))?.roomId === "cli-2");
check("resolve by id                ", (await store.resolve(list[0].id))?.roomId === "cli-2");
check("unknown ref resolves to none ", (await store.resolve("s-nope")) === undefined);

await store.setRecap(recorded!.id, { text: "…", at: Date.now(), model: "m" });
check("recap survives a reload      ", Boolean((await new SessionStore(tmp).resolve(recorded!.id))?.recap));

const header = recapHeader({ ...recorded!, turns: 3, models: { a: 2, b: 1 } });
check("header counts models         ", header.includes("a ×2"));
check("header stamps the kind       ", header.includes("💬"));
check("header never invents a summary", !header.includes("undefined"));
check("duration reads in hours      ", humanDuration(3 * 3600_000 + 60_000) === "3h 1m");
check(
  "transcript keeps both speakers",
  transcriptFor([
    { id: "1", roomId: "r", userId: "u", role: "user", content: "a", createdAt: 1 },
    { id: "2", roomId: "r", userId: "agent", role: "agent", content: "b", createdAt: 2 },
  ]) === "operator: a\nlain: b",
);

await rm(tmp, { recursive: true, force: true });

// ------------------------------------------------------- the free pool

// `openrouter/free` is a router, and "which free model" is only answerable if
// something lists the pool. Free is a price, not a name — and the pool prices
// music and image models at zero too, which cannot answer a turn.
const pool = parseFreeModels({
  data: [
    { id: "z/last:free", name: "Z: Last (free)", pricing: { prompt: "0", completion: "0" }, context_length: 8192 },
    { id: "a/first:free", name: "A: First (free)", pricing: { prompt: "0.0", completion: "0" } },
    { id: "google/lyria:free", name: "Lyria", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } },
    { id: "paid/model", name: "Paid", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "z/last:free", name: "duplicate", pricing: { prompt: "0", completion: "0" } },
    { id: "unpriced/model", name: "No prices published" },
  ],
});
check("free is a price, not a name  ", pool.map((m) => m.id).join() === "a/first:free,z/last:free");
check("a music model is not a writer", !pool.some((m) => m.id.includes("lyria")));
check("the (free) suffix is dropped ", pool[0].name === "A: First");
check("context survives when given  ", pool[1].context === 8192 && pool[0].context === undefined);
check("an empty catalogue is empty  ", parseFreeModels({}).length === 0 && parseFreeModels(null).length === 0);

// ------------------------------------------------------------------ report

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed += 1;
  console.log(`${name.padEnd(32)}: ${pass ? "PASS" : "FAIL"}`);
}
console.log(failed ? `TASKS PROBE FAILED (${failed})` : "TASKS PROBE OK");
process.exit(failed ? 1 : 0);
