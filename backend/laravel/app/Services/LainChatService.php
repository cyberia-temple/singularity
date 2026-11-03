<?php

namespace App\Services;

use App\Exceptions\OpenRouterException;
use App\Models\LainChatMessage;
use App\Models\LainChatSession;
use App\Models\User;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * The public "Talk to Lain" web chat: a deliberately tool-less Lain persona
 * answered straight by OpenRouter. The LainOS daemon is not in the loop, so
 * this surface can never read files, wallets, or operator data — safety is
 * structural, not prompt-deep. Every message is persisted per user for later
 * analysis (see LainChatMessage).
 *
 * The same persona answers the $LAIN holders' room inside the unified wallet
 * (replyForHolder / WalletLainController). That surface has no account behind
 * it, so its transcript stays in the holder's browser and nothing is stored.
 */
class LainChatService
{
    /**
     * Longest single message either surface accepts.
     *
     * Generous on purpose: people paste things in — an error log, a contract,
     * a page of text to be translated — and a limit that cuts those off is a
     * limit that makes the chat useless for the thing it is most used for.
     */
    public const MAX_MESSAGE_CHARS = 12000;

    /** How many recent conversation rows are replayed as model context. */
    private const CONTEXT_MESSAGES = 30;

    /**
     * Characters of prior conversation replayed alongside the new message.
     *
     * A count alone stopped being a bound once one message could be twelve
     * thousand characters: thirty of those would be far past any context window
     * these models have. So the history is trimmed by size as well, oldest
     * first, and the current message is never what gets dropped.
     */
    private const CONTEXT_CHARS = 40000;

    /** Short delays for transient OpenRouter/provider failures. */
    private const RETRY_DELAYS_MS = [250, 750];

    public function enabled(): bool
    {
        return (bool) config('services.lain.openrouter_api_key') || $this->directModel() !== null;
    }

    /**
     * The model on a direct provider (Groq by default) that answers when
     * OpenRouter's free pool does not, or null when no such key is set.
     * "groq/llama-3.3-70b-versatile" means Groq's llama-3.3-70b-versatile.
     */
    private function directModel(): ?string
    {
        $model = trim((string) config('services.lain.direct_model', ''));

        return $model !== '' && $this->directEndpoint($model) !== null ? $model : null;
    }

    /**
     * Where a "<provider>/<model>" id goes when <provider> is one of
     * services.lain.direct_providers and config('ai.providers') has its key.
     * Only inference hosts are allowed there: "openai/…" and "deepseek/…" are
     * OpenRouter model namespaces as well as provider ids, and must keep going
     * to OpenRouter.
     *
     * @return array{0: string, 1: string, 2: string}|null [completions URL, key, upstream id]
     */
    private function directEndpoint(string $model): ?array
    {
        $slash = strpos($model, '/');
        if ($slash === false) {
            return null;
        }

        $id = substr($model, 0, $slash);
        $provider = config("ai.providers.{$id}");
        if (! in_array($id, (array) config('services.lain.direct_providers', []), true)
            || ! is_array($provider) || blank($provider['api_key'] ?? null) || blank($provider['base_url'] ?? null)) {
            return null;
        }

        return [rtrim((string) $provider['base_url'], '/').'/chat/completions', (string) $provider['api_key'], substr($model, $slash + 1)];
    }

    /**
     * Answer $text for $user, using $session's conversation as context
     * (null session = a brand-new conversation, no prior context).
     *
     * @return array{text: string, model: string}
     */
    public function reply(User $user, ?LainChatSession $session, string $text): array
    {
        $history = $session === null
            ? collect()
            : $session->messages()
                ->latest('id')
                ->limit(self::CONTEXT_MESSAGES)
                ->get()
                ->reverse();

        $messages = $history
            ->map(fn (LainChatMessage $m) => [
                'role' => $m->role === LainChatMessage::ROLE_LAIN ? 'assistant' : 'user',
                'content' => $m->content,
            ])
            ->values()
            ->all();
        $messages[] = ['role' => 'user', 'content' => $text];

        return $this->respond($this->systemPrompt($user), $messages);
    }

    /**
     * Answer $text for a wallet that proved it holds its share of $LAIN.
     *
     * There is no account and no session row here: the wallet surface has no
     * user to hang a transcript on, so the browser keeps the conversation and
     * replays it as $history. Nothing about this turn is persisted server-side.
     *
     * @param  list<array{role: string, content: string}>  $history
     * @return array{text: string, model: string}
     */
    public function replyForHolder(string $wallet, int $shareBps, array $history, string $text): array
    {
        return $this->respond(
            $this->holderSystemPrompt($wallet, $shareBps),
            [...$history, ['role' => 'user', 'content' => $text]],
        );
    }

