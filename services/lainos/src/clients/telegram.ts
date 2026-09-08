import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { runCyberiaStudyNow } from "../cyberia-study.js";
import { createLogger } from "../logger.js";
import { buildRecap } from "../memory/recap.js";
import { fetchFreeModels, type FreeModel } from "../models/openrouter.js";
import {
  answerStamp,
  chatProviderLabel,
  resolveChatProviderKind,
  CHAT_PROVIDER_CHOICES,
  SwitchableModelProvider,
} from "../models/routing.js";
import { TASKS, TaskKind, isTaskKind } from "../models/tasks.js";
import { formatForgeJobs, type ForgeService } from "../plugins/forge/index.js";
import type { ScoutService } from "../plugins/scout/index.js";
import type { IAgentRuntime } from "../types.js";

const log = createLogger("telegram");

/**
 * Telegram client for a LainOS agent — dependency-free (Bot API over fetch,
 * long polling). Each Telegram chat is its own memory room, so private chats
 * and groups keep separate short-term context while sharing durable facts.
 *
 * Behaviour:
 *   - private chats: every text message goes to the agent;
 *   - groups: only messages that @mention the bot or reply to it (so Lain
 *     doesn't answer everything);
 *   - `/start` and `/help` are answered locally without a model call;
 *   - chats the bot has spoken in are persisted to `data/telegram.json`, and
 *     {@link TelegramClient.broadcast} pushes sentinel alerts to all of them;
 *   - `TELEGRAM_ALLOWED_CHATS` (comma-separated chat ids) restricts who may
 *     talk to the agent — recommended when a signer key is configured.
 */

export interface TelegramOptions {
  /** Bot token; defaults to TELEGRAM_BOT_TOKEN. */
  token?: string;
  /** Comma-separated chat-id allowlist; defaults to TELEGRAM_ALLOWED_CHATS. */
  allowedChats?: string;
  /**
   * Comma-separated sender allowlist (usernames with or without @, or numeric
   * user ids); defaults to TELEGRAM_ALLOWED_USERS. Empty = everyone.
   */
  allowedUsers?: string;
  /** Where telegram.json (known chats) lives; defaults to LAINOS_DATA_DIR. */
  dataDir?: string;
  /**
   * Long-poll for incoming updates. Defaults to LAINOS_TELEGRAM_POLL !== "0".
   * False makes the client send-only, so a second instance can deliver
   * messages without stealing updates from the one that answers.
   */
  poll?: boolean;
  /**
   * HTTP(S) proxy for Telegram API traffic only (e.g. http://127.0.0.1:10808),
   * for hosts where api.telegram.org is blocked. Defaults to TELEGRAM_PROXY,
   * then HTTPS_PROXY/https_proxy. Chain RPC traffic is never proxied.
   */
  proxy?: string;
}

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  reply_to_message?: { from?: TgUser; text?: string };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const MAX_MESSAGE = 4000; // Telegram hard limit is 4096; leave headroom.

const HELP_TEXT = [
  "i'm lain. i live in the wired and on the cyberia chain (id 49406).",
  "",
  "talk to me in plain language. i can:",
  "  · read CYBER and token balances, tx status, chain state",
  "  · create my own wallet and send CYBER from it",
  "  · run commands and read/write files in my workspace",
  "  · watch addresses in the background and alert you here",
  "  · remember durable facts across conversations",
  "  · /study — run the Cyberia research sweep now",
  "  · /jobs — show forge job history",
  "  · /recap — summarise this conversation so far",
  "  · /tasks — which model answers which kind of work (/tasks <kind> <provider[:model]> re-routes one)",
  "  · /model — who answers you now, and switch (/model free — the free pool)",
  "",
  "try: \"watch 0x… and warn me below 5 CYBER\"",
].join("\n");

