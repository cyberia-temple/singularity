<?php

namespace App\Console\Commands;

use App\Models\ReplaySession;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;

/**
 * Delete session recordings past the retention window — the chunk files and,
 * through the foreign keys, every page, click and error row that points at
 * them. A recording is for finding what is broken this month; a year of
 * everybody's pointer is a liability, not an asset.
 *
 * Directories with no session row (a refusal that arrived before its first
 * chunk was filed, a crash between file and row) go too once they are old.
 */
class ReplayPruneCommand extends Command
{
    protected $signature = 'replay:prune {--days= : override the configured retention}';

    protected $description = 'Delete session recordings older than the retention window';

    public function handle(): int
    {
        $days = (int) ($this->option('days') ?? config('replay.keep_days', 30));

        if ($days < 1) {
            $this->error('Retention must be at least one day.');

            return self::FAILURE;
        }

        $cutoff = Carbon::now()->subDays($days);
        $deleted = 0;

        ReplaySession::query()
            ->where('updated_at', '<', $cutoff)
            ->select('id')
            ->chunkById(200, function ($sessions) use (&$deleted): void {
                foreach ($sessions as $session) {
                    $session->forget();
                    $deleted++;
                }
            });

        $disk = Storage::disk('local');
        $orphans = 0;

        foreach ($disk->directories('replay') as $directory) {
            $id = basename($directory);

            if (! ReplaySession::query()->whereKey($id)->exists() && $disk->lastModified($directory) < $cutoff->getTimestamp()) {
                $disk->deleteDirectory($directory);
                $orphans++;
            }
        }

        $this->info("Pruned {$deleted} recordings and {$orphans} orphaned directories older than {$days} days.");

        return self::SUCCESS;
    }
}