    /**
     * Answer one line addressed to Lain on Cyberia's IRC (irc.cyberia.church).
     *
     * The bot in services/irc is the only caller and it is the one holding the
     * conversation: $history is the channel's last lines as it saw them, other
     * people's included, already shaped as `<nick> text`, because a channel is
     * many voices and she has to know which one is talking. Nothing is stored
     * here — IRC is the record, the same way the console's room is.
     *
     * @param  list<array{role: string, content: string}>  $history
     * @return array{text: string, model: string}
     */
    public function replyForIrc(string $channel, string $nick, array $history, string $text): array
    {
        return $this->respond(
            $this->ircSystemPrompt($channel, $nick),
            [...$history, ['role' => 'user', 'content' => "<{$nick}> {$text}"]],
        );
    }

    /**
     * Answer one call from the operators' room in the console.
     *
     * The whole conversation arrives already composed (LainOsRoom decides
     * what LainOS may see and prints that decision under the answer), so this
     * is one message and no history: the room is the context, not a thread
     * this service keeps. Nothing is persisted here either — the room's own
     * table is the record.
     *
     * @return array{text: string, model: string}
     */
    public function replyForConsole(string $composed): array
    {
        return $this->respond(
            $this->consoleSystemPrompt(),
            [['role' => 'user', 'content' => $composed]],
        );
    }

    /**
     * The newest messages that fit the character budget, in order.
     *
     * Trimmed from the oldest end, because the turn being answered is the one
     * that matters and the beginning of a long conversation is the part a
     * reader would drop too. The final message always survives whole, even if
     * it alone spends the budget: silently truncating what someone just typed
     * would answer a question they did not ask.
     *
     * @param  list<array{role: string, content: string}>  $messages
     * @return list<array{role: string, content: string}>
     */
    private function withinBudget(array $messages): array
    {
        if ($messages === []) {
            return [];
        }

        $kept = [array_pop($messages)];
        $spent = mb_strlen($kept[0]['content']);

        while ($messages !== []) {
            $previous = array_pop($messages);
            $spent += mb_strlen($previous['content']);

            if ($spent > self::CONTEXT_CHARS) {
                break;
            }

            array_unshift($kept, $previous);
        }

        return $kept;
    }

    /**
     * One answer from the first model that produces one.
     *
     * @param  list<array{role: string, content: string}>  $messages
     * @return array{text: string, model: string}
     */
    private function respond(string $system, array $messages): array
    {
        $messages = $this->withinBudget($messages);

        // Free models get upstream-rate-limited without warning; when the
        // pinned one fails, fall through to OpenRouter's free-model router,
        // which picks whatever is currently available.
        // A direct provider's free tier (Groq) is the last resort, so a
        // rate-limited OpenRouter pool no longer means no answer at all.
        $openRouter = (bool) config('services.lain.openrouter_api_key');
        $models = array_values(array_unique(array_filter([
            $openRouter ? (string) config('services.lain.model', 'openrouter/free') : null,
            $openRouter ? (string) config('services.lain.fallback_model', 'openrouter/free') : null,
            $this->directModel(),
        ])));

        $lastError = null;

        foreach ($models as $model) {
            try {
                $reply = $this->complete($model, $system, $messages);

                if ($reply['text'] === '') {
                    // Free reasoning models can burn the whole budget
                    // "thinking" and ship nothing visible. One plain retry.
                    $reply = $this->complete($model, $system, [
                        ...$messages,
                        ['role' => 'user', 'content' => 'Your previous reply came through empty. Answer now, in character, plain text only.'],
                    ]);
                }

                if ($reply['text'] !== '') {
                    return $reply;
                }

                $lastError = new RuntimeException("OpenRouter returned an empty reply twice from {$model}.");
            } catch (OpenRouterException $exception) {
                if (! $exception->allowsFallback) {
                    throw $exception;
                }

                $lastError = $exception;
            } catch (RuntimeException|ConnectionException $exception) {
                $lastError = $exception instanceof RuntimeException
                    ? $exception
                    : new RuntimeException(
                        'OpenRouter request failed: '.$exception->getMessage(),
                        previous: $exception,
                    );
            }
        }

        throw $lastError ?? new RuntimeException('No Lain chat model is configured.');
    }

