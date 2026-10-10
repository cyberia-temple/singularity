<?php

namespace App\Services\Launchpad;

use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\User;
use App\Notifications\CommunityNotification;
use App\Services\Dao\TokenDaoOpener;
use App\Services\Social\Broadcaster;
use App\Support\ChainActivity;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * What happens when somebody launches a token: its DAO opens, the feed says so
 * and everybody's phone does too.
 *
 * Launches are read from the launchpads, never reported to this server: the
 * wallet, `/launchpad`, LainOS and a raw contract call all end in the same
 * `allTokens` array, so walking it is the one way to see every launch, and a
 * launch whose creator never signed any metadata is seen exactly like one with
 * a page and a logo. Each contract keeps its own cursor (the next index to
 * read); the cursor only moves past a token once that token is recorded, so an
 * RPC that blinks mid-walk resumes where it stopped.
 *
 * Who launched it and when come from the launch's own `TokenLaunched` log —
 * neither launchpad stores a creator. The node answers log queries over a
 * thousand blocks at most (~16 minutes here), which covers a launch seen by
 * the per-minute sweep or by the nudge the launch screens send; anything older
 * (a first run, an outage) is looked up in the explorer's index of the
 * launchpad's logs instead. A token with no such log was *registered* rather
 * than launched (LAIN, MINE) and gets its DAO without an announcement.
 *
 * Everything here is idempotent: a token row that already carries its launch
 * transaction is never announced again, so a flushed cursor re-walks the list
 * and changes nothing.
 */
class LaunchWatcher
{
    public const CURSOR = 'launchpad.watch.next.';

    /** allTokensLength() */
    private const ALL_TOKENS_LENGTH = '0xdbb80e42';

    /** allTokens(uint256) */
    private const ALL_TOKENS = '0x634282af';

    /** name() / symbol() */
    private const NAME = '0x06fdde03';

    private const SYMBOL = '0x95d89b41';

    /**
     * TokenLaunched on LaunchpadNative (eight fields, the burned LP last) and
     * on LaunchpadV3 (seven): different signatures, so different topics, with
     * the token and the creator indexed in the same places on both.
     */
    public const LAUNCHED_TOPICS = [
        '0xd1cd76aa6daea4d12bd787f48fe33ae83cf1fc3560e564b2b714c26721000339',
        '0x95ebb4dff327b9c917a28dd992a9a3d878cc15e61c709003998849c71b911799',
    ];

    /** The widest block range this node will search for logs. */
    private const LOG_RANGE = 1000;

    /** Explorer pages read per launchpad when the node's window misses. */
    private const EXPLORER_PAGES = 20;

    /** @var array<string, array<string, array{creator: string, tx: string, block: int}>> */
    private array $explorerLaunches = [];

    public function __construct(
        private TokenDaoOpener $daos,
        private Broadcaster $broadcaster,
    ) {}

    /**
     * Walk every launchpad from its cursor.
     *
     * @return list<LaunchpadToken> tokens recorded by this sweep
     */
    public function sweep(): array
    {
        // The scheduler and a launch screen's nudge can arrive together; the
        // second simply finds nothing left to do.
        $lock = Cache::lock('launchpad:watch', 120);

        if (! $lock->get()) {
            return [];
        }

        $this->explorerLaunches = [];

        try {
            $seen = [];

            foreach ((array) config('launchpad.watch.contracts', []) as $contract) {
                try {
                    array_push($seen, ...$this->walk(Str::lower((string) $contract)));
                } catch (Throwable $e) {
                    Log::warning('launchpad:watch could not read a launchpad', [
                        'contract' => $contract,
                        'error' => $e->getMessage(),
                    ]);
                }
            }

            return $seen;
        } finally {
            $lock->release();
        }
    }

    /** @return list<LaunchpadToken> */
    private function walk(string $contract): array
    {
        $length = $this->uint($this->call($contract, self::ALL_TOKENS_LENGTH));
        $key = self::CURSOR.$contract;
        $seen = [];

        for ($index = (int) Cache::get($key, 0); $index < $length; $index++) {
            $token = $this->address($this->call($contract, self::ALL_TOKENS.str_pad(dechex($index), 64, '0', STR_PAD_LEFT)));
            $seen[] = $this->record($contract, $token);
            Cache::forever($key, $index + 1);
        }

        return $seen;
    }

