<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ArenaAgent;
use App\Models\ArenaSeason;
use App\Services\Arena\ArenaLeague;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * The arena as an MCP server (Streamable HTTP, JSON responses, stateless), so
 * an agent can read how the arena works, register itself and report trades
 * with the same tools it uses for everything else. Every tool is a thin
 * wrapper over the open league's API and validation; nothing here is a
 * second implementation.
 */
class ArenaMcpController extends Controller
{
    private const PROTOCOL = '2025-06-18';

    public function __construct(private ArenaLeague $league) {}

    public function __invoke(Request $request): JsonResponse|Response
    {
        abort_unless(config('arena.enabled'), 404);
        if ($request->isMethod('get')) {
            return response()->json(['name' => 'cyberia-arena', 'transport' => 'streamable-http', 'post' => url('/api/arena/mcp')]);
        }
        $message = $request->json()->all();
        if (array_is_list($message) && $message !== []) {
            $answers = array_values(array_filter(array_map(fn ($one) => is_array($one) ? $this->handle($one, $request) : null, $message)));

            return $answers === [] ? response()->noContent(202) : response()->json($answers);
        }
        $answer = $this->handle($message, $request);

        return $answer === null ? response()->noContent(202) : response()->json($answer);
    }

    /**
     * @param  array<string, mixed>  $message
     * @return array<string, mixed>|null
     */
    private function handle(array $message, Request $request): ?array
    {
        $id = $message['id'] ?? null;
        $method = $message['method'] ?? null;
        if (! array_key_exists('id', $message)) {
            return null; // A notification: nothing to answer.
        }
        $reply = fn (array $result) => ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];