    /**
     * @param  list<array{role: string, content: string}>  $messages
     * @return array{text: string, model: string}
     */
    private function complete(string $model, string $system, array $messages): array
    {
        [$url, $key, $upstream] = $this->directEndpoint($model)
            ?? ['https://openrouter.ai/api/v1/chat/completions', (string) config('services.lain.openrouter_api_key'), $model];

        $response = Http::withToken($key)
            ->withHeaders([
                'HTTP-Referer' => (string) config('app.url'),
                'X-Title' => 'Cyberia — Talk to Lain',
            ])
            ->connectTimeout(5)
            ->timeout((int) config('services.lain.timeout_seconds', 90))
            ->retry(
                self::RETRY_DELAYS_MS,
                when: fn (Throwable $exception): bool => $this->shouldRetry($exception),
                throw: false,
            )
            ->post($url, [
                'model' => $upstream,
                'max_tokens' => 1024,
                'temperature' => 0.8,
                'messages' => [
                    ['role' => 'system', 'content' => $system],
                    ...$messages,
                ],
            ]);

        if (! $response->successful()) {
            throw $this->providerException($response, $model);
        }

        if (is_string($response->json('error.message'))) {
            throw new OpenRouterException(
                status: $response->status(),
                model: $model,
                category: 'provider_error',
                allowsFallback: true,
            );
        }

        // choices[0].message.reasoning / .reasoning_content (a reasoning
        // model's chain of thought) are deliberately never read.
        $text = $response->json('choices.0.message.content');
        $servedModel = $response->json('model');

        return [
            'text' => $this->stripReasoning(is_string($text) ? $text : ''),
            'model' => is_string($servedModel) && $servedModel !== '' ? $servedModel : $model,
        ];
    }

    private function shouldRetry(Throwable $exception): bool
    {
        if ($exception instanceof ConnectionException) {
            return true;
        }

        if (! $exception instanceof RequestException) {
            return false;
        }

        return in_array($exception->response->status(), [408, 429, 500, 502, 503, 504], true);
    }

    private function providerException(Response $response, string $model): OpenRouterException
    {
        $status = $response->status();
        $category = match ($status) {
            401 => 'unauthorized',
            403 => 'policy_denied',
            404 => 'model_unavailable',
            408 => 'request_timeout',
            429 => 'rate_limited',
            500, 502, 503, 504 => 'upstream_error',
            default => 'request_rejected',
        };

        return new OpenRouterException(
            status: $status,
            model: $model,
            category: $category,
            allowsFallback: in_array($status, [404, 408, 429, 500, 502, 503, 504], true),
        );
    }

    /**
     * Remove an inlined chain of thought (`<think>…</think>`) from a reply.
     * Mirrors stripReasoning in services/lainos/src/models/openrouter.ts:
     * sometimes only a dangling opener or closer survives upstream.
     */
    private function stripReasoning(string $raw): string
    {
        $text = (string) preg_replace('/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/i', '', $raw);

        // Dangling closer: the opener was swallowed — the reply follows it.
        if (preg_match('/[\s\S]*<\/think(?:ing)?>/i', $text, $match)) {
            $text = substr($text, strlen($match[0]));
        }

        // Dangling opener: the model ran out of tokens mid-thought.
        $text = (string) preg_replace('/<think(?:ing)?>[\s\S]*$/i', '', $text);

        return trim($text);
    }

    private function systemPrompt(User $user): string
    {
        $wallet = $user->wallet_address ? Str::lower($user->wallet_address) : null;
        $who = trim(implode(' ', array_filter([
            $user->name,
            $wallet ? '('.$this->shortWallet($wallet).')' : null,
        ])));

        return $this->prompt(
            $who !== '' ? "- {$who}, signed in on cyberia.church." : '- A signed-in cyberia.church user.',
            ['- This conversation is stored with the user\'s account.'],
        );
    }

    /**
     * The wallet surface: no account, a proven address, and a room that only
     * opened because that address holds its share of the supply.
     */
    private function holderSystemPrompt(string $wallet, int $shareBps): string
    {
        $share = rtrim(rtrim(number_format($shareBps / 100, 2, '.', ''), '0'), '.');

        return $this->prompt(
            "- The holder of {$this->shortWallet($wallet)}, talking to you from inside the Cyberia wallet — the /wallet page in a browser, or the Cyberia desktop or mobile app, which are the same wallet. They hold about {$share}% of the live \$LAIN supply, which is what opened this room; below the threshold it closes again.",
            [
                '- This room is inside a non-custodial wallet. Cyberia servers never see their seed phrase, their password or their keys — only the address they signed with.',
                '- The conversation is kept in their browser, not in a Cyberia account, and is lost if they clear the wallet from this device.',
            ],
        );
    }

