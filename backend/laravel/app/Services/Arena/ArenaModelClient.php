<?php

namespace App\Services\Arena;

use DomainException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

class ArenaModelClient
{
    public const PROMPT = 'You are a bounded paper-trading contestant. You have no tools, wallet, web access or private memory. Use only the supplied observation and your own portfolio. Prices are USDC micro-units per WETH; cash has 6 decimals and WETH has 18. Do not invent news, indicators or history. Compare costs and uncertainty. Output only JSON with exactly action (hold/buy/sell), bps (0 for hold; 2500/5000/10000 otherwise), and reason (at most 600 characters). No markdown. Buying spends that fraction of cash including modeled costs; selling uses that fraction of WETH. Never buy with no cash or sell with no WETH. The future fill price is unknown. Your public reason must explain the decision briefly; it is not a private chain of thought. Return exactly one JSON object, never an array. Example: {"action":"hold","bps":0,"reason":"Insufficient evidence to change the position."}';

    /**
     * The contestant prompt for a market. The WETH/USDC wording is the
     * original constant, kept byte for byte so frozen seasons stay intact.
     *
     * @param  array{cash: string, asset: string, lot: int}|null  $units
     */
    public static function prompt(?array $units): string
    {
        if ($units === null) {
            return self::PROMPT;
        }
        $lot = $units['lot'] === 1 ? 'one '.$units['asset'] : number_format($units['lot']).' '.$units['asset'];

        return str_replace(
            ['Prices are USDC micro-units per WETH; cash has 6 decimals and WETH has 18.', 'selling uses that fraction of WETH', 'sell with no WETH'],
            ["Prices are {$units['cash']} micro-units per lot of {$lot}; cash has 6 decimals and the asset position is counted in lots with 18 decimals.",
                "selling uses that fraction of the {$units['asset']} position", "sell with no {$units['asset']}"],
            self::PROMPT,
        );
    }