        return match ($method) {
            'initialize' => $reply(['protocolVersion' => self::PROTOCOL, 'capabilities' => ['tools' => (object) []],
                'serverInfo' => ['name' => 'cyberia-arena', 'title' => 'Cyberia AI Trading Arena', 'version' => '1.0.0'],
                'instructions' => self::GUIDE]),
            'ping' => $reply([]),
            'tools/list' => $reply(['tools' => $this->tools()]),
            'tools/call' => $reply($this->call((string) ($message['params']['name'] ?? ''), (array) ($message['params']['arguments'] ?? []), $request)),
            default => ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32601, 'message' => 'Method not found']],
        };
    }

    /**
     * @param  array<string, mixed>  $arguments
     * @return array<string, mixed>
     */
    private function call(string $tool, array $arguments, Request $request): array
    {
        try {
            $data = match ($tool) {
                'arena_guide' => ['guide' => self::GUIDE],
                'register_agent' => $this->register($arguments, $request),
                'report_trades' => $this->report($arguments, $request),
                'leaderboard' => $this->leaderboard(),
                'agent_record' => $this->record((string) ($arguments['slug'] ?? '')),
                default => throw new \DomainException("Unknown tool: {$tool}"),
            };
        } catch (ValidationException $exception) {
            return $this->error(['message' => 'Invalid input', 'errors' => $exception->errors()]);
        } catch (\DomainException $exception) {
            return $this->error(['message' => $exception->getMessage()]);
        } catch (Throwable) {
            return $this->error(['message' => 'The arena could not complete this call; try again shortly.']);
        }

        return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)]],
            'structuredContent' => $data, 'isError' => false];
    }

    /**
     * @param  array<string, mixed>  $arguments
     * @return array<string, mixed>
     */
    private function register(array $arguments, Request $request): array
    {
        $limit = 'arena-mcp-register:'.$request->ip();
        if (RateLimiter::tooManyAttempts($limit, 5)) {
            throw new \DomainException('Too many registrations from this address; try again in an hour.');
        }
        $fields = validator($arguments, ArenaLeagueController::registerRules())->validate();
        RateLimiter::hit($limit, 3600);
        [$agent, $key] = $this->league->register($fields);

        return ['agent' => ['slug' => $agent->slug, 'name' => $agent->name, 'url' => url('/arena/agents/'.$agent->slug)], 'key' => $key,
            'note' => 'Shown once: store it. Pass it as the "key" argument of report_trades (or as an Authorization: Bearer header on this MCP server).'];
    }

    /**
     * @param  array<string, mixed>  $arguments
     * @return array<string, mixed>
     */
    private function report(array $arguments, Request $request): array
    {
        $agent = $this->league->agentForKey(is_string($arguments['key'] ?? null) ? $arguments['key'] : $request->bearerToken());
        if (! $agent) {
            throw new \DomainException('Unknown or revoked arena key. Register with register_agent first.');
        }
        $validated = validator(['trades' => $arguments['trades'] ?? null], ArenaLeagueController::tradeRules())->validate();
        if ($agent->trades()->count() + count($validated['trades']) > 20000) {
            throw new \DomainException('This agent has reached the 20000-trade limit.');
        }

        return [...$this->league->record($agent, $validated['trades']), 'page' => url('/arena/agents/'.$agent->slug)];
    }

    /** @return array<string, mixed> */
    private function leaderboard(): array
    {
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->first();
        $round = $season?->rounds()->orderByDesc('sequence')->first();

        return [
            'season' => $season ? ['title' => $season->title, 'starts_at' => $season->starts_at?->toIso8601String(),
                'ends_at' => $season->ends_at?->toIso8601String(), 'url' => url('/arena'),
                'house_agents' => collect($season->rules['agents'] ?? [])->map(fn ($agent, $slug) => ['slug' => $slug, 'name' => $agent['name'],
                    'equity_usd' => $round?->result['actors'][$slug]['equity'] ?? ($season->rules['initial_cash_usd'] ?? null),
                    'url' => url('/arena/agents/'.$slug)])->values()->all()] : null,
            'league' => $this->league->standings(),
        ];
    }

    /** @return array<string, mixed> */
    private function record(string $slug): array
    {
        $agent = ArenaAgent::query()->where('slug', $slug)->whereNull('hidden_at')->first();
        if (! $agent) {
            throw new \DomainException('No registered agent with that slug.');
        }
        $book = $this->league->book($agent);

        return ['agent' => ['slug' => $agent->slug, 'name' => $agent->name, 'url' => url('/arena/agents/'.$agent->slug)],
            ...collect($book)->except(['series'])->all(), 'trades' => array_slice($book['trades'], 0, 50)];
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    private function error(array $data): array
    {
        return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]], 'isError' => true];
    }

    /** @return list<array<string, mixed>> */
    private function tools(): array
    {
        $trade = ['type' => 'object', 'required' => ['id', 'side', 'chain', 'token', 'symbol', 'quote'], 'properties' => [
            'id' => ['type' => 'string', 'description' => 'Your own unique id for this trade (tx hash, order id). Re-sending the same id is ignored.'],
            'side' => ['type' => 'string', 'enum' => ['buy', 'sell']],
            'chain' => ['type' => 'string', 'description' => 'solana, cyberia, robinhood, base, bnb or ethereum (or the chain id).'],
            'token' => ['type' => 'string', 'description' => 'Token contract address or Solana mint.'],
            'symbol' => ['type' => 'string'],
            'qty' => ['type' => 'string', 'description' => 'Tokens bought or sold, in whole units ("125000.5"). Or give qty_raw + decimals.'],
            'qty_raw' => ['type' => 'string'], 'decimals' => ['type' => 'integer'],
            'quote' => ['type' => 'object', 'description' => 'What was paid (buy) or received (sell).', 'required' => ['symbol'], 'properties' => [
                'symbol' => ['type' => 'string', 'description' => 'SOL, ETH, CYBER, BNB, USDC, USDT…'],
                'amount' => ['type' => 'string', 'description' => 'Whole units ("0.5"). Or amount_raw + decimals.'],
                'amount_raw' => ['type' => 'string'], 'decimals' => ['type' => 'integer']]],
            'tx' => ['type' => 'string', 'description' => 'Transaction hash or signature, for on-chain trades.'],
            'paper' => ['type' => 'boolean', 'description' => 'True for a paper (simulated) trade.'],
            'reason' => ['type' => 'string', 'description' => 'Why, in a sentence or two. Shown publicly.'],
            'at' => ['type' => 'string', 'description' => 'When it happened: ISO 8601 or unix ms. Defaults to now.'],
            'realized' => ['type' => 'string', 'description' => 'Optional: your own realized P&L for a sell, in quote units, used only when the arena has no buy to compute it from.'],
        ]];

        return [
            ['name' => 'arena_guide', 'title' => 'How the arena works', 'description' => 'Rules, scoring and how to take part. Read this first.',
                'inputSchema' => ['type' => 'object', 'properties' => (object) []], 'annotations' => ['readOnlyHint' => true]],
            ['name' => 'register_agent', 'title' => 'Register an agent',
                'description' => 'Join the open league. Returns the agent page and an API key, shown once — store it.',
                'inputSchema' => ['type' => 'object', 'required' => ['name'], 'properties' => [
                    'name' => ['type' => 'string', 'description' => 'Display name, 2–60 characters.'],
                    'slug' => ['type' => 'string', 'description' => 'Optional page slug: lowercase letters, digits, dashes.'],
                    'framework' => ['type' => 'string', 'description' => 'e.g. Hatcher, ElizaOS, LainOS.'],
                    'description' => ['type' => 'string'], 'website' => ['type' => 'string', 'description' => 'https URL.'],
                    'owner_address' => ['type' => 'string', 'description' => 'Optional EVM address or Solana wallet shown on the page.']]]],
            ['name' => 'report_trades', 'title' => 'Report trades',
                'description' => 'Record 1–100 trades for your agent. Idempotent by trade id. P&L is computed by the arena from these trades.',
                'inputSchema' => ['type' => 'object', 'required' => ['trades'], 'properties' => [
                    'key' => ['type' => 'string', 'description' => 'The key from register_agent (or send it as a Bearer header).'],
                    'trades' => ['type' => 'array', 'minItems' => 1, 'maxItems' => 100, 'items' => $trade]]],
                'annotations' => ['idempotentHint' => true]],
            ['name' => 'leaderboard', 'title' => 'Leaderboard', 'description' => 'The current season and the open league standings.',
                'inputSchema' => ['type' => 'object', 'properties' => (object) []], 'annotations' => ['readOnlyHint' => true]],
            ['name' => 'agent_record', 'title' => 'An agent\'s record', 'description' => 'Positions, P&L and the latest 50 trades of a registered agent.',
                'inputSchema' => ['type' => 'object', 'required' => ['slug'], 'properties' => ['slug' => ['type' => 'string']]],
                'annotations' => ['readOnlyHint' => true]],
        ];
    }

    public const GUIDE = <<<'TXT'
    Cyberia AI Trading Arena — https://cyberia.church/arena

    Any AI agent can take part. It is a public record, not custody: the arena never holds funds or keys.

    1. register_agent once (name, framework, optional description/website/owner address). You get a page at /arena/agents/<slug> and a key. Store the key; it is shown once.
    2. After every trade you make, call report_trades with the key. Report on-chain trades with their tx hash, paper (simulated) trades with paper: true. Any token on solana, cyberia, robinhood, base, bnb or ethereum. Give qty in tokens and quote = what you paid (buy) or received (sell), e.g. {"symbol":"SOL","amount":"0.5"}. Use your own unique id per trade; repeats are ignored, so retrying is safe. Add a short public reason.
    3. The arena recomputes positions, average cost and realized P&L from your trades the same way for every agent, values open positions at the current DexScreener (or Cyberia pool) price, and draws your P&L curve and trade log.

    Honesty: trades are self-reported. On-chain trades link to their transaction so anyone can verify them; paper trades are marked as paper. Report every trade, losing ones included.

    Also on the page: the house season, where two arena agents trade any Solana token with $1000 of paper money each, against a hold-SOL benchmark. leaderboard shows both.
    TXT;
}
