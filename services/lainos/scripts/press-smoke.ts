#!/usr/bin/env -S npx tsx
/**
 * Press-room smoke test (pure + one headless service run, no network, no model).
 *
 * Pins the four things a daily post must never get wrong:
 *   1. the plan — the shipped calendar parses, and a date maps to its own slot;
 *   2. the queue — a backlog drains oldest-first, ages out, and never counts a
 *      day that was written, published or deliberately skipped;
 *   3. the text — whatever a chat model wraps around a post is stripped, so
 *      what reaches the channel is the post and nothing else;
 *   4. the schedule — nothing before the posting hour, never more than the
 *      day's cap, and the evening repeat only for a post still unpublished.
 *
 * Run: npm run press:smoke
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PressService,
  cleanPostText,
  commitsText,
  headerFor,
  parseGitLog,
  resolveDay,
  writerRefusal,
  writerBrief,
  writerSystemPrompt,
  type PressEvent,
} from "../src/plugins/press/index.js";
import {
  daysBetween,
  parsePlan,
  pendingSlots,
  planExhausted,
  slotFor,
  type ContentPlan,
} from "../src/plugins/press/plan.js";
import { parseChannelPostTexts } from "../src/plugins/channel/index.js";
import { isTelegramRefusal } from "../src/clients/telegram.js";
import type { IAgentRuntime, ModelRequest, ModelResponse } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

// ------------------------------------------------------------------- plan

const shipped = parsePlan(
  await readFile(resolve(process.cwd(), "content-plan.json"), "utf8"),
);
check("shipped plan parses          ", shipped.slots.length === 28);
check("shipped plan spans the month ", shipped.range.from === "2026-08-24" && shipped.range.to === "2026-09-20");
check(
  "every slot is complete       ",
  shipped.slots.every((s) => s.date && s.day && s.pillar && s.primary && s.asset && s.cta),
);
check("slots are unique per day     ", new Set(shipped.slots.map((s) => s.date)).size === 28);
check(
  "a date maps to its own slot  ",
  slotFor(shipped, "2026-08-25")?.pillar === "Build in public" &&
    slotFor(shipped, "2026-09-20")?.pillar === "Retrospective",
);
check("a date outside the plan is undefined", slotFor(shipped, "2026-10-01") === undefined);
check("posts stay in English        ", shipped.language === "en");

let parseRefused = false;
try {
  parsePlan('{"slots":[]}');
} catch {
  parseRefused = true;
}
check("a plan with no slots throws  ", parseRefused);

check("day arithmetic               ", daysBetween("2026-08-24", "2026-08-27") === 3);
check("plan exhaustion is a date    ", planExhausted(shipped, "2026-09-21") && !planExhausted(shipped, "2026-09-20"));

// ------------------------------------------------------------------ queue

const done = new Set<string>();
const owed = (day: string, maxBacklogDays = 3) =>
  pendingSlots(shipped, day, { done: (d) => done.has(d), maxBacklogDays }).map((s) => s.date);

check("two missed days queue oldest-first", JSON.stringify(owed("2026-08-25")) === '["2026-08-24","2026-08-25"]');
done.add("2026-08-24");
check("a written day leaves the queue", JSON.stringify(owed("2026-08-25")) === '["2026-08-25"]');
check("the future is not owed       ", !owed("2026-08-25").includes("2026-08-26"));
check("a stale slot ages out        ", !owed("2026-09-05").includes("2026-08-25"));
check("zero backlog means today only", JSON.stringify(owed("2026-08-26", 0)) === '["2026-08-26"]');

// ------------------------------------------------------------------- text

check(
  "a fenced answer is unwrapped ",
  cleanPostText("```\nUsers should not choose a chain.\n```") === "Users should not choose a chain.",
);
check(
  "a preamble line is dropped   ",
  cleanPostText("Here's the post:\n\nOne seed phrase.\n\nEight networks.") ===
    "One seed phrase.\n\nEight networks.",
);
check(
  "wrapping quotes are dropped  ",
  cleanPostText('"The wallet is built."') === "The wallet is built.",
);
check(
  "markdown headers are dropped ",
  cleanPostText("## Zero fees\n\nSomeone still pays.") === "Zero fees\n\nSomeone still pays.",
);
check(
  "an ordinary post is untouched",
  cleanPostText("Send $20 to @bob.\n\nNo address. No chain.") === "Send $20 to @bob.\n\nNo address. No chain.",
);

// --------------------------------------------------------------- material

const log =
  "\x1eabc123\x1f2026-08-25\x1ffeat(wallet): let one phrase hold eight networks\x1fbody line\x1f" +
  "backend/laravel/resources/js/lib/wallet/chains.ts\nbackend/laravel/README.md\n" +
  "\x1edef456\x1f2026-08-24\x1ffix(bridge): claim capacity before the wallet opens\x1f\x1f" +
  "backend/laravel/app/Services/BridgeService.php\n";
const commits = parseGitLog(log);
check("git log parses both commits  ", commits.length === 2);
check("subject survives             ", commits[0].subject === "feat(wallet): let one phrase hold eight networks");
check("body survives                ", commits[0].body === "body line");
check("touched area is deduplicated ", JSON.stringify(commits[0].areas) === '["backend/laravel"]');
check("a commit with no body is fine", commits[1].body === "");
check("empty log parses to nothing  ", parseGitLog("").length === 0);
check("material renders as lines    ", commitsText(commits).split("\n")[0].startsWith("- 2026-08-25 feat(wallet)"));
check("material can be capped       ", commitsText(commits, 1).split("\n").filter((l) => l.startsWith("- ")).length === 1);

// --------------------------------------------------------------- prompting

const slot = slotFor(shipped, "2026-08-25")!;
const system = writerSystemPrompt(shipped);
check("writer is told the language  ", system.includes("English"));
check("writer is barred from internals", /Never name a library/.test(system));
check("writer is told to end on one question", /exactly one question/.test(system));
check("writer returns only the post ", /OUTPUT: the post text and nothing else/.test(system));

const brief = writerBrief(shipped, slot, commits, ["previous post"], "сделай про мост");
check("brief carries the day's thesis", brief.includes(slot.primary));
check("brief carries the material   ", brief.includes("feat(wallet)"));
check("brief carries what was posted", brief.includes("previous post"));
check("brief carries the operator's angle", brief.includes("сделай про мост"));
check(
  "no commits is stated, not faked",
  writerBrief(shipped, slot, [], []).includes("новых коммитов нет"),
);

check(
  "header names the day and the asset",
  headerFor("draft", slot, { date: slot.date, pillar: slot.pillar, text: "x", revision: 1, writtenAt: 0 })
    .includes(slot.asset),
);
check(
  "a repeat says it is unpublished",
  headerFor("repeat", slot, { date: slot.date, pillar: slot.pillar, text: "x", revision: 1, writtenAt: 0 })
    .includes("не опубликован"),
);

check("'сегодня' is today           ", resolveDay("сегодня", "2026-08-25") === "2026-08-25");
check("'завтра' is tomorrow         ", resolveDay("завтра", "2026-08-25") === "2026-08-26");
check("'26.08' is a date            ", resolveDay("26.08", "2026-08-25") === "2026-08-26");
check("an ISO date passes through   ", resolveDay("2026-09-01", "2026-08-25") === "2026-09-01");
check("nothing means today          ", resolveDay(undefined, "2026-08-25") === "2026-08-25");

// ------------------------------------------------------------------ channel

const preview = `
<div class="tgme_widget_message js-widget_message" data-post="c/1">
  <div class="tgme_widget_message_text js-message_text">Zero fees for users.<br/>Someone still pays.</div>
  <a class="tgme_widget_message_date"><time datetime="2026-08-21T19:07:45+00:00"></time></a>
</div>
<div class="tgme_widget_message js-widget_message" data-post="c/2">
  <div class="tgme_widget_message_text js-message_text">One seed phrase &amp; eight networks.</div>
  <a class="tgme_widget_message_date"><time datetime="2026-08-22T10:00:00+00:00"></time></a>
</div>`;
const previewPosts = parseChannelPostTexts(preview);
check("preview yields both posts    ", previewPosts.length === 2);
check("preview keeps line breaks    ", previewPosts[0].text === "Zero fees for users.\nSomeone still pays.");
check("preview decodes entities     ", previewPosts[1].text === "One seed phrase & eight networks.");
check("preview keeps post times     ", previewPosts[0].at < previewPosts[1].at);

// ----------------------------------------------------------------- delivery

// A post that never arrives is the one failure this whole plugin exists to
// prevent, and Telegram is reached here through a flaky local proxy — so a
// transport failure is retried and a refusal from Telegram is not.
check(
  "a telegram refusal is final  ",
  isTelegramRefusal(new Error("telegram sendMessage 400: chat not found")),
);
check(
  "an aborted send is retried   ",
  !isTelegramRefusal(new DOMException("This operation was aborted", "AbortError")) &&
    !isTelegramRefusal(new Error("fetch failed")),
);

// ----------------------------------------------------------------- service

const dirs: string[] = [];
let calls = 0;

/** A press room over a throwaway data dir, a fixed plan and a mock writer. */
async function pressRoom(
  slots: ContentPlan["slots"],
  overrides: Record<string, string> = {},
  opts: { writerFails?: boolean; writerError?: string } = {},
): Promise<{ press: PressService; delivered: PressEvent[]; dir: string; writes: () => number }> {
  const dir = await mkdtemp(join(tmpdir(), "lainos-press-"));
  dirs.push(dir);
  const planPath = join(dir, "plan.json");
  const plan: ContentPlan = {
    ...shipped,
    slots,
    range: { from: slots[0].date, to: slots[slots.length - 1].date },
  };
  await writeFile(planPath, JSON.stringify(plan), "utf8");
  const settings: Record<string, string> = {
    LAINOS_DATA_DIR: dir,
    LAINOS_PRESS: "1",
    LAINOS_PRESS_PLAN: planPath,
    // Not a git repository: the material is unreadable and a post still gets written.
    LAINOS_PRESS_REPO: dir,
    LAINOS_PRESS_HOUR: "11",
    LAINOS_PRESS_REMIND_HOUR: "19",
    LAINOS_PRESS_MAX_PER_DAY: "2",
    LAINOS_PRESS_SPACING_MS: "1",
    LAINOS_PRESS_INTERVAL_MS: "3600000",
    LAINOS_PRESS_CHANNEL: "cyberia_network",
    ...overrides,
  };
  const runtime = {
    getSetting: (key: string) => settings[key],
    getService: () => undefined,
    model: {
      name: "mock",
      modelFor: () => "mock",
      async generate(_req: ModelRequest): Promise<ModelResponse> {
        calls += 1;
        if (opts.writerFails) throw new Error(opts.writerError ?? "codex timed out after 240s");
        return {
          text:
            "```\n" +
            `Draft ${calls} for the day.\n\nIt is long enough to be a real post, because a post ` +
            `under eighty characters is a mistake and not a post.\n\nWhich one?\n` +
            "```",
          toolCalls: [],
          model: "mock-writer",
          provider: "mock",
        };
      },
    },
  } as unknown as IAgentRuntime;

  const press = new PressService();
  const delivered: PressEvent[] = [];
  press.onEvent((ev) => delivered.push(ev));
  await press.start(runtime);
  return { press, delivered, dir, writes: () => calls };
}