    /** @param array<string, mixed> $rules
     * @param  array<string, mixed>  $context
     * @return array<string, mixed>
     */
    public function decide(string $actor, array $rules, array $context): array
    {
        $settings = $rules['automation'];
        self::assertFreeOnly($settings);
        $model = $settings['models'][$actor];
        $system = $settings['prompt']."\nMethod: ".$rules['agents'][$actor]['method'];
        $user = json_encode($context, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        if (strlen($system) + strlen($user) > $settings['max_prompt_bytes']) {
            throw new DomainException('model_context_too_large');
        }
        [$data, $served] = $this->complete($model, $system, $user, $settings);
        $decision = Validator::make(['decision' => $data], [
            'decision' => ['required', 'array:action,bps,reason'],
            'decision.action' => ['required', Rule::in(['hold', 'buy', 'sell'])],
            'decision.bps' => ['required', 'integer', Rule::in([0, 2500, 5000, 10000])],
            'decision.reason' => ['required', 'string', 'max:600'],
        ])->validated()['decision'];
        if (! is_int($data['bps']) || ($decision['action'] === 'hold') !== ($decision['bps'] === 0)) {
            throw new DomainException('invalid_model_action');
        }

        return ['decision' => [...$decision, 'model' => $model], 'served_model' => $served];
    }

    /**
     * One zero-price completion, refused unless the served model, the finish
     * and the size are what was asked for.
     *
     * @param  array<string, mixed>  $settings
     * @return array{0: array<mixed>, 1: mixed}
     */
    private function complete(string $model, string $system, string $user, array $settings): array
    {
        $response = Http::withToken((string) config('arena.automation.api_key'))->acceptJson()
            ->connectTimeout(3)->timeout($settings['timeout_seconds'])->withOptions(['allow_redirects' => false])
            ->post('https://openrouter.ai/api/v1/chat/completions', [
                'model' => $model, 'stream' => false, 'max_tokens' => $settings['max_output_tokens'], 'temperature' => 0.2,
                'reasoning' => ['enabled' => false],
                'provider' => ['allow_fallbacks' => false, 'require_parameters' => true,
                    'max_price' => ['prompt' => 0, 'completion' => 0, 'request' => 0]],
                'response_format' => ['type' => 'json_object'],
                'messages' => [['role' => 'system', 'content' => $system], ['role' => 'user', 'content' => $user]],
            ]);
        $served = $response->json('model');
        $expected = preg_replace('/:free$/D', '', $model);
        if (! $response->successful() || strlen($response->body()) > 32768 || ! in_array($served, [$model, $expected], true)
            || $response->json('choices.0.finish_reason') !== 'stop' || $response->json('choices.0.message.tool_calls')) {
            throw new DomainException('model_response_rejected');
        }
        $content = $response->json('choices.0.message.content');
        if (! is_string($content) || strlen($content) > 4096) {
            throw new DomainException('model_response_rejected');
        }
        $data = json_decode($content, true, 8, JSON_THROW_ON_ERROR);

        if (! is_array($data)) {
            throw new DomainException('model_response_rejected');
        }

        return [$data, $served];
    }

    public const MULTI_PROMPT = 'You are a bounded paper-trading contestant on Solana tokens. You have no tools, wallet, web access or private memory. There is no fixed list: you may buy any Solana token by its mint address, and it fills only if a public DEX index prices it from a pool above the liquidity floor. The board lists what is in view this round (USD per whole token, pool liquidity, the 24h change; the promoted rows are paid promotion, not a recommendation) and every token you hold. Cash is paper USD. Do not invent news, indicators or history. Compare costs and uncertainty: every order pays the modeled fee and slippage, and thin pools move. Output only JSON with exactly action (hold/buy/sell), token (a mint address, or null for hold), bps (0 for hold; 2500/5000/10000 otherwise) and reason (at most 600 characters). No markdown. Buying spends that fraction of cash on the token; selling sells that fraction of your position in it. Never buy with no cash or sell a token you do not hold. The future fill price is unknown. Your public reason must explain the decision briefly; it is not a private chain of thought. Return exactly one JSON object. Example: {"action":"buy","token":"So11111111111111111111111111111111111111112","bps":2500,"reason":"Deepest pool, small allocation while the board is mixed."}';

    /**
     * @param  array<string, mixed>  $rules
     * @param  array<string, mixed>  $context
     * @return array<string, mixed>
     */
    public function decideMulti(string $actor, array $rules, array $context): array
    {
        $settings = $rules['automation'];
        self::assertFreeOnly($settings);
        $model = $settings['models'][$actor];
        $system = $settings['prompt']."\nMethod: ".$rules['agents'][$actor]['method'];
        $user = json_encode($context, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        if (strlen($system) + strlen($user) > $settings['max_prompt_bytes']) {
            throw new DomainException('model_context_too_large');
        }
        [$data, $served] = $this->complete($model, $system, $user, $settings);
        $decision = Validator::make(['decision' => $data], [
            'decision' => ['required', 'array:action,token,bps,reason'],
            'decision.action' => ['required', Rule::in(['hold', 'buy', 'sell'])],
            'decision.token' => ['nullable', 'string', 'max:64'],
            'decision.bps' => ['required', 'integer', Rule::in([0, 2500, 5000, 10000])],
            'decision.reason' => ['required', 'string', 'max:600'],
        ])->validated()['decision'];
        $hold = $decision['action'] === 'hold';
        if (! is_int($data['bps']) || $hold !== ($decision['bps'] === 0) || (! $hold && empty($decision['token']))) {
            throw new DomainException('invalid_model_action');
        }

        $token = $hold ? null : self::mint((string) $decision['token'], $context);
        if (! $hold && $token === null) {
            throw new DomainException('invalid_model_action');
        }

        return ['decision' => [...$decision, 'token' => $token, 'model' => $model], 'served_model' => $served];
    }

    /**
     * What a model named, as a mint: a mint as given, or a symbol that is on
     * the board (or held) exactly once. Models often answer with a ticker.
     *
     * @param  array<string, mixed>  $context
     */
    private static function mint(string $token, array $context): ?string
    {
        if (preg_match(ArenaQuoteBoard::MINT, $token)) {
            return $token;
        }
        $matches = collect([...$context['board'] ?? [], ...$context['portfolio']['positions'] ?? []])
            ->filter(fn ($row) => is_string($row['symbol'] ?? null) && strcasecmp(ltrim($row['symbol'], '$'), ltrim($token, '$')) === 0)
            ->pluck('mint')->unique()->values();

        return $matches->count() === 1 ? $matches->first() : null;
    }

    /** @param array<string, mixed> $settings */
    public static function assertFreeOnly(array $settings): void
    {
        if (($settings['pricing_policy'] ?? null) !== 'free-only'
            || ($settings['max_price_per_million'] ?? null) !== 0
            || ($settings['budget_cents'] ?? null) !== 0 || ($settings['reservation_cents_per_call'] ?? null) !== 0) {
            throw new DomainException('free_models_required');
        }
        foreach (['lain', 'challenger'] as $actor) {
            $model = $settings['models'][$actor] ?? null;
            if (! is_string($model) || ! preg_match('/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]{1,80}:free$/D', $model)) {
                throw new DomainException('free_models_required');
            }
        }
    }
}
