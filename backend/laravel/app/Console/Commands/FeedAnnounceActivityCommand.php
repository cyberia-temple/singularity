<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Notifications\CommunityNotification;
use App\Services\Social\Broadcaster;
use App\Support\ChainActivity;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

/**
 * Tell everyone about everything that happens on chain.
 *
 * Swaps, liquidity, lending, staking, conversions, bridges and mints are not
 * made through this app — anybody can call the contracts — so they are not an
 * action Laravel sees happen. The Telegram bot reads them off the chain into
 * `activity_events`, and this walks that table forward from a cursor and
 * pushes every new row through the same `Broadcaster` as posts and votes.
 *
 * Every row, of every kind and every size: the project is small enough that
 * each of these is news, which is the operator's call and the reason the
 * dollar floor (`wallet.feed.trade_floor_usd`) now defaults to zero. Set it
 * and only rows priced at or above it are pushed — an unpriced row is then
 * left out too, since nothing says it cleared the bar.
 *
 * The cursor starts at the table's current end: a first run (or a flushed
 * cache) announces nothing and only marks where "new" begins, because the
 * alternative is a thousand old swaps arriving on everybody's phone at once.
 * It keeps the key it had when only swaps were announced, so the switch to
 * every kind neither replays nor skips anything.
 */
class FeedAnnounceActivityCommand extends Command
{
    protected $signature = 'feed:announce-activity {--dry-run : List what would be announced and move nothing}';

    protected $description = 'Push every new on-chain action from activity_events to everyone subscribed';

    /** What this was called while it announced swaps only. */
    protected $aliases = ['feed:announce-trades'];

    public const CURSOR = 'feed.trades.announced_id';

    /** One run's worth; a backlog drains over the next runs instead of in one burst. */
    private const BATCH = 20;

    public function handle(Broadcaster $broadcaster): int
    {
        if (! Schema::hasTable('activity_events')) {
            $this->info('No activity_events table — the Telegram bot has not run here.');

            return self::SUCCESS;
        }

        $cursor = Cache::get(self::CURSOR);

        if ($cursor === null) {
            $end = (int) DB::table('activity_events')->max('id');
            $this->option('dry-run') || Cache::forever(self::CURSOR, $end);
            $this->info("Cursor started at {$end}; nothing announced.");

            return self::SUCCESS;
        }

        $rows = DB::table('activity_events')
            ->where('id', '>', (int) $cursor)
            ->orderBy('id')
            ->limit(self::BATCH)
            ->get();

        $floor = (float) config('wallet.feed.trade_floor_usd');
        $announced = 0;

        foreach ($rows as $row) {
            if ($floor <= 0 || ($row->usd !== null && (float) $row->usd >= $floor)) {
                $notification = $this->notification($row);

                if ($this->option('dry-run')) {
                    $this->line("#{$row->id} {$row->kind} ".$notification->params['amounts']);
                } else {
                    $broadcaster->broadcast($notification, $notification->actor?->id);
                }

                $announced++;
            }

            if (! $this->option('dry-run')) {
                Cache::forever(self::CURSOR, (int) $row->id);
            }
        }

        $this->info("Announced {$announced} of {$rows->count()} new events.");

        return self::SUCCESS;
    }

    private function actor(object $row): ?User
    {
        return ! is_string($row->user_addr) || ! preg_match('/^0x[0-9a-fA-F]{40}$/', $row->user_addr)
            ? null
            : User::query()->whereRaw('lower(wallet_address) = ?', [Str::lower($row->user_addr)])->first();
    }

    private function notification(object $row): CommunityNotification
    {
        $actor = $this->actor($row);
        $usd = ChainActivity::usd($row->usd);
        $detail = ChainActivity::detail($row);
        $line = collect([ChainActivity::amounts($row), $detail, $usd])->filter()->implode(' · ');

        return new CommunityNotification(
            // Swaps keep the type they always had; the rest are named by kind.
            type: $row->kind === 'swap' ? 'trade' : 'chain.'.$row->kind,
            actor: $actor,
            title: ChainActivity::title((string) $row->kind),
            body: ['en' => '{line}', 'ru' => '{line}', 'zh' => '{line}'],
            params: [
                'name' => $actor?->onchain_nickname ?: ($actor?->name
                    ?: (is_string($row->user_addr) && $row->user_addr !== '' && $row->user_addr !== '?'
                        ? ChainActivity::short($row->user_addr)
                        : 'Someone')),
                'line' => $line !== '' ? $line : '—',
                'amounts' => ChainActivity::amounts($row) ?? '—',
            ],
            url: '/wallet?section=feed',
        );
    }
}