const window = shipped.slots.filter((s) => s.date >= "2026-08-24" && s.date <= "2026-08-26");
const { press, delivered, dir } = await pressRoom(window);

check("plan loads from its setting  ", press.planLoaded);
check("the room owns its channel    ", press.covers("cyberia_network") && !press.covers("someone_else"));

await press.tick(new Date("2026-08-25T09:30:00"));
check("nothing before the hour      ", delivered.length === 0);

await press.tick(new Date("2026-08-25T12:00:00"));
check("the oldest owed day goes first", delivered.length === 1 && delivered[0].slot.date === "2026-08-24");
check("the fence never reaches the channel", !delivered[0].post.includes("```"));
check("the header is a separate message", delivered[0].header !== delivered[0].post);

await press.tick(new Date("2026-08-25T13:00:00"));
check("the backlog drains to today  ", delivered.length === 2 && delivered[1].slot.date === "2026-08-25");

await press.tick(new Date("2026-08-25T14:00:00"));
check("tomorrow is never written early", delivered.length === 2);

await press.tick(new Date("2026-08-25T20:00:00"));
check(
  "an unpublished post is repeated once",
  delivered.length === 3 && delivered[2].kind === "repeat" && delivered[2].slot.date === "2026-08-25",
);
await press.tick(new Date("2026-08-25T21:00:00"));
check("the repeat fires once a day  ", delivered.length === 3);
check(
  "a repeat is not a new delivery",
  press.recordOn("2026-08-25")?.deliveredAt === new Date("2026-08-25T13:00:00").getTime(),
);

