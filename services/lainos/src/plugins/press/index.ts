import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import {
  ModelTier,
  type Action,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type Service,
  type State,
} from "../../types.js";
import type { ChannelPost, ChannelWatchService } from "../channel/index.js";
import { resolveOperatorChatId } from "../telegram/index.js";
import { readCommits, commitsText, type Commit } from "./commits.js";
import {
  briefText,
  daysBetween,
  parsePlan,
  pendingSlots,
  planDay,
  planExhausted,
  slotFor,
  slotText,
  type ContentPlan,
  type PostSlot,
} from "./plan.js";

const log = createLogger("plugin:press");

/**
 * The press room: LainOS writes the day's post instead of reminding anyone to
 * write one.
 *
 * What it replaces is the point. The daemon used to deliver research digests
 * about other people's chains, a nightly restatement of an unchanged
 * portfolio, and an evening nudge that the channel was quiet — three messages
 * a day, none of which was the thing that had to happen. The thing that has to
 * happen is one post, published, every day, and the operator was two days
 * behind a written plan when this was built.
 *
 * So the queue is a *calendar* (`content-plan.json`, 24 August — 20 September),
 * the material is the repository's own commit log, and the output is the post
 * itself — finished English text the operator copies into the channel, which
 * mirrors to X. Nothing here publishes: this host holds no account session,
 * and a daemon that could post unattended is one that can embarrass the
 * project at 4am. Delivery is the deliverable.
 *
 * Three guards keep it from becoming the noise it replaced:
 *
 *  - **the channel is the truth.** A day the channel published is a day that
 *    needs nothing, and the evening repeat only fires when the draft it
 *    already sent is still unpublished.
 *  - **a backlog drains, it does not flood.** At most `MAX_PER_DAY` drafts a
 *    day, spaced hours apart, and a slot older than `BACKLOG_DAYS` is dropped
 *    rather than published stale.
 *  - **the post is one message.** The header and the text arrive separately,
 *    so "copy" on the post copies the post and nothing else.
 *
 * State lives in `data/press.json`; drafts are pushed through onEvent like
 * sentinel alerts.
 */

export interface PostRecord {
  /** Plan date this post answers, YYYY-MM-DD. */
  date: string;
  pillar: string;
  /** The post itself, ready to publish. */
  text: string;
  /** How many times it has been rewritten (an operator can ask again). */
  revision: number;
  writtenAt: number;
  model?: string;
  provider?: string;
  /** Commit subjects that fed it — provenance for "where did this come from". */
  material?: string[];
  deliveredAt?: number;
  /** Set when the channel published that day, or the operator said so. */
  publishedAt?: number;
  /** The operator dropped this day. */
  skipped?: boolean;
  /** Unix ms of the last failed attempt, so a broken writer backs off. */
  failedAt?: number;
  /**
   * Unix ms before which there is no point asking again. A flat half-hour is
   * the right wait for a writer that hiccupped and the wrong one for a writer
   * that said, in words, when it will answer again ("try again at 11:33 AM" —
   * a subscription CLI's usage window). When the refusal names an hour, that
   * hour is the wait.
   */
  retryAt?: number;
}

export interface PressEvent {
  /**
   * `draft` — a new post. `repeat` — one already sent and still unpublished.
   * `plan_over` — the calendar ran out; there is no post, only the news that
   * the queue is empty, said once. A plan that simply stops producing posts is
   * indistinguishable from a broken writer.
   */
  kind: "draft" | "repeat" | "plan_over" | "failed";
  /** Operator-facing line above the post; a separate Telegram message. */
  header: string;
  /** The post, alone, so copying the message copies exactly what is published. */
  post: string;
  slot: PostSlot;
  record: PostRecord;
  chatId?: number;
}

interface PressFile {
  posts: Record<string, PostRecord>;
  /** YYYY-MM-DD of the last evening repeat, so it fires at most once a day. */
  lastRepeatDay?: string;
  lastFailureDay?: string;
  /** Set once the operator has been told the calendar ran out. */
  planOverAnnounced?: string;
}

const DEFAULT_TICK_MS = 900_000; // 15 min
const DEFAULT_HOUR = 11;
const DEFAULT_REMIND_HOUR = 19;
const DEFAULT_MAX_PER_DAY = 2;
const DEFAULT_SPACING_MS = 14_400_000; // 4h
const DEFAULT_BACKLOG_DAYS = 3;
const RETRY_AFTER_MS = 1_800_000; // 30 min
// A daemon that boots (or wakes from suspend) after the post hour has already
// missed its slot: sweep once shortly after start rather than at the next
// quarter hour. The delay is for Telegram to come up first — a post delivered
// into a dead transport is a post the operator never sees.
const START_SWEEP_MS = 60_000;
const COMMIT_WINDOW_DAYS = 4;
const MIN_POST_CHARS = 80;

export class PressService implements Service {
  readonly name = "press";

