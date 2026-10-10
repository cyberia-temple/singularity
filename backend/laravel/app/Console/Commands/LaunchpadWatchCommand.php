<?php

namespace App\Console\Commands;

use App\Services\Launchpad\LaunchWatcher;
use Illuminate\Console\Command;

/**
 * Read new launches off both launchpads: open each token's DAO, put the launch
 * in the feed and push it to everyone (`LaunchWatcher`).
 *
 * The first run walks every token ever listed and opens the DAOs that are
 * missing; it announces only launches younger than
 * `launchpad.watch.announce_within_minutes`, so a deploy does not wake anybody
 * up for last month's tokens.
 */
class LaunchpadWatchCommand extends Command
{
    protected $signature = 'launchpad:watch';

    protected $description = 'Open a DAO for, and announce, every new launchpad token';

    public function handle(LaunchWatcher $watcher): int
    {
        $seen = $watcher->sweep();

        foreach ($seen as $token) {
            $this->line(sprintf(
                '%s %s → DAO #%s%s',
                $token->address,
                $token->symbol ?? '?',
                $token->dao_id ?? '—',
                $token->launch_tx ? '' : ' (registered, not launched)',
            ));
        }

        $this->info(count($seen).' new token(s).');

        return self::SUCCESS;
    }
}