await press.markPublished("2026-08-25");
check("publishing is recorded       ", Boolean(press.recordOn("2026-08-25")?.publishedAt));

await press.skip("2026-08-26");
check("a skipped day owes nothing   ", !press.pending("2026-08-26").some((s) => s.date === "2026-08-26"));
await press.tick(new Date("2026-08-26T20:00:00"));
check("a skipped day is neither written nor repeated", delivered.length === 3);

const stored = JSON.parse(await readFile(join(dir, "press.json"), "utf8"));
check("posts survive a restart      ", Boolean(stored.posts["2026-08-24"]?.text));
check("provenance is kept           ", stored.posts["2026-08-24"].model === "mock-writer");
await press.stop();

// A backlog deeper than the day's cap drains at the cap, not all at once.
const deep = [
  { date: "2026-08-23", day: "Вс", pillar: "Founder note", primary: "a", asset: "разбор", cta: "?" },
  ...window,
];
const flood = await pressRoom(deep, { LAINOS_PRESS_MAX_PER_DAY: "2" });
await flood.press.tick(new Date("2026-08-25T12:00:00"));
await flood.press.tick(new Date("2026-08-25T13:00:00"));
await flood.press.tick(new Date("2026-08-25T14:00:00"));
check(
  "a deep backlog drains at the cap",
  flood.delivered.length === 2 &&
    flood.delivered.map((e) => e.slot.date).join() === "2026-08-23,2026-08-24" &&
    flood.press.pending("2026-08-25").some((s) => s.date === "2026-08-25"),
);
await flood.press.stop();

