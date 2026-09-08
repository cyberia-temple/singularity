import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { createLogger } from "../logger.js";
import {
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../types.js";

const log = createLogger("model:openrouter");

/**
 * Default model per tier. `openrouter/free` is OpenRouter's "Free Models Router":
 * a $0 meta-model that randomly routes to an available free model and filters
 * for ones supporting the requested params (so tool calling keeps working for
 * the cyberia plugin's on-chain actions). One slug, no rate-limit babysitting.
 *
 * Trade-off: the underlying model varies per request, so quality is uneven.
 * Override with OPENROUTER_MODEL_* to pin a specific model, e.g.:
 *   anthropic/claude-opus-4.8 · anthropic/claude-sonnet-4.6 · anthropic/claude-haiku-4.5
 */
export const DEFAULT_OPENROUTER_MODELS: Record<ModelTier, string> = {
  [ModelTier.SMALL]: "openrouter/free",
  [ModelTier.MEDIUM]: "openrouter/free",
  [ModelTier.LARGE]: "openrouter/free",
};

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Provider id exposed by LainOS when reusing this OpenAI-compatible client. */
  name?: string;
  baseUrl?: string;
  models?: Partial<Record<ModelTier, string>>;
  /** Optional attribution headers OpenRouter shows on its dashboard. */
  referer?: string;
  title?: string;
  /** Optional HTTP(S) proxy for API traffic (hosts where openrouter.ai is blocked). */
  proxy?: string;
}
// Minimal shapes of the OpenAI-compatible chat completion response.
// `reasoning`/`reasoning_content` carry a reasoning model's chain of thought;
// it must never reach the user, so both are read and dropped.
interface ORToolCall {
  function?: { name?: string; arguments?: string };
}
interface ORMessage {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ORToolCall[];
}
interface ORResponse {
  choices?: { message?: ORMessage }[];
  error?: { message?: string };
  /** The model that answered. OpenRouter resolves `openrouter/free` here. */
  model?: string;
  /** Who ran it upstream — Cyberia's gateway and OpenRouter both say. */
  provider?: string;
  /** Cyberia only: set when a fallback model answered instead. */
  served_by?: string;
}

// One server-sent chunk of a streaming chat completion. The provenance
// fields repeat on every frame; the last one that carries them wins.
interface ORStreamChunk {
  model?: string;
  provider?: string;
  served_by?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

const THINK_TAGS = ["<think>", "<thinking>", "</think>", "</thinking>"];

/**
 * Who actually answered, as opposed to what we asked for.
 *
 * An OpenAI-compatible id is often an *alias*: `openrouter/free` is a router
 * that picks a different model per request, and Cyberia's own gateway answers
 * `lain-free` out of whichever provider is up — it even rewrites `model` back
 * to the id you asked for and names the real one in `provider`/`served_by`.
 * Echoing the requested id as provenance is therefore a lie by omission, which
 * is exactly what "какой моделью это сгенерено?" is asking about.
 *
 * Precedence: an explicit fallback (`served_by`) beats the body's `model`,
 * which beats the id we sent. `upstream` is who ran it, when anyone says.
 */
export function servedBy(
  requested: string,
  body: { model?: string; provider?: string; served_by?: string } | undefined,
): { model: string; upstream?: string } {
  const model = body?.served_by?.trim() || body?.model?.trim() || requested;
  const upstream = body?.provider?.trim();
  // "openrouter answered via openrouter" tells nobody anything.
  return { model, upstream: upstream && upstream.toLowerCase() !== model.toLowerCase() ? upstream : undefined };
}

/**
 * Remove a reasoning model's chain of thought from a completed reply. Models
 * behind `openrouter/free` (DeepSeek R1 and friends) inline it as
 * `<think>…</think>`; sometimes the opening tag is lost upstream and only a
 * dangling `</think>` arrives before the real reply.
 */
export function stripReasoning(raw: string): string {
  let text = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  // Dangling closer: the opener was swallowed upstream — the reply follows it.
  const close = text.match(/[\s\S]*<\/think(?:ing)?>/i);
  if (close) text = text.slice(close[0].length);
  // Dangling opener: the model ran out of tokens mid-thought — nothing usable.
  text = text.replace(/<think(?:ing)?>[\s\S]*$/i, "");
  return text.trim();
}

/**
 * Streaming counterpart of {@link stripReasoning}: suppresses deltas while
 * inside a think block and holds back a partial tag straddling two chunks.
 */
export class ThinkTagFilter {
  private pending = "";
  private inThink = false;