  private runtime?: IAgentRuntime;
  private plan: ContentPlan | null = null;
  private planError: string | null = null;
  private posts: Record<string, PostRecord> = {};
  private lastRepeatDay?: string;
  private lastFailureDay?: string;
  private planOverAnnounced?: string;
  private file = "";
  private repo = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private startSweep: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private subscribers = new Set<(event: PressEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "press.json");
    // The material is this repository's own history: the daemon runs from
    // services/lainos inside it, so the git root is found by walking up.
    const repoSetting =
      runtime.getSetting("LAINOS_PRESS_REPO")?.trim() ||
      runtime.getSetting("LAINOS_FORGE_REPO")?.trim();
    this.repo = repoSetting ? resolve(repoSetting) : findGitRoot(process.cwd());

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as PressFile;
      this.posts = parsed.posts ?? {};
      this.lastRepeatDay = parsed.lastRepeatDay;
      this.lastFailureDay = parsed.lastFailureDay;
      this.planOverAnnounced = parsed.planOverAnnounced;
    } catch {
      // Fresh store.
    }

    const planPath = this.planPath();
    try {
      this.plan = parsePlan(await readFile(planPath, "utf8"));
    } catch (err) {
      this.planError = (err as Error).message;
      log.warn(`no usable content plan at ${planPath}: ${this.planError}`);
    }

    // Writing costs a model call and delivers to Telegram, so only the daemon
    // does it: a TUI session next to a running daemon must not write a second
    // post for the same day.
    const forced = runtime.getSetting("LAINOS_PRESS");
    const enabled =
      forced !== undefined && forced !== ""
        ? forced !== "0"
        : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (!enabled || !this.plan) {
      log.info(
        `press idle (${!this.plan ? "no plan" : "daemon-only; force with LAINOS_PRESS=1"}) — ` +
          `actions still answer on demand`,
      );
      return;
    }

    const tick = Number(runtime.getSetting("LAINOS_PRESS_INTERVAL_MS") ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => void this.tick(), Math.max(60_000, tick));
    this.timer.unref?.();
    this.startSweep = setTimeout(() => void this.tick(), START_SWEEP_MS);
    this.startSweep.unref?.();
    log.info(
      `press online: ${this.plan.slots.length} slots ${this.plan.range.from}…${this.plan.range.to}, ` +
        `posts after ${this.hour()}:00, up to ${this.maxPerDay()}/day, repo ${this.repo}`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.startSweep) clearTimeout(this.startSweep);
    this.timer = null;
    this.startSweep = null;
  }

  onEvent(fn: (event: PressEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // ------------------------------------------------------------- read model

  get planLoaded(): boolean {
    return Boolean(this.plan);
  }

  get planProblem(): string | null {
    return this.planError;
  }

  get contentPlan(): ContentPlan | null {
    return this.plan;
  }

  slotOn(day: string): PostSlot | undefined {
    return this.plan ? slotFor(this.plan, day) : undefined;
  }

  recordOn(day: string): PostRecord | undefined {
    return this.posts[day];
  }

  /** Slots still owing a post today, oldest first. */
  pending(day = planDay()): PostSlot[] {
    if (!this.plan) return [];
    return pendingSlots(this.plan, day, {
      done: (date) => {
        const rec = this.posts[date];
        return Boolean(rec && (rec.skipped || rec.text));
      },
      maxBacklogDays: this.backlogDays(),
    });
  }

  /**
   * The oldest slot inside the backlog window whose post is written but was
   * never handed over. Nothing to do with `pending()`, which asks whether a
   * post *exists*.
   */
  undelivered(day = planDay()): PostSlot | undefined {
    if (!this.plan) return undefined;
    return this.plan.slots.find((s) => {
      if (s.date > day || daysBetween(s.date, day) > this.backlogDays()) return false;
      const rec = this.posts[s.date];
      return Boolean(rec?.text && !rec.deliveredAt && !rec.skipped);
    });
  }

  /** Drafts delivered on a given host-local day. */
  deliveredOn(day: string): PostRecord[] {
    return Object.values(this.posts).filter(
      (r) => r.deliveredAt && planDay(new Date(r.deliveredAt)) === day,
    );
  }

  /**
   * Does the press room already own the daily post for this Telegram channel?
   * The channel watcher asks before nudging: a reminder to post, delivered
   * next to a finished post, is the noise this plugin exists to remove.
   */
  covers(channel: string): boolean {
    if (!this.plan || !this.timer) return false;
    const mine = (this.runtime?.getSetting("LAINOS_PRESS_CHANNEL") ?? this.plan.channel ?? "")
      .trim()
      .toLowerCase();
    return Boolean(mine) && mine === channel.trim().toLowerCase();
  }

  // ------------------------------------------------------------- write path

  /**
   * Write (or rewrite) the post for one slot. Returns the record; throws when
   * the model gives back nothing usable, so a caller can say why.
   */
  async write(slot: PostSlot, opts: { angle?: string } = {}): Promise<PostRecord> {
    const runtime = this.runtime;
    const plan = this.plan;
    if (!runtime || !plan) throw new Error("press has no runtime or no content plan");

    const commits = await this.material(slot.date);
    const published = await this.recentPublished();
    const system = writerSystemPrompt(plan);
    const user = writerBrief(plan, slot, commits, published, opts.angle);

    let text = "";
    let model = "";
    let provider = "";
    for (let attempt = 0; attempt < 2 && !text; attempt += 1) {
      const res = await runtime.model.generate({
        tier: ModelTier.LARGE,
        // A post is WRITE work: the operator routes that kind at the model
        // they trust with the public voice (LAINOS_TASK_WRITE).
        task: TaskKind.WRITE,
        system,
        messages: [{ role: "user", content: user }],
        maxTokens: 1600,
        temperature: 0.7,
      });
      const candidate = cleanPostText(res.text);
      if (candidate.length >= MIN_POST_CHARS) {
        text = candidate;
        model = res.model;
        provider = res.provider ?? "";
      } else {
        log.warn(`draft for ${slot.date} came back too short (${candidate.length} chars)`);
      }
    }
    if (!text) {
      const prev = this.posts[slot.date];
      this.posts[slot.date] = {
        ...(prev ?? { date: slot.date, pillar: slot.pillar, text: "", revision: 0, writtenAt: 0 }),
        failedAt: Date.now(),
      };
      await this.persist();
      throw new Error("the writer returned nothing usable");
    }

    const previous = this.posts[slot.date];
    const record: PostRecord = {
      date: slot.date,
      pillar: slot.pillar,
      text,
      revision: (previous?.revision ?? 0) + 1,
      writtenAt: Date.now(),
      model,
      provider: provider || undefined,
      material: commits.slice(0, 12).map((c) => c.subject),
      // A rewrite keeps the delivery/publication history of the day it answers.
      deliveredAt: previous?.deliveredAt,
      publishedAt: previous?.publishedAt,
    };
    this.posts[slot.date] = record;
    await this.persist();
    return record;
  }

  /**
   * Hand a finished post to the operator and mark the slot delivered. The
   * delivery is stamped with the *sweep's* clock, not the wall clock: the
   * day's cap and the spacing between drafts are both read back out of these
   * stamps, so a schedule that cannot be driven by a given `now` cannot be
   * tested at all.
   */
  async deliver(
    slot: PostSlot,
    record: PostRecord,
    opts: { kind?: PressEvent["kind"]; chatId?: number; at?: number } = {},
  ): Promise<void> {
    const kind = opts.kind ?? "draft";
    // Only a first hand-over is a delivery. A repeat re-sends what the
    // operator already has, so it must not restart the spacing clock or push
    // a backlog draft out by four hours.
    if (kind !== "repeat") record.deliveredAt = opts.at ?? Date.now();
    await this.persist();
    const event: PressEvent = {
      kind,
      header: headerFor(kind, slot, record),
      post: record.text,
      slot,
      record,
      chatId: opts.chatId ?? (await this.chatId()),
    };
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /**
   * The hand-over did not arrive (the transport was down, not Telegram saying
   * no). Take the delivery stamp back so the next sweep re-sends the post that
   * was already written, instead of counting a lost message against the day.
   */
  async markUndelivered(day: string): Promise<void> {
    const record = this.posts[day];
    if (!record?.deliveredAt) return;
    record.deliveredAt = undefined;
    await this.persist();
    log.warn(`${day} did not reach the operator — will be re-sent`);
  }

  /** The operator published it (or the channel says so). */
  async markPublished(day: string): Promise<PostRecord | undefined> {
    const record = this.posts[day];
    if (!record) return undefined;
    record.publishedAt = Date.now();
    await this.persist();
    return record;
  }

  /** Drop a day: it owes nothing and never joins a backlog. */
  async skip(day: string): Promise<PostSlot | undefined> {
    const slot = this.slotOn(day);
    if (!slot) return undefined;
    const previous = this.posts[day];
    this.posts[day] = {
      date: day,
      pillar: slot.pillar,
      text: previous?.text ?? "",
      revision: previous?.revision ?? 0,
      writtenAt: previous?.writtenAt ?? Date.now(),
      skipped: true,
    };
    await this.persist();
    return slot;
  }

  // --------------------------------------------------------------- schedule

  /** One sweep. Exposed so a test (or an operator) can drive it directly. */
  async tick(now = new Date()): Promise<PostRecord | null> {
    if (this.busy || !this.plan) return null;
    this.busy = true;
    try {
      const day = planDay(now);
      await this.syncPublished(day);
      if (planExhausted(this.plan, day)) {
        await this.announcePlanOver(day);
        return null;
      }
      if (now.getHours() < this.hour()) return null;

      const delivered = this.deliveredOn(day);
      const lastAt = delivered.reduce((max, r) => Math.max(max, r.deliveredAt ?? 0), 0);
      const spaced = !lastAt || now.getTime() - lastAt >= this.spacingMs();

      // A draft that exists but never reached the operator is re-sent first:
      // it is already written, so re-writing it would spend a model call to
      // produce a second post for a day that owes one.
      const lost = this.undelivered(day);
      if (lost) {
        const record = this.posts[lost.date];
        if (record) {
          await this.deliver(lost, record, { at: now.getTime() });
          log.info(`post for ${lost.date} re-sent after a failed hand-over`);
          return record;
        }
      }

      if (delivered.length < this.maxPerDay() && spaced) {
        const slot = this.pending(day)[0];
        if (slot) {
          const prev = this.posts[slot.date];
          const notBefore =
            prev?.retryAt ?? (prev?.failedAt ? prev.failedAt + RETRY_AFTER_MS : 0);
          if (notBefore && now.getTime() < notBefore) return null;
          let record: PostRecord;
          try {
            record = await this.write(slot);
          } catch (err) {
            // The writer is unreachable or gave back nothing. Saying so costs
            // one message a day; saying nothing looks exactly like a day with
            // no work in it, which is the failure this room was built to end.
            await this.announceFailure(day, slot, err, now);
            return null;
          }
          await this.deliver(slot, record, { at: now.getTime() });
          log.info(`post for ${slot.date} delivered (${record.text.length} chars)`);
          return record;
        }
      }

      // Nothing new to write: if today's post is out there unpublished and the
      // evening has come, say so once — with the post attached, never alone.
      if (now.getHours() >= this.remindHour() && this.lastRepeatDay !== day) {
        const slot = this.slotOn(day);
        const record = slot ? this.posts[slot.date] : undefined;
        if (slot && record?.text && record.deliveredAt && !record.publishedAt && !record.skipped) {
          this.lastRepeatDay = day;
          await this.deliver(slot, record, { kind: "repeat", at: now.getTime() });
          return record;
        }
      }
      return null;
    } catch (err) {
      log.warn("press tick failed", err);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Say once a day that the post could not be written, in words, and write
   * down when it is worth asking again.
   *
   * The wait is recorded even when the message is suppressed as a repeat:
   * saying it twice is noise, but retrying against a window that has not
   * reopened is the loop that produced two identical 401 walls on consecutive
   * mornings.
   */
  private async announceFailure(
    day: string,
    slot: PostSlot,
    err: unknown,
    at: Date = new Date(),
  ): Promise<void> {
    log.warn(`could not write the post for ${slot.date}`, err);
    // The sweep's clock, not the wall clock: the reopening hour is read out of
    // the refusal against the same `now` the schedule is driven by, so a
    // window can be tested without waiting for one.
    const now = at.getTime();
    const { reason, retryAt } = writerRefusal(err, at);
    // A writer that throws (a CLI exiting non-zero) never reached the branch
    // in `write()` that records a failure, so the day had no record at all and
    // nothing to back off from — every tick asked again. Write it here.
    const record = this.posts[slot.date] ?? {
      date: slot.date,
      pillar: slot.pillar,
      text: "",
      revision: 0,
      writtenAt: 0,
    };
    record.failedAt = now;
    record.retryAt = retryAt;
    this.posts[slot.date] = record;
    const first = this.lastFailureDay !== day;
    if (first) this.lastFailureDay = day;
    await this.persist();
    if (!first) return;
    const again = retryAt
      ? `попробую после ${formatClock(new Date(retryAt))}`
      : "повторю через полчаса";
    const header =
      `\u26A0 не смогла написать пост на ${slot.date.slice(8)}.${slot.date.slice(5, 7)} ` +
      `(${slot.pillar}).\n${reason}\n${again} — или скажи «напиши пост», ` +
      `и я попробую сейчас.`;
    const chatId = await this.chatId();
    for (const fn of this.subscribers) {
      try {
        fn({
          kind: "failed",
          header,
          post: "",
          slot,
          record: this.posts[slot.date] ?? {
            date: slot.date,
            pillar: slot.pillar,
            text: "",
            revision: 0,
            writtenAt: Date.now(),
          },
          chatId,
        });
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /** Say once that the calendar has run out, rather than going quiet. */
  private async announcePlanOver(day: string): Promise<void> {
    if (!this.plan || this.planOverAnnounced) return;
    this.planOverAnnounced = day;
    await this.persist();
    const header =
      `\u{1F4CB} контент-план закончился ${this.plan.range.to} — постов по расписанию больше нет.\n` +
      `следующий месяц — новый content-plan.json (или скажи, и я напишу пост под твою тему).`;
    const chatId = await this.chatId();
    for (const fn of this.subscribers) {
      try {
        fn({
          kind: "plan_over",
          header,
          post: "",
          slot: this.plan.slots[this.plan.slots.length - 1],
          record: { date: day, pillar: "", text: "", revision: 0, writtenAt: Date.now() },
          chatId,
        });
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /**
   * The channel is the ground truth for "did it go out". A day the watched
   * channel published is a day whose post is considered published — the
   * operator is not asked to also tell us.
   */
  private async syncPublished(day: string): Promise<void> {
    const record = this.posts[day];
    if (!record?.text || record.publishedAt || record.skipped) return;
    const channel = this.channelName();
    const svc = this.runtime?.getService<ChannelWatchService>("channel-watch");
    if (!channel || !svc) return;
    const activity = await svc.activityToday(channel);
    if (activity && activity.postsToday > 0) {
      record.publishedAt = Date.now();
      await this.persist();
      log.info(`${channel} published today — ${day} closed`);
    }
  }

  /** Commits since the last post went out, so a post never repeats material. */
  private async material(date: string): Promise<Commit[]> {
    const previous = Object.values(this.posts)
      .filter((r) => r.date < date && r.text)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const days = previous
      ? Math.min(COMMIT_WINDOW_DAYS * 2, Math.max(1, daysSince(previous.date) + 1))
      : COMMIT_WINDOW_DAYS;
    try {
      return await readCommits(this.repo, { sinceDays: days });
    } catch (err) {
      log.warn(`could not read commits from ${this.repo}`, err);
      return [];
    }
  }

  /** The last few posts as published, so the writer does not repeat itself. */
  private async recentPublished(): Promise<string[]> {
    const channel = this.channelName();
    const svc = this.runtime?.getService<ChannelWatchService>("channel-watch");
    if (channel && svc) {
      try {
        const posts = await svc.recentPosts(channel);
        if (posts?.length) return posts.slice(-5).map((p: ChannelPost) => p.text);
      } catch (err) {
        log.warn(`could not read t.me/${channel}`, err);
      }
    }
    // Fall back on what we wrote ourselves — weaker (it may never have been
    // published) but enough to stop two identical drafts in a row.
    return Object.values(this.posts)
      .filter((r) => r.text)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map((r) => r.text);
  }

  // -------------------------------------------------------------- internals

  private planPath(): string {
    const raw = this.runtime?.getSetting("LAINOS_PRESS_PLAN")?.trim();
    if (raw) return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    return resolve(process.cwd(), "content-plan.json");
  }

  private channelName(): string {
    return (
      this.runtime?.getSetting("LAINOS_PRESS_CHANNEL")?.trim() ||
      this.plan?.channel?.trim() ||
      ""
    );
  }

  /**
   * Where a draft goes. The same resolution every other background service
   * uses — an explicit setting, then the allowlist, then the one known private
   * chat — so a post lands where the alerts and the heartbeat already land.
   */
  private async chatId(): Promise<number | undefined> {
    const runtime = this.runtime;
    const explicit = runtime?.getSetting("LAINOS_PRESS_CHAT_ID")?.trim();
    const raw = explicit || (runtime ? await resolveOperatorChatId((k) => runtime.getSetting(k)) : null);
    const id = Number(raw);
    return Number.isFinite(id) && id !== 0 ? id : undefined;
  }

  private hour(): number {
    return clampHour(Number(this.runtime?.getSetting("LAINOS_PRESS_HOUR") ?? DEFAULT_HOUR), DEFAULT_HOUR);
  }

  private remindHour(): number {
    return clampHour(
      Number(this.runtime?.getSetting("LAINOS_PRESS_REMIND_HOUR") ?? DEFAULT_REMIND_HOUR),
      DEFAULT_REMIND_HOUR,
    );
  }

  private maxPerDay(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_MAX_PER_DAY") ?? DEFAULT_MAX_PER_DAY);
    return Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.round(raw))) : DEFAULT_MAX_PER_DAY;
  }

  private spacingMs(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_SPACING_MS") ?? DEFAULT_SPACING_MS);
    return Number.isFinite(raw) ? Math.max(600_000, raw) : DEFAULT_SPACING_MS;
  }

  private backlogDays(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_BACKLOG_DAYS") ?? DEFAULT_BACKLOG_DAYS);
    return Number.isFinite(raw) ? Math.min(14, Math.max(0, Math.round(raw))) : DEFAULT_BACKLOG_DAYS;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: PressFile = {
      posts: this.posts,
      lastRepeatDay: this.lastRepeatDay,
      lastFailureDay: this.lastFailureDay,
      planOverAnnounced: this.planOverAnnounced,
    };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ prompts

/**
 * The writer's standing instructions. Everything here is a rule the strategy
 * report drew from fifty real posts, plus the one rule this house has always
 * had: a post is for the person using the thing, never for the person who
 * built it.
 */
export function writerSystemPrompt(plan: ContentPlan): string {
  const lang = plan.language === "en" ? "English" : plan.language;
  return [
    `You write the public posts for Cyberia (${plan.account ?? "@cyberia_temple"} on X, mirrored`,
    `to its Telegram channel). What you produce is published as written — it is the post itself,`,
    `not a draft to be discussed, and no one edits it after you.`,
    ``,
    `WHO READS IT: people who might use a wallet, and people who might hold the token.`,
    `Never developers. A reader who has never seen code must get everything the post carries.`,
    ``,
    `THE POST`,
    `- Write it in ${lang}. The brief below is in Russian; the post is in ${lang}.`,
    `- One idea. Open with a claim, a problem or a question a person recognises — never with a`,
    `  version number, never with a list of features, never with "we shipped".`,
    `- State every change as what a person can now do, or no longer has to do.`,
    `- Never name a library, a file, a class, a framework, a migration, a test, an endpoint or an`,
    `  internal service. Never write "refactored", "rewrote", "under the hood", "backend". If a`,
    `  change cannot be told without them, tell its consequence instead.`,
    `- Concrete beats adjective: a number, a step, a before and after. No "seamless", "powerful",`,
    `  "revolutionary", "excited to announce".`,
    `- Short lines with a blank line between them. No hashtags. No emoji decoration. No markdown:`,
    `  no bold, no headers, no bullet characters other than a plain "•" where a list truly helps.`,
    `- Length is free — a long post is fine when every line earns its place. Most posts want three`,
    `  to eight short beats; one line is only enough when that line is the whole idea.`,
    `- End with exactly one question: a binary choice, a specific edge case, or a promise to build`,
    `  whichever answer wins. Never "thoughts?", never "what do you think?".`,
    `- Do not describe the attachment in the text; the operator attaches it separately. The asset`,
    `  named in the brief is the plan's suggestion, not a constraint — if the honest evidence for`,
    `  the day's thesis is a different one, write that and let the operator attach what fits.`,
    `- Invent nothing. No number, date, name, partner, integration or feature that is not in the`,
    `  material below. Thin material means a thesis without evidence, never invented evidence.`,
    ``,
    `OUTPUT: the post text and nothing else. No preamble, no title, no surrounding quotes, no code`,
    `fence, no sign-off, no notes about what you did.`,
  ].join("\n");
}

/** The day's assignment plus everything true that could feed it. */
export function writerBrief(
  plan: ContentPlan,
  slot: PostSlot,
  commits: Commit[],
  published: string[],
  angle?: string,
): string {
  const parts = [`СЕГОДНЯШНИЙ СЛОТ ПЛАНА:\n${slotText(slot)}`, `СТАНДАРТНЫЙ БРИФ:\n${briefText(plan)}`];
  const material = commitsText(commits);
  parts.push(
    material
      ? `ЧТО РЕАЛЬНО СДЕЛАНО ЗА ПОСЛЕДНИЕ ДНИ (коммиты репозитория — это сырьё, а не текст для\n` +
          `публикации; выбери из него то, что видит пользователь, и переведи на человеческий язык):\n${material}`
      : `ЧТО РЕАЛЬНО СДЕЛАНО ЗА ПОСЛЕДНИЕ ДНИ: новых коммитов нет — пиши тезис дня без ссылки на\n` +
          `свежую работу и ничего не выдумывай.`,
  );
  if (published.length) {
    parts.push(
      `ПОСЛЕДНИЕ ОПУБЛИКОВАННЫЕ ПОСТЫ (не повторяй ни мысль, ни первую строку):\n` +
        published.map((p) => `---\n${p.slice(0, 700)}`).join("\n"),
    );
  }
  if (angle?.trim()) parts.push(`ОТДЕЛЬНОЕ УКАЗАНИЕ ОПЕРАТОРА: ${angle.trim()}`);
  return parts.join("\n\n");
}

/**
 * Strip everything a chat model wraps an answer in. The post is pasted into a
 * channel by a human who should not have to delete a "Here's your post:" line
 * first — and a stray code fence would publish as a literal backtick.
 */
export function cleanPostText(raw: string): string {
  let text = raw.trim();
  // A fenced block: take what is inside it.
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();
  // A preamble line ("Here's the post:", "Вот пост:") followed by a blank line.
  const preamble =
    /^(?:[^\n]{0,120}(?:here'?s|here is|below is|draft|вот|держи|готов)[^\n]{0,120}:)\s*\n+/i;
  if (preamble.test(text)) text = text.replace(preamble, "").trim();
  // Wrapping quotes around the whole thing.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("«") && text.endsWith("»")) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Markdown emphasis the channel would render as literal asterisks.
  text = text.replace(/^#{1,6}\s+/gm, "");
  return text.trim();
}

/** The operator-facing line above a delivered post. */
export function headerFor(kind: PressEvent["kind"], slot: PostSlot, record: PostRecord): string {
  const when = `${slot.date.slice(8, 10)}.${slot.date.slice(5, 7)}`;
  const by = record.provider ? ` · ${record.provider}` : "";
  if (kind === "repeat") {
    return (
      `📝 пост на ${when} всё ещё не опубликован — вот он ещё раз.\n` +
      `материал: ${slot.asset}`
    );
  }
  return (
    `📝 пост на ${when} · ${slot.pillar}${by}\n` +
    `по плану к нему: ${slot.asset}\n` +
    `следующим сообщением — текст, копируется целиком.`
  );
}

/**
 * What a refusal from the writer actually said, and when to ask again.
 *
 * A writer is a CLI, and a CLI that will not answer says why in prose meant
 * for a terminal: a stack trace, a 401 with a cf-ray, a usage window with the
 * hour it reopens. Forwarding that verbatim into Telegram is how the operator
 * got two identical walls of `unexpected status 401 Unauthorized … cf-ray …`
 * on two consecutive mornings and still had to read the log to learn that
 * codex on that host had never been signed in.
 *
 * Two facts are worth extracting and nothing else is:
 *
 *  - **which kind of no it is** — out of credentials for now (it will answer
 *    later), or not allowed to ask at all (it will never answer here, and the
 *    operator has to do something);
 *  - **when it reopens**, when the refusal names an hour. A subscription CLI
 *    that says "try again at 11:33 AM" has told us exactly how long the flat
 *    half-hour retry will keep failing.
 *
 * Pure, and takes its clock, so every branch is testable without waiting.
 */
export function writerRefusal(
  raw: unknown,
  now: Date = new Date(),
): { reason: string; retryAt?: number } {
  const text = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (!text) return { reason: "писатель не ответил" };

  // A stack trace says nothing an operator can act on.
  const body = text
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const retryAt = parseRetryHour(body, now);
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(body)) {
    const when = retryAt ? ` до ${formatClock(new Date(retryAt))}` : "";
    return { reason: `писатель упёрся в лимит${when}`, retryAt };
  }
  if (/\b401\b|unauthorized|missing bearer|not logged in|no credentials|please run .*login/i.test(body)) {
    // Nothing here reopens on its own: this host has no session at all.
    return { reason: "писатель не авторизован на этой машине" };
  }
  const short = body.length > 200 ? `${body.slice(0, 199)}…` : body;
  return { reason: short, retryAt };
}

/** "try again at 11:33 AM" / "resets at 15:04" → the next such moment. */
function parseRetryHour(text: string, now: Date): number | undefined {
  const relative = text.match(/try again in (\d{1,3}) (second|minute|hour)s?/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
    return now.getTime() + amount * ms;
  }
  const match = text.match(/(?:try again|resets?|available again|retry) at (\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  // A window that already passed today is tomorrow's, not the past.
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function formatClock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ helpers

function findGitRoot(from: string): string {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

function clampHour(hour: number, fallback: number): number {
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : fallback;
}

function daysSince(date: string): number {
  const then = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

function getPress(runtime: IAgentRuntime): PressService {
  const svc = runtime.getService<PressService>("press");
  if (!svc) throw new Error("press service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

/** "сегодня", "завтра", "25.08", "2026-08-25" → a plan date. */
export function resolveDay(raw: string | undefined, today = planDay()): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || /^(сегодня|today)$/.test(value)) return today;
  if (/^(завтра|tomorrow)$/.test(value)) return shiftDay(today, 1);
  if (/^(вчера|yesterday)$/.test(value)) return shiftDay(today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dotted = value.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{4}))?$/);
  if (dotted) {
    const year = dotted[3] ?? today.slice(0, 4);
    return `${year}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
  }
  return today;
}

function shiftDay(day: string, delta: number): string {
  const at = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + delta * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ actions

const writePostAction: Action = {
  name: "write_post",
  similes: ["draft_post", "make_post", "напиши_пост", "post_now", "write_tweet"],
  description:
    "Write the public post for one day of the content plan and send it to the operator ready to publish. Use whenever the operator asks for a post, a tweet, or the post for today — the post is assembled from the day's slot in the plan plus what the repository actually shipped. Optionally takes a date ('сегодня', '26.08') and an angle the operator wants taken. The finished text is delivered as its own message; do not retype it in your reply.",
  parameters: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "Which day of the plan: 'сегодня' (default), 'завтра', '26.08', '2026-08-26'.",
      },
      angle: {
        type: "string",
        description: "Optional instruction from the operator: what to stress, what to avoid.",
      },
    },
  },
  examples: [
    { user: "напиши пост на сегодня", agent: "пишу пост по плану на сегодня…" },
    {
      user: "сделай пост про мост, но по-человечески",
      agent: "пишу — тезис дня плюс то, что реально уехало в мост.",
    },
  ],
  async validate(runtime) {
    const svc = runtime.getService<PressService>("press");
    return Boolean(svc?.planLoaded);
  },
  async handler(runtime, state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const slot = svc.slotOn(day);
    if (!slot) {
      const plan = svc.contentPlan;
      return {
        ok: false,
        text: plan
          ? `The content plan covers ${plan.range.from}…${plan.range.to} and has no slot for ${day}.`
          : `No content plan is loaded${svc.planProblem ? ` (${svc.planProblem})` : ""}.`,
      };
    }
    let record;
    try {
      record = await svc.write(slot, { angle: params.angle ? String(params.angle) : undefined });
    } catch (err) {
      return { ok: false, text: `Couldn't write the post: ${(err as Error).message}` };
    }
    await svc.deliver(slot, record, { chatId: chatIdFromState(state) });
    return {
      ok: true,
      text:
        `The post for ${day} (${slot.pillar}) has already been sent to the operator as its own ` +
        `message, ready to copy. Do not repeat it — just say it is there, in one short line.`,
      data: { date: day, pillar: slot.pillar, chars: record.text.length, revision: record.revision },
    };
  },
};

const postPlanAction: Action = {
  name: "post_plan",
  similes: ["content_plan", "what_to_post", "план_постов", "post_schedule"],
  description:
    "Show what the content plan says: today's slot, what is still owed, and whether today's post has been written, sent or published. Use when the operator asks what to post, what's planned, or how far behind the plan we are.",
  parameters: {
    type: "object",
    properties: {
      days: { type: "number", description: "How many upcoming days to list. Default 3." },
    },
  },
  examples: [{ user: "что по плану постов?", agent: "смотрю план…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("press"));
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const plan = svc.contentPlan;
    if (!plan) {
      return { ok: false, text: `No content plan loaded${svc.planProblem ? `: ${svc.planProblem}` : "."}` };
    }
    const today = planDay();
    const ahead = Math.min(7, Math.max(1, Number(params.days) || 3));
    const upcoming = plan.slots.filter((s) => s.date >= today).slice(0, ahead);
    const owed = svc.pending(today);
    const lines = upcoming.map((s) => {
      const rec = svc.recordOn(s.date);
      const state = rec?.publishedAt
        ? "опубликован"
        : rec?.skipped
          ? "пропущен"
          : rec?.deliveredAt
            ? "написан, ждёт публикации"
            : rec?.text
              ? "написан"
              : "не написан";
      return `${s.date} ${s.day} · ${s.pillar} — ${s.primary} [${state}]`;
    });
    return {
      ok: true,
      text:
        [
          `План: ${plan.title} (${plan.range.from}…${plan.range.to}).`,
          ...lines,
          owed.length
            ? `Ещё не написано: ${owed.map((s) => s.date).join(", ")}.`
            : `Долгов по плану нет.`,
        ].join("\n"),
      data: {
        today,
        owed: owed.map((s) => s.date),
        upcoming: upcoming.map((s) => ({ date: s.date, pillar: s.pillar, primary: s.primary })),
      },
    };
  },
};

const markPostPublishedAction: Action = {
  name: "mark_post_published",
  similes: ["post_published", "опубликовал", "already_posted_it", "post_is_out"],
  description:
    "Record that the operator has published the post for a day, so it is not repeated in the evening. Only needed when the post went somewhere the channel does not show — a post in the watched Telegram channel is noticed by itself.",
  parameters: {
    type: "object",
    properties: { date: { type: "string", description: "Which day. Default today." } },
  },
  examples: [{ user: "опубликовала пост", agent: "записала, вечером напоминать не буду." }],
  async validate(runtime) {
    return Boolean(runtime.getService("press"));
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const record = await svc.markPublished(day);
    return record
      ? { ok: true, text: `Marked the post for ${day} as published.`, data: { date: day } }
      : { ok: false, text: `There is no written post for ${day}.` };
  },
};

const skipPostAction: Action = {
  name: "skip_post",
  similes: ["skip_day", "пропусти_пост", "no_post_today"],
  description:
    "Drop one day of the content plan: nothing is written for it and it never joins the backlog. Use when the operator says there will be no post that day.",
  parameters: {
    type: "object",
    properties: { date: { type: "string", description: "Which day. Default today." } },
  },
  examples: [{ user: "сегодня без поста", agent: "поняла, сегодняшний слот закрыт." }],
  async validate(runtime) {
    const svc = runtime.getService<PressService>("press");
    return Boolean(svc?.planLoaded);
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const slot = await svc.skip(day);
    return slot
      ? { ok: true, text: `Skipped ${day} (${slot.pillar}).`, data: { date: day } }
      : { ok: false, text: `The plan has no slot for ${day}.` };
  },
};

// ----------------------------------------------------------------- provider

const pressProvider: Provider = {
  name: "press",
  async get(runtime) {
    const svc = runtime.getService<PressService>("press");
    if (!svc) return "";
    const plan = svc.contentPlan;
    if (!plan) {
      return svc.planProblem
        ? `The content plan could not be read (${svc.planProblem}); write_post cannot run until it is fixed.`
        : "";
    }
    const today = planDay();
    const slot = svc.slotOn(today);
    const record = slot ? svc.recordOn(today) : undefined;
    const owed = svc.pending(today);
    const state = record?.publishedAt
      ? "already published"
      : record?.deliveredAt
        ? "written and sent to the operator, not published yet"
        : record?.skipped
          ? "skipped by the operator"
          : "not written yet";
    return (
      `You write the account's daily post yourself — that is your job now, not reminding anyone ` +
      `to write one. Today (${today}) the plan says: ${slot ? `${slot.pillar} — ${slot.primary}` : "nothing (the plan does not cover today)"}. ` +
      `Status: ${state}.` +
      (owed.length ? ` Days still owing a post: ${owed.map((s) => s.date).join(", ")}.` : "") +
      ` Use write_post to write one (it delivers the finished text itself — never retype it), ` +
      `post_plan to say what is scheduled, mark_post_published when the operator says it is out, ` +
      `skip_post when a day is dropped. Never invent what a post said or claim one was published.`
    );
  },
};

export const pressPlugin: Plugin = {
  name: "press",
  description:
    "The press room: writes the day's public post from the content plan and what the repository actually shipped, delivers it ready to publish, and knows from the channel whether it went out.",
  services: [new PressService()],
  providers: [pressProvider],
  actions: [writePostAction, postPlanAction, markPostPublishedAction, skipPostAction],
};

export { parsePlan, pendingSlots, planDay, slotFor } from "./plan.js";
export type { ContentPlan, PostSlot } from "./plan.js";
export { parseGitLog, commitsText, readCommits } from "./commits.js";
export type { Commit } from "./commits.js";