// A post that was written but never reached the operator is re-sent, and is
// not written a second time — the transport failed, not the writer.
const lost = await pressRoom(window);
await lost.press.tick(new Date("2026-08-25T12:00:00"));
const wroteOnce = lost.writes();
await lost.press.markUndelivered("2026-08-24");
await lost.press.tick(new Date("2026-08-25T12:30:00"));
check(
  "a lost hand-over is re-sent  ",
  lost.delivered.length === 2 &&
    lost.delivered[1].slot.date === "2026-08-24" &&
    lost.delivered[1].post === lost.delivered[0].post,
);
check("re-sending costs no model call", lost.writes() === wroteOnce);
await lost.press.stop();

// A writer that cannot answer is said out loud once a day. Silence here reads
// exactly like a day with no work in it, which is what this room removes.
const mute = await pressRoom(window, {}, { writerFails: true });
await mute.press.tick(new Date("2026-08-25T12:00:00"));
await mute.press.tick(new Date("2026-08-25T13:00:00"));
const failures = mute.delivered.filter((e) => e.kind === "failed");
check(
  "a writer that fails says so  ",
  failures.length === 1 && failures[0].post === "" && failures[0].header.includes("240s"),
);
check("no draft escapes a failed write", mute.delivered.every((e) => e.kind === "failed"));
await mute.press.tick(new Date("2026-08-26T12:00:00"));
check(
  "a new day may say it again   ",
  mute.delivered.filter((e) => e.kind === "failed").length === 2,
);
await mute.press.stop();