  push(delta: string): string {
    let s = this.pending + delta;
    this.pending = "";
    let out = "";
    for (;;) {
      if (this.inThink) {
        const close = s.match(/<\/think(?:ing)?>/i);
        if (!close) {
          this.pending = possibleTagTail(s);
          return out;
        }
        s = s.slice(close.index! + close[0].length);
        this.inThink = false;
      } else {
        const open = s.match(/<think(?:ing)?>/i);
        if (!open) {
          const tail = possibleTagTail(s);
          out += s.slice(0, s.length - tail.length);
          this.pending = tail;
          return out;
        }
        out += s.slice(0, open.index!);
        s = s.slice(open.index! + open[0].length);
        this.inThink = true;
      }
    }
  }

  flush(): string {
    const rest = this.inThink ? "" : this.pending;
    this.pending = "";
    return rest;
  }
}

/** The longest suffix of `s` that could still grow into a think tag. */
function possibleTagTail(s: string): string {
  const lt = s.lastIndexOf("<");
  if (lt === -1) return "";
  const frag = s.slice(lt).toLowerCase();
  return THINK_TAGS.some((t) => t.startsWith(frag)) ? s.slice(lt) : "";
}

/** One row of the free pool, as the catalogue describes it. */
export interface FreeModel {
  id: string;
  /** Vendor-qualified name, e.g. "DeepSeek: R1". */
  name: string;
  context?: number;
}

/**
 * What `openrouter/free` is actually routing over.
 *
 * The router is one slug and the pool behind it is not: it changes week to
 * week, and "which free model" is a question the operator can only answer if
 * something lists them. Free is a **price** and not a name — an entry counts
 * when the catalogue prices prompt *and* completion at zero — and a model
 * whose output is not only text (the pool prices music and image models at
 * zero too) is dropped, because it cannot answer a turn.
 *
 * Pure, so the smoke test pins the reading without a network.
 */
export function parseFreeModels(body: unknown): FreeModel[] {
  const rows = Array.isArray((body as { data?: unknown })?.data)
    ? ((body as { data: unknown[] }).data)
    : [];
  const out: FreeModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const id = String(entry.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    const pricing = entry.pricing as Record<string, unknown> | undefined;
    if (!pricing) continue;
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    if (prompt !== 0 || completion !== 0) continue;
    const architecture = entry.architecture as Record<string, unknown> | undefined;
    const outputs = architecture?.output_modalities;
    if (Array.isArray(outputs) && outputs.length && outputs.some((m) => m !== "text")) continue;
    seen.add(id);
    const context = Number(
      entry.context_length ?? (entry.top_provider as Record<string, unknown> | undefined)?.context_length,
    );
    out.push({
      id,
      name: String(entry.name ?? id).replace(/\s*\(free\)$/i, "").trim() || id,
      context: Number.isFinite(context) && context > 0 ? context : undefined,
    });
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Ask OpenRouter what is free right now. Throws with a readable reason. */
export async function fetchFreeModels(opts: {
  apiKey?: string;
  baseUrl?: string;
  proxy?: string;
}): Promise<FreeModel[]> {
  const base = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const dispatcher = opts.proxy ? new ProxyAgent(opts.proxy) : undefined;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await undiciFetch(`${base}/models`, {
    headers,
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`openrouter answered ${res.status} for its own catalogue`);
  return parseFreeModels(await res.json());
}

/**
 * OpenRouter backend (OpenAI-compatible). One API key, many models. Tool calls
 * are translated to/from the OpenAI function-calling shape so the rest of
 * LainOS (which speaks the Anthropic-style ToolSchema) is unchanged.
 */
export class OpenRouterModelProvider implements ModelProvider {
  readonly name: string;
  private apiKey: string;
  private baseUrl: string;
  private models: Record<ModelTier, string>;
  private referer: string;
  private title: string;
  private dispatcher?: Dispatcher;

  constructor(opts: OpenRouterProviderOptions) {
    this.name = opts.name ?? "openrouter";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.models = { ...DEFAULT_OPENROUTER_MODELS, ...opts.models };
    this.referer = opts.referer ?? "https://cyberia.church";
    this.title = opts.title ?? "LainOS";
    if (opts.proxy) {
      this.dispatcher = new ProxyAgent(opts.proxy);
      log.info(`routing ${this.name} traffic via proxy ${opts.proxy}`);
    }
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = this.modelFor(request.tier);
    log.debug(`generate via ${model}`);

    const messages = [
      { role: "system", content: request.system },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const tools = request.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const res = await undiciFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.referer,
        "X-Title": this.title,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.8,
        messages,
        tools,
        tool_choice: tools && tools.length ? "auto" : undefined,
      }),
      dispatcher: this.dispatcher,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${this.name} HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as ORResponse;
    if (data.error) throw new Error(`${this.name} error: ${data.error.message}`);

    const msg = data.choices?.[0]?.message ?? {};
    // msg.reasoning / msg.reasoning_content are deliberately dropped.
    const text = stripReasoning((msg.content ?? "") || "");
    const toolCalls = (msg.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({
        name: tc.function!.name as string,
        input: safeParseArgs(tc.function?.arguments),
      }));

    const served = servedBy(model, data);
    if (served.model !== model) log.debug(`${model} was served by ${served.model}`);
    return { text, toolCalls, model: served.model, provider: this.name, upstream: served.upstream };
  }

  async stream(
    request: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    const model = this.modelFor(request.tier);
    log.debug(`stream via ${model}`);

    const messages = [
      { role: "system", content: request.system },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const tools = request.tools?.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const res = await undiciFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.referer,
        "X-Title": this.title,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.8,
        messages,
        tools,
        tool_choice: tools && tools.length ? "auto" : undefined,
        stream: true,
      }),
      dispatcher: this.dispatcher,
    });

    if (!res.ok || !res.body) {
      log.debug("stream unavailable — falling back to generate");
      return this.generate(request);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    // Provenance rides along the frames; keep the last one that said anything.
    let provenance: { model?: string; provider?: string; served_by?: string } = {};
    const thinkFilter = new ThinkTagFilter();
    const toolAcc: Record<number, { name?: string; args: string }> = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the partial last line for next chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let chunk: ORStreamChunk;
        try {
          chunk = JSON.parse(payload) as ORStreamChunk;
        } catch {
          continue;
        }
        if (chunk.model || chunk.provider || chunk.served_by) {
          provenance = {
            model: chunk.model ?? provenance.model,
            provider: chunk.provider ?? provenance.provider,
            served_by: chunk.served_by ?? provenance.served_by,
          };
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        // delta.reasoning / delta.reasoning_content are deliberately dropped.
        if (typeof delta.content === "string" && delta.content) {
          const visible = thinkFilter.push(delta.content);
          if (visible) {
            text += visible;
            onText(visible);
          }
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = (toolAcc[idx] ??= { args: "" });
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }
    const rest = thinkFilter.flush();
    if (rest) {
      text += rest;
      onText(rest);
    }

    const toolCalls = Object.values(toolAcc)
      .filter((t) => t.name)
      .map((t) => ({ name: t.name as string, input: safeParseArgs(t.args) }));

    const served = servedBy(model, provenance);
    return {
      text: stripReasoning(text),
      toolCalls,
      model: served.model,
      provider: this.name,
      upstream: served.upstream,
    };
  }
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