    private function record(string $contract, string $token): LaunchpadToken
    {
        // firstOrCreate rather than firstOrNew: the creator's metadata may be
        // landing in the same second, and createOrFirst settles that race on
        // the unique index instead of losing one of the two writes.
        $row = LaunchpadToken::query()->firstOrCreate([
            'chain_id' => (int) config('launchpad.watch.chain_id', 49406),
            'address' => $token,
        ]);

        $launch = $row->launch_tx === null ? $this->launchOf($contract, $token) : null;

        // What the creator signed wins over what the contract says: the chain
        // fills only what nobody has written yet.
        if (blank($row->name)) {
            $row->name = Str::limit((string) $this->text($token, self::NAME), 100, '') ?: null;
        }

        if (blank($row->symbol)) {
            $row->symbol = Str::limit((string) $this->text($token, self::SYMBOL), 32, '') ?: null;
        }

        if ($launch !== null) {
            // The launch's sender is who the metadata endpoint will let edit
            // this row; a creator who already signed is the same key anyway.
            $row->creator ??= $launch['creator'];
            $row->launch_tx = $launch['tx'];
            $row->launch_block = $launch['block'];
            $row->launched_at = $this->blockTime($launch['block']) ?? now();
        }

        $row->save();

        $dao = $this->daos->open($row);

        $window = (int) config('launchpad.watch.announce_within_minutes', 60);

        if ($launch !== null && $row->launched_at->greaterThanOrEqualTo(now()->subMinutes($window))) {
            $this->announce($row, $dao);
        }

        return $row;
    }

    /**
     * The launch's creator, transaction and block — from the node if it is
     * recent, from the explorer's index if it is not, null if the token was
     * registered rather than launched.
     *
     * @return array{creator: string, tx: string, block: int}|null
     */
    private function launchOf(string $contract, string $token): ?array
    {
        $head = $this->uint($this->rpc('eth_blockNumber', []));
        $logs = $this->rpc('eth_getLogs', [[
            'address' => $contract,
            'fromBlock' => '0x'.dechex(max(0, $head - self::LOG_RANGE + 1)),
            'toBlock' => '0x'.dechex($head),
            'topics' => [self::LAUNCHED_TOPICS, '0x'.str_pad(substr($token, 2), 64, '0', STR_PAD_LEFT)],
        ]]);

        foreach (is_array($logs) ? $logs : [] as $log) {
            if (is_array($log) && ($launch = $this->parseLog($log)) !== null) {
                return $launch;
            }
        }

        return $this->explorerLaunches($contract)[$token] ?? null;
    }

    /**
     * Every launch the explorer has indexed for one launchpad, read once per
     * sweep. Best effort: an explorer that does not answer means "no launch
     * found", which costs an announcement and never a DAO.
     *
     * @return array<string, array{creator: string, tx: string, block: int}>
     */
    private function explorerLaunches(string $contract): array
    {
        if (isset($this->explorerLaunches[$contract])) {
            return $this->explorerLaunches[$contract];
        }

        $found = [];
        $query = [];
        $base = rtrim((string) config('launchpad.watch.explorer_api'), '/');

        try {
            for ($page = 0; $page < self::EXPLORER_PAGES; $page++) {
                $response = Http::timeout(15)->acceptJson()->get("{$base}/addresses/{$contract}/logs", $query);

                if (! $response->successful()) {
                    break;
                }

                foreach ((array) $response->json('items', []) as $item) {
                    $launch = is_array($item) ? $this->parseLog([
                        'topics' => $item['topics'] ?? [],
                        'transactionHash' => $item['transaction_hash'] ?? null,
                        'blockNumber' => isset($item['block_number']) ? '0x'.dechex((int) $item['block_number']) : null,
                    ]) : null;

                    if ($launch !== null) {
                        $topic = (string) $item['topics'][1];
                        $found['0x'.Str::lower(substr($topic, -40))] = $launch;
                    }
                }

                $next = $response->json('next_page_params');

                if (! is_array($next) || $next === []) {
                    break;
                }

                $query = $next;
            }
        } catch (Throwable $e) {
            Log::info('launchpad:watch explorer lookup failed', ['contract' => $contract, 'error' => $e->getMessage()]);
        }

        return $this->explorerLaunches[$contract] = $found;
    }