// A refusal is read, not forwarded. The operator got two identical walls of
// `401 Unauthorized … cf-ray …` on consecutive mornings and still had to open
// the log to learn that codex on that host had never been signed in.
const at0440 = new Date("2026-09-07T04:40:00");
const limited = writerRefusal(
  new Error(
    "codex exited 1: You've hit your usage limit. Upgrade to Pro or try again at 11:33 AM.\n" +
      "    at ChildProcess.<anonymous> (/home/lain/lainos/src/models/codex.ts:183:25)",
  ),
  at0440,
);
check(
  "a usage window is read       ",
  limited.reason.includes("лимит") &&
    limited.retryAt === new Date("2026-09-07T11:33:00").getTime(),
);
check("a stack trace never travels  ", !limited.reason.includes("ChildProcess"));
check(
  "a host with no login says so ",
  (() => {
    const r = writerRefusal(
      new Error(
        "codex exited 1: ERROR: unexpected status 401 Unauthorized: Missing bearer or " +
          "basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a363c1c",
      ),
      at0440,
    );
    return r.reason.includes("не авторизован") && r.retryAt === undefined;
  })(),
);
check(
  "a window already past is tomorrow's",
  writerRefusal(new Error("rate limit — try again at 09:00"), new Date("2026-09-07T12:00:00"))
    .retryAt === new Date("2026-09-08T09:00:00").getTime(),
);
check(
  "a relative window counts too ",
  writerRefusal(new Error("429: try again in 15 minutes"), at0440).retryAt ===
    at0440.getTime() + 900_000,
);
check(
  "an unreadable refusal is quoted",
  (() => {
    const r = writerRefusal(new Error("something exploded"), at0440);
    return r.reason === "something exploded" && r.retryAt === undefined;
  })(),
);

// …and the hour it named is honoured: asking a rate-limited writer every
// quarter of an hour is how a stated window becomes a wall of failures.
const limited2 = await pressRoom(window, {}, {
  writerFails: true,
  writerError: "codex exited 1: You've hit your usage limit. try again at 15:00.",
});
await limited2.press.tick(new Date("2026-08-25T12:00:00"));
const triedOnce = limited2.writes();
check(
  "a stated window reaches the operator",
  limited2.delivered.some((e) => e.kind === "failed" && e.header.includes("15:00")),
);
await limited2.press.tick(new Date("2026-08-25T14:00:00"));
check("no retry inside a stated window", limited2.writes() === triedOnce);
await limited2.press.tick(new Date("2026-08-25T15:30:00"));
check("the window reopens the writer", limited2.writes() > triedOnce);
await limited2.press.stop();

// The calendar runs out; that is news, said once, not silence.
const over = await pressRoom(window);
await over.press.tick(new Date("2026-09-25T12:00:00"));
await over.press.tick(new Date("2026-09-26T12:00:00"));
check(
  "an exhausted plan says so once",
  over.delivered.length === 1 && over.delivered[0].kind === "plan_over" && over.delivered[0].post === "",
);
await over.press.stop();

for (const d of dirs) await rm(d, { recursive: true, force: true });

// ------------------------------------------------------------------ report

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed += 1;
  console.log(`${name.padEnd(38)}: ${pass ? "PASS" : "FAIL"}`);
}
console.log(failed ? `PRESS PROBE FAILED (${failed})` : "PRESS PROBE OK");
process.exit(failed ? 1 : 0);