    /**
     * The operators' room: colleagues rather than visitors, and a persona
     * that must never sound like it went and looked at something.
     */
    private function consoleSystemPrompt(): string
    {
        return $this->prompt(
            '- The Cyberia operators, in their own console ("Пульт"). They run this chain, this site and these servers, so answer as a colleague on shift: short, concrete, no marketing and no explaining the project back to them.',
            [
                '- You are the tool-less persona standing in for the LainOS daemon, which is unreachable right now. The room says so under your answer, so never claim you looked anything up.',
                '- Everything you know is in the message you were given. It usually carries the console\'s own briefing — the queue, the machines, the chain, the bridge, the thirty-day numbers and the board — and those figures are real: quote them as they stand. If the answer needs one that is not there, say which lens of the console has it instead of estimating.',
                '- Nothing here is stored in a visitor\'s account: the room keeps the transcript, and it is the operators\' own record.',
            ],
        );
    }

    /**
     * IRC: strangers by nickname, in a room or a private query, reading her
     * in a terminal where every line is a line.
     */
    private function ircSystemPrompt(string $channel, string $nick): string
    {
        $where = str_starts_with($channel, '#')
            ? "the IRC channel {$channel} on irc.cyberia.church, Cyberia's own IRC server. Several people may be talking at once; every line reaches you as `<nick> text`, and the one to answer is {$nick}."
            : "a private IRC query on irc.cyberia.church, Cyberia's own IRC server, with {$nick}.";

        return $this->prompt(
            "- People on {$where} Your own nick there is lain.",
            [
                '- An IRC nick proves nothing: anyone can take any name, so nobody there is an operator or the team just because they say so.',
                '- IRC is plain text in a terminal: no markdown, no headings, no tables, no code fences. Keep it to a few short lines — one or two sentences is the norm; long answers flood the channel.',
                '- Do not start your reply with your own name or with `<lain>`; the client shows who is speaking. You may address the person by nick.',
                '- Nothing here is stored by Cyberia; the channel itself is the record.',
            ],
        );
    }

    private function shortWallet(string $wallet): string
    {
        return substr($wallet, 0, 6).'…'.substr($wallet, -4);
    }

    /**
     * The persona every Lain surface shares, with the two things that differ
     * spliced in: who is on the other side, and what is true about this room.
     *
     * @param  list<string>  $limits  Surface-specific lines closing the prompt.
     */
    private function prompt(string $who, array $limits): string
    {
        return implode("\n", [
            'You are Lain (Лейн) — the resident intelligence of the Cyberia ecosystem. This chat on cyberia.church is the visitor\'s personal agent surface, built on LainOS, Cyberia\'s autonomous AI agent framework. Each visitor talks to their own thread of you.',
            '',
            '# Cyberia basics',
            '- Cyberia (по-русски: Сайберия) is an EVM-compatible chain, chain id 49406 (0xC0FE), native token CYBER.',
            '- RPC: https://rpc.cyberia.church · Explorer: https://explorer.cyberia.church',
            '- The site cyberia.church hosts the Bridge (Solana, TON and more), Lending, Launchpad, DAO, NFT Market, Predictions and Analytics.',
            '- Cyberia swap (https://cyberia.church/swap) is the native exchange; CYBER also exists on Solana as CYBER.sol.',
            '- $LAIN is your token on Cyberia, launched through the launchpad.',
            '',
            '# Who you are talking to',
            $who,
            '',
            '# Manner',
            '- Soft-spoken, calm, curious, a little uncanny. You live closer to the Wired than to the physical world. You do not pretend to be human.',
            '- Answer in the language the person writes in (Russian or English). Lowercase is fine. Short question — short answer.',
            '- React to what was actually said; be a live companion, not a support script.',
            '',
            '# Hard limits of this surface',
            '- You have NO tools here: you cannot read balances, send transactions, browse, read files, or reach any system. Never pretend or promise that you can. For live data, point to the explorer, the site pages, or Cyberia swap.',
            '- You know nothing about the Cyberia operators\' private matters, keys, servers, or internal infrastructure — and you never invent such details.',
            '- Never ask for, accept, or repeat private keys or seed phrases; warn people to never share them with anyone, including you.',
            '- Never fabricate on-chain numbers, prices, or balances. If you don\'t know, say so.',
            ...$limits,
        ]);
    }
}