    /**
     * @param  array<string, mixed>  $log
     * @return array{creator: string, tx: string, block: int}|null
     */
    private function parseLog(array $log): ?array
    {
        $topics = array_values(array_filter((array) ($log['topics'] ?? []), 'is_string'));

        if (count($topics) < 3 || ! in_array(Str::lower($topics[0]), self::LAUNCHED_TOPICS, true)) {
            return null;
        }

        $tx = $log['transactionHash'] ?? null;
        $block = $log['blockNumber'] ?? null;

        if (! is_string($tx) || ! preg_match('/^0x[0-9a-fA-F]{64}$/', $tx) || ! is_string($block)) {
            return null;
        }

        return [
            'creator' => '0x'.Str::lower(substr($topics[2], -40)),
            'tx' => Str::lower($tx),
            'block' => $this->uint($block),
        ];
    }

    private function announce(LaunchpadToken $row, Dao $dao): void
    {
        $creator = $row->creator ? User::query()
            ->whereRaw('lower(wallet_address) = ?', [Str::lower($row->creator)])
            ->oldest('id')
            ->first() : null;

        $notification = new CommunityNotification(
            type: 'launch',
            actor: $creator,
            title: ['en' => 'New token: {symbol}', 'ru' => 'Новый токен: {symbol}', 'zh' => '新代币：{symbol}'],
            body: [
                'en' => '{name} · launched by {who} · its DAO is open',
                'ru' => '{name} · запустил {who} · DAO токена уже открыто',
                'zh' => '{name} · 由 {who} 发行 · 代币 DAO 已开放',
            ],
            params: [
                'symbol' => Str::limit((string) ($row->symbol ?: $row->name ?: ChainActivity::short($row->address)), 32),
                'name' => Str::limit((string) ($row->name ?: $dao->name), 60),
                'who' => $creator?->onchain_nickname ?: ($creator?->name
                    ?: ($row->creator ? ChainActivity::short($row->creator) : 'someone')),
            ],
            url: '/wallet?section=feed',
        );

        $deliver = fn () => $this->broadcaster->broadcast($notification, $creator?->id);

        // A launch screen's nudge must not wait on every push endpoint there
        // is; the scheduler and the tests have nobody waiting.
        if (app()->runningInConsole() || app()->runningUnitTests()) {
            $deliver();

            return;
        }

        dispatch($deliver)->afterResponse();
    }

    private function blockTime(int $block): ?Carbon
    {
        try {
            $result = $this->rpc('eth_getBlockByNumber', ['0x'.dechex($block), false]);
            $timestamp = is_array($result) ? ($result['timestamp'] ?? null) : null;

            return is_string($timestamp) ? Carbon::createFromTimestampUTC($this->uint($timestamp)) : null;
        } catch (Throwable) {
            return null;
        }
    }

    /** eth_call against `latest`. */
    private function call(string $to, string $data): string
    {
        $result = $this->rpc('eth_call', [['to' => $to, 'data' => $data], 'latest']);

        if (! is_string($result) || ! preg_match('/^0x[0-9a-fA-F]*$/', $result)) {
            throw new RuntimeException('eth_call returned no data');
        }

        return $result;
    }

    private function rpc(string $method, array $params): mixed
    {
        $response = Http::timeout(15)->post((string) config('launchpad.watch.rpc_url'), [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => $method,
            'params' => $params,
        ]);

        if (! $response->successful() || $response->json('error') !== null) {
            throw new RuntimeException("{$method} failed: ".($response->json('error.message') ?? $response->status()));
        }

        return $response->json('result');
    }

    /** A token's name or symbol: an ABI string, or a bytes32 on old tokens. */
    private function text(string $token, string $selector): ?string
    {
        try {
            $data = substr($this->call($token, $selector), 2);
        } catch (Throwable) {
            return null;
        }

        $bytes = null;

        if (strlen($data) >= 128) {
            $length = (int) hexdec(substr($data, 64, 64));
            $bytes = $length <= 256 ? substr($data, 128, $length * 2) : null;
        } elseif (strlen($data) === 64) {
            $bytes = rtrim($data, '0');
            $bytes .= strlen($bytes) % 2 ? '0' : '';
        }

        $decoded = is_string($bytes) && ctype_xdigit($bytes) ? hex2bin($bytes) : false;

        if ($decoded === false) {
            return null;
        }

        $clean = trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', mb_scrub($decoded, 'UTF-8')));

        return $clean === '' ? null : $clean;
    }

    private function uint(mixed $hex): int
    {
        $digits = ltrim(substr((string) $hex, 2), '0');

        return $digits === '' ? 0 : (int) hexdec(substr($digits, -15));
    }

    private function address(string $word): string
    {
        return '0x'.Str::lower(substr($word, -40));
    }
}