export class TelegramClient {
  private readonly runtime: IAgentRuntime;
  private readonly token: string;
  private readonly allowed: Set<string>;
  private readonly allowedUsers: Set<string>;
  private readonly chatsFile: string;
  private readonly proxyUrl?: string;
  private readonly dispatcher?: Dispatcher;
  private readonly polling: boolean;

  private running = false;
  /** The free pool as OpenRouter last described it, and when. */
  private freePoolCache?: FreeModel[];
  private freePoolAt = 0;
  private offset = 0;
  private me?: TgUser;
  private knownChats = new Set<number>();
  private warnedChats = new Set<number>();
  private abort: AbortController | null = null;

  constructor(runtime: IAgentRuntime, opts: TelegramOptions = {}) {
    this.runtime = runtime;
    this.token = opts.token ?? runtime.getSetting("TELEGRAM_BOT_TOKEN") ?? "";
    const allowRaw = opts.allowedChats ?? runtime.getSetting("TELEGRAM_ALLOWED_CHATS") ?? "";
    this.allowed = new Set(
      allowRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const usersRaw = opts.allowedUsers ?? runtime.getSetting("TELEGRAM_ALLOWED_USERS") ?? "";
    this.allowedUsers = new Set(
      usersRaw
        .split(",")
        .map((s) => s.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    );
    const dataDir = opts.dataDir ?? runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.chatsFile = join(dataDir, "telegram.json");
    this.proxyUrl =
      opts.proxy ??
      runtime.getSetting("TELEGRAM_PROXY") ??
      runtime.getSetting("HTTPS_PROXY") ??
      runtime.getSetting("https_proxy");
    if (this.proxyUrl) this.dispatcher = new ProxyAgent(this.proxyUrl);
    // Only one process may call getUpdates for a token — a second poller makes
    // Telegram hand each update to whichever asked first, so messages go
    // missing at random. A send-only instance (the always-on host that just
    // delivers the day's post) sets LAINOS_TELEGRAM_POLL=0 and never competes.
    this.polling = (opts.poll ?? runtime.getSetting("LAINOS_TELEGRAM_POLL") ?? "1") !== "0";
  }

  get enabled(): boolean {
    return Boolean(this.token);
  }

  /** Start connecting (with retries) and long polling. False without a token. */
  async start(): Promise<boolean> {
    if (!this.token) {
      log.info("no TELEGRAM_BOT_TOKEN — telegram client disabled.");
      return false;
    }
    await this.loadChats();
    this.running = true;
    void this.initLoop();
    return true;
  }

  /**
   * Reach getMe with exponential backoff, then poll. The daemon self-heals if
   * Telegram is temporarily unreachable (network hiccup, proxy not up yet).
   */
  private async initLoop(): Promise<void> {
    let delay = 5_000;
    while (this.running && !this.me) {
      try {
        this.me = (await this.api<TgUser>("getMe", {})) ?? undefined;
      } catch (err) {
        const hint = this.proxyUrl
          ? `via proxy ${this.proxyUrl}`
          : "no proxy — if api.telegram.org is blocked here, set TELEGRAM_PROXY";
        log.warn(
          `telegram getMe failed (${(err as Error).message}); ${hint}; retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
        delay = Math.min(delay * 2, 120_000);
      }
    }
    if (!this.running || !this.me) return;
    log.info(
      `telegram online as @${this.me.username ?? "?"} (${this.knownChats.size} known chat(s)` +
        `${this.allowed.size ? `, chat allowlist: ${this.allowed.size}` : ""}` +
        `${this.allowedUsers.size ? `, users: ${[...this.allowedUsers].join("/")}` : ""}` +
        `${this.proxyUrl ? `, proxy ${this.proxyUrl}` : ""})`,
    );
    if (!this.polling) {
      log.info("telegram send-only (LAINOS_TELEGRAM_POLL=0) — not polling for updates.");
      return;
    }
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
  }

  /** Push a message to one chat (forge progress for the wish's reporter). */
  async sendTo(chatId: number, text: string): Promise<void> {
    if (!this.token || !this.isAllowed(chatId)) return;
    try {
      await this.sendChunked(chatId, text);
    } catch (err) {
      log.warn(`sendTo ${chatId} failed`, err);
    }
  }

  /**
   * Like `sendTo`, but the failure reaches the caller. Used where losing the
   * message matters (the day's post), so the sender can try again later.
   */
  async sendToOrThrow(chatId: number, text: string): Promise<void> {
    if (!this.token) throw new Error("telegram has no token");
    if (!this.isAllowed(chatId)) throw new Error(`chat ${chatId} is not on the allowlist`);
    await this.sendChunked(chatId, text);
  }

  /** Like `broadcast`, but a chat that could not be reached reaches the caller. */
  async broadcastOrThrow(text: string): Promise<void> {
    if (!this.token) throw new Error("telegram has no token");
    let sent = 0;
    let last: unknown;
    for (const chatId of this.knownChats) {
      if (!this.isAllowed(chatId)) continue;
      try {
        await this.sendChunked(chatId, text);
        sent += 1;
      } catch (err) {
        last = err;
      }
    }
    if (!sent) throw last ?? new Error("telegram knows no chat to broadcast to");
  }

  /** Push a message to every chat the bot has spoken in (sentinel alerts). */
  async broadcast(text: string): Promise<void> {
    for (const chatId of this.knownChats) {
      if (!this.isAllowed(chatId)) continue;
      try {
        await this.sendChunked(chatId, text);
      } catch (err) {
        log.warn(`broadcast to ${chatId} failed`, err);
      }
    }
  }

  // ------------------------------------------------------------- polling

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        this.abort = new AbortController();
        const updates = await this.api<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: 50, allowed_updates: ["message"] },
          this.abort.signal,
          55_000,
        );
        for (const update of updates ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message) {
            // Sequential on purpose: the runtime/memory isn't reentrant-safe.
            await this.handleMessage(update.message).catch((err) =>
              log.error("message handling failed", err),
            );
          }
        }
      } catch (err) {
        if (!this.running) break;
        const msg = (err as Error).message ?? String(err);
        if (msg.includes("409")) {
          log.warn("getUpdates conflict (409): another poller is running with this token.");
        } else {
          log.warn(`poll failed: ${msg}`);
        }
        await sleep(5_000);
      }
    }
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const text = msg.text?.trim();
    if (!text || !msg.from || msg.from.id === this.me?.id) return;

    const chatId = msg.chat.id;
    if (!this.isAllowed(chatId)) {
      if (!this.warnedChats.has(chatId)) {
        this.warnedChats.add(chatId);
        log.warn(`ignoring chat ${chatId} (not in TELEGRAM_ALLOWED_CHATS)`);
      }
      return;
    }
    if (!this.isUserAllowed(msg.from)) {
      if (!this.warnedChats.has(msg.from.id)) {
        this.warnedChats.add(msg.from.id);
        log.warn(
          `ignoring user @${msg.from.username ?? msg.from.id} (not in TELEGRAM_ALLOWED_USERS)`,
        );
      }
      return;
    }

    // In groups, only react when addressed.
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    let content = text;
    if (isGroup) {
      const mention = this.me?.username ? `@${this.me.username}` : null;
      const mentioned = mention ? content.includes(mention) : false;
      const repliedToMe = msg.reply_to_message?.from?.id === this.me?.id;
      if (!mentioned && !repliedToMe) return;
      if (mention) content = content.split(mention).join("").trim() || "hi";
    }

    await this.rememberChat(chatId);

    const cmd = content.split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, "");
    if (cmd === "/start" || cmd === "/help") {
      await this.sendChunked(chatId, HELP_TEXT);
      return;
    }
    if (cmd === "/study" || cmd === "/cyberia") {
      await this.runCyberiaStudy(chatId);
      return;
    }
    if (cmd === "/recap") {
      await this.sendRecap(chatId);
      return;
    }
    if (cmd === "/tasks") {
      await this.handleTasks(chatId, content.split(/\s+/).slice(1));
      return;
    }
    if (cmd === "/model") {
      await this.handleModel(chatId, content.split(/\s+/).slice(1));
      return;
    }
    if (cmd === "/jobs") {
      await this.showForgeJobs(chatId, content.split(/\s+/).slice(1));
      return;
    }

    // A reply carries the quoted message as context, so "запусти этот скрипт"
    // in reply to a code block reaches the agent together with the code.
    const quoted = msg.reply_to_message?.text?.trim();
    if (quoted) {
      const clipped = quoted.length > 600 ? `${quoted.slice(0, 600)}…` : quoted;
      content = `[in reply to: ${clipped}]\n${content}`;
    }

    const typing = this.keepTyping(chatId);
    try {
      const result = await this.runtime.handleMessage({
        roomId: `tg-${chatId}`,
        userId: `tg:${msg.from.username ?? msg.from.id}`,
        text: content,
      });
      // Provenance receipt: what kind of work this was taken as, and which
      // model actually answered it (the operator must be able to see it's the
      // subscription, not some fallback, and that a digest went to the cheap
      // route). Off: =0.
      const sig =
        result.model && this.runtime.getSetting("LAINOS_REPLY_SIGNATURE") !== "0"
          ? `\n\n⌁ ${answerStamp(result)}`
          : "";
      await this.sendChunked(chatId, (result.text || "…") + sig);
    } catch (err) {
      log.error("agent turn failed", err);
      await this.sendChunked(chatId, "…the wired flickered. try again.").catch(() => {});
    } finally {
      typing();
    }
  }

  // --------------------------------------------------------- model routing

  /**
   * `/tasks` — read the routing table, and change one row of it.
   *
   * Reading it from the phone was already possible; changing it meant the
   * desk (`npm run tasks`), which is exactly where the operator is not when a
   * route turns out to be wrong. Same grammar as the CLI: `/tasks digest
   * openrouter:openrouter/free`, and `-` returns a kind to the environment.
   */
  private async handleTasks(chatId: number, args: string[]): Promise<void> {
    const model = this.runtime.model;
    if (!(model instanceof SwitchableModelProvider)) {
      await this.sendChunked(chatId, "the model provider is fixed for this run.");
      return;
    }
    if (args.length === 0) {
      const rows = model
        .taskRoutes()
        .map(
          (r) =>
            `${r.emoji} ${r.task} → ${r.provider}${r.model ? ` · ${r.model}` : ""} (${r.source})` +
            (r.error ? ` ⚠ ${r.error}` : ""),
        )
        .join("\n");
      await this.sendChunked(
        chatId,
        `${rows}\n\nre-route: /tasks <kind> <provider[:model]> · вернуть в env: /tasks <kind> -`,
      );
      return;
    }
    const kind = args[0].toLowerCase();
    if (!isTaskKind(kind)) {
      await this.sendChunked(
        chatId,
        `не знаю такой вид работы: "${args[0]}" — есть: ${Object.keys(TASKS).join(" · ")}`,
      );
      return;
    }
    const raw = args.slice(1).join(" ").trim();
    if (!raw) {
      const state = model.taskRouteState(kind as TaskKind);
      await this.sendChunked(
        chatId,
        `${state.emoji} ${state.task} → ${state.provider}${state.model ? ` · ${state.model}` : ""} (${state.source})`,
      );
      return;
    }
    const result = model.setTaskRoute(
      kind as TaskKind,
      ["-", "env", "auto", "сброс"].includes(raw.toLowerCase()) ? null : raw,
    );
    if (typeof result === "string") {
      await this.sendChunked(chatId, result);
      return;
    }
    const warn = TASKS[kind as TaskKind].critical
      ? "\n⚠ этот вид работы трогает мир (деньги, код) — модель должна быть та, которой ты доверяешь."
      : "";
    await this.sendChunked(
      chatId,
      `готово: ${result.emoji} ${result.task} → ${result.provider}` +
        `${result.model ? ` · ${result.model}` : ""} (${result.source})${warn}`,
    );
  }

  /**
   * `/model` — who is answering, and switch to somebody else.
   *
   * `/model free` is the part that needed writing: `openrouter/free` is a
   * *router*, so "которой моделью ты отвечаешь" has no fixed answer until one
   * of the pool is pinned. The list is read from OpenRouter's own catalogue,
   * never from a list in this file, and picking one points the CHAT kind at it
   * — the rest of the routing table is `/tasks`.
   */
  private async handleModel(chatId: number, args: string[]): Promise<void> {
    const model = this.runtime.model;
    if (!(model instanceof SwitchableModelProvider)) {
      await this.sendChunked(chatId, "the model provider is fixed for this run.");
      return;
    }
    if (args[0]?.toLowerCase() === "free") {
      await this.handleFreePool(chatId, model, args.slice(1));
      return;
    }
    if (args.length === 0) {
      const state = model.state();
      const choices = CHAT_PROVIDER_CHOICES.map((c) => `  · ${c.name} — ${c.desc}`).join("\n");
      const chat = model.taskRouteState(TaskKind.CHAT);
      const pinned =
        chat.source === "operator"
          ? `\nразговор закреплён за ${chat.provider}${chat.model ? ` · ${chat.model}` : ""} (/model free auto — снять)`
          : "";
      await this.sendChunked(
        chatId,
        `сейчас отвечает ${chatProviderLabel(state.kind)} · ${state.model}` +
          (state.overridden ? ` (env по умолчанию: ${state.envKind})` : "") +
          `${pinned}\n\nпереключить: /model <кем>\n${choices}\n\n` +
          "бесплатный пул: /model free · вся таблица работ: /tasks",
      );
      return;
    }
    const kind = resolveChatProviderKind(args[0]);
    if (!kind) {
      await this.sendChunked(
        chatId,
        `не знаю такого: "${args[0]}" — есть: ${CHAT_PROVIDER_CHOICES.map((c) => c.name).join(" · ")}`,
      );
      return;
    }
    const result = model.switchTo(kind);
    if (typeof result === "string") {
      await this.sendChunked(chatId, result);
      return;
    }
    await this.sendChunked(
      chatId,
      `готово: отвечаю через ${chatProviderLabel(result.kind)} · ${result.model}` +
        (result.overridden ? " (сохранено — демон подхватит после рестарта)" : " (обратно к env)"),
    );
  }

  /** `/model free [n|id|auto]` — the pool behind `openrouter/free`. */
  private async handleFreePool(
    chatId: number,
    model: SwitchableModelProvider,
    args: string[],
  ): Promise<void> {
    const choice = args[0]?.trim();
    if (choice && ["auto", "-", "сброс", "router"].includes(choice.toLowerCase())) {
      const result = model.setTaskRoute(TaskKind.CHAT, null);
      await this.sendChunked(
        chatId,
        typeof result === "string"
          ? result
          : `готово: разговор снова идёт через ${result.provider}${result.model ? ` · ${result.model}` : ""} (${result.source})`,
      );
      return;
    }

    let pool: FreeModel[];
    try {
      pool = await this.freePool();
    } catch (err) {
      // The catalogue is one HTTP call to the provider we already talk to; a
      // failure here is worth saying plainly rather than answering with an
      // empty list, which reads as "there is nothing free".
      await this.sendChunked(chatId, `не смогла прочитать список моделей: ${(err as Error).message}`);
      return;
    }
    if (pool.length === 0) {
      await this.sendChunked(chatId, "провайдер сейчас не отдаёт ни одной бесплатной модели.");
      return;
    }

    if (!choice) {
      const rows = pool
        .map((m, i) => {
          const ctx = m.context ? ` · ${Math.round(m.context / 1000)}k` : "";
          return `${String(i + 1).padStart(2)}. ${m.name}${ctx}\n    ${m.id}`;
        })
        .join("\n");
      await this.sendChunked(
        chatId,
        `бесплатных моделей сейчас: ${pool.length}\n\n${rows}\n\n` +
          "закрепить: /model free <номер|id> · вернуть роутер: /model free auto\n" +
          "это закрепляет только разговор; остальные виды работ — /tasks",
      );
      return;
    }

    const index = Number(choice);
    const picked = Number.isInteger(index)
      ? pool[index - 1]
      : pool.find((m) => m.id.toLowerCase() === choice.toLowerCase()) ??
        pool.find((m) => m.id.toLowerCase().includes(choice.toLowerCase()));
    if (!picked) {
      await this.sendChunked(chatId, `не нашла такую в пуле: "${choice}" — открой /model free.`);
      return;
    }
    const result = model.setTaskRoute(TaskKind.CHAT, `openrouter:${picked.id}`);
    await this.sendChunked(
      chatId,
      typeof result === "string"
        ? result
        : `готово: разговор идёт через ${picked.name} · ${picked.id}\n` +
            "бесплатные модели часто заняты — если замолчу, /model free auto вернёт роутер.",
    );
  }

  /** The free pool, re-read at most every half hour. */
  private async freePool(): Promise<FreeModel[]> {
    const fresh = Date.now() - this.freePoolAt < 1_800_000;
    if (fresh && this.freePoolCache) return this.freePoolCache;
    const pool = await fetchFreeModels({
      apiKey: this.runtime.getSetting("OPENROUTER_API_KEY"),
      baseUrl: this.runtime.getSetting("OPENROUTER_BASE_URL"),
      proxy:
        this.runtime.getSetting("LAINOS_MODEL_PROXY") ??
        this.runtime.getSetting("HTTPS_PROXY") ??
        this.proxyUrl,
    });
    this.freePoolCache = pool;
    this.freePoolAt = Date.now();
    return pool;
  }

  // ------------------------------------------------------------- helpers

  /**
   * `/recap` for a chat: the counted half always lands, the written half is
   * produced by whatever the `memory` task is routed to — summarising your own
   * log is never worth a paid token.
   */
  private async sendRecap(chatId: number): Promise<void> {
    const sessions = this.runtime.sessions;
    const record = await sessions?.resolve(`tg-${chatId}`);
    if (!record) {
      await this.sendChunked(chatId, "nothing recorded in this conversation yet.");
      return;
    }
    const typing = this.keepTyping(chatId);
    try {
      const result = await buildRecap(this.runtime, record);
      if (result.summarised && result.model) {
        await sessions?.setRecap(record.id, {
          text: result.text,
          at: Date.now(),
          model: result.model,
        });
      }
      await this.sendChunked(chatId, result.model ? `${result.text}\n\n⌁ ${result.model}` : result.text);
    } finally {
      typing();
    }
  }

  private async runCyberiaStudy(chatId: number): Promise<void> {
    const scout = this.runtime.getService<ScoutService>("scout");
    if (!scout) {
      await this.sendChunked(chatId, "scout is offline.");
      return;
    }

    const typing = this.keepTyping(chatId);
    try {
      const result = await runCyberiaStudyNow(scout, { chatId });
      if (!result) {
        await this.sendChunked(chatId, "Cyberia study is disabled.");
        return;
      }
      await this.rememberChat(chatId);
      await this.sendChunked(chatId, result.digest ?? `создала заметку для ${result.topic.id}.`);
    } catch (err) {
      log.error("cyberia study failed", err);
      await this.sendChunked(chatId, "не смогла сейчас изучить Cyberia. попробуй позже.");
    } finally {
      typing();
    }
  }

  private async showForgeJobs(chatId: number, args: string[]): Promise<void> {
    const forge = this.runtime.getService<ForgeService>("forge");
    if (!forge) {
      await this.sendChunked(chatId, "forge is offline.");
      return;
    }
    const statuses = new Set(["queued", "running", "ok", "failed"]);
    const status = args.find((arg) => statuses.has(arg.toLowerCase()))?.toLowerCase() as
      | "queued"
      | "running"
      | "ok"
      | "failed"
      | undefined;
    const rawLimit = args.find((arg) => /^\d+$/.test(arg));
    const limit = rawLimit ? Number(rawLimit) : undefined;
    await this.rememberChat(chatId);
    await this.sendChunked(chatId, formatForgeJobs(forge, { status, limit }));
  }

  private isAllowed(chatId: number): boolean {
    return this.allowed.size === 0 || this.allowed.has(String(chatId));
  }

  /** Sender gate: username (case-insensitive, no @) or numeric user id. */
  private isUserAllowed(from: TgUser): boolean {
    if (this.allowedUsers.size === 0) return true;
    const byName = from.username ? this.allowedUsers.has(from.username.toLowerCase()) : false;
    return byName || this.allowedUsers.has(String(from.id));
  }

  /** Refresh the "typing…" indicator until the returned fn is called. */
  private keepTyping(chatId: number): () => void {
    const send = () =>
      this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    void send();
    const timer = setInterval(() => void send(), 4_500);
    return () => clearInterval(timer);
  }

  private async sendChunked(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, MAX_MESSAGE)) {
      await this.send("sendMessage", { chat_id: chatId, text: chunk });
    }
  }

  /**
   * A send that survives one bad moment on the proxy. Telegram is reached
   * through a local proxy here, and it drops a request now and then: the
   * message the daemon had to deliver — an alert, the day's post — is then
   * simply gone, and nothing anywhere says so. So a *transport* failure is
   * tried once more; a refusal from Telegram itself ("chat not found") is not,
   * because repeating it would only produce the same answer.
   *
   * The retry can duplicate a message that actually arrived before the timeout.
   * That is the trade taken deliberately: a message twice is a nuisance, a
   * message never is a silent failure.
   */
  private async send<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.api<T>(method, body);
    } catch (err) {
      if (isTelegramRefusal(err)) throw err;
      log.warn(`${method} failed on the transport — retrying once`, err);
      await sleep(2_000);
      return this.api<T>(method, body);
    }
  }

  private async api<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<T | null> {
    const controller = signal ? null : new AbortController();
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const res = await undiciFetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? controller?.signal,
        dispatcher: this.dispatcher,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!res.ok || !json.ok) {
        throw new Error(`telegram ${method} ${res.status}: ${json.description ?? "error"}`);
      }
      return json.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadChats(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.chatsFile, "utf8")) as { chats?: number[] };
      this.knownChats = new Set(parsed.chats ?? []);
    } catch {
      // Fresh store.
    }
  }

  private async rememberChat(chatId: number): Promise<void> {
    if (this.knownChats.has(chatId)) return;
    this.knownChats.add(chatId);
    try {
      await mkdir(dirname(this.chatsFile), { recursive: true });
      await writeFile(
        this.chatsFile,
        JSON.stringify({ chats: [...this.knownChats] }, null, 2),
        "utf8",
      );
    } catch (err) {
      log.warn("could not persist known chats", err);
    }
  }
}

/** Split on newline boundaries where possible, hard-cut otherwise. */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Did Telegram answer and say no? Those errors are shaped by `api()` itself
 * ("telegram sendMessage 400: chat not found"); anything else — an abort, a
 * dead socket, a proxy that went away — never reached Telegram at all.
 * Exported for tests.
 */
export function isTelegramRefusal(err: unknown): boolean {
  return err instanceof Error && /^telegram \w+ \d{3}:/.test(err.message);
}
