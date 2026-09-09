<?php

namespace App\Console\Commands;

use App\Models\BridgeRequest;
use App\Services\BridgeDepositCredit;
use App\Services\BridgeDepositWatcher;
use Illuminate\Console\Command;

/**
 * Credit the deposits nobody is sitting there waiting for.
 *
 * A corridor whose deposit is bound to an address rather than to a signed
 * transaction has no event to react to: the coins arrive on the chain, and
 * this server finds out only by looking. Yenten could get away with the user
 * pressing a button, because one confirmation is about a minute. Monero
 * cannot — ten confirmations is twenty minutes, and a bridge that only works
 * while a browser tab stays open is a bridge that strands people's money in a
 * wallet they cannot see.
 *
 * So this is the other half of the claim endpoint, and deliberately the same
 * code underneath: `BridgeDepositCredit` decides, this only chooses who to ask
 * about. Reading is free and idempotent — a request already credited is no
 * longer awaiting a deposit, so it is not in the set at all.
 */
class BridgeSweepDepositsCommand extends Command
{
    protected $signature = 'bridge:sweep-deposits
        {--chain= : Only this source chain (monero, yenten)}
        {--limit=25 : How many requests to look at in one run}';

    protected $description = 'Credit deposits that landed on one-time bridge addresses (Monero, Yenten)';

    public function handle(BridgeDepositCredit $credit, BridgeDepositWatcher $watcher): int
    {
        $chains = collect(config('bridge.chains', []))
            ->filter(fn (array $chain) => $watcher->supports($chain))
            ->keys()
            ->all();

        if ($only = $this->option('chain')) {
            $chains = array_values(array_intersect($chains, [(string) $only]));

            if ($chains === []) {
                $this->error("'{$only}' is not a chain whose deposits land on a one-time address.");

                return self::FAILURE;
            }
        }

        // Oldest first: a deposit that has been waiting longest is the one
        // closest to its window closing, and the run is capped so a backlog
        // drains over several runs instead of holding the scheduler open.
        $requests = BridgeRequest::query()
            ->where('status', BridgeRequest::AWAITING_DEPOSIT)
            ->whereIn('source_chain', $chains)
            ->whereNotNull('deposit_address')
            ->oldest('id')
            ->limit(max(1, (int) $this->option('limit')))
            ->get();

        if ($requests->isEmpty()) {
            $this->info('No deposit addresses are being watched.');

            return self::SUCCESS;
        }

        $credited = 0;
        $expired = 0;

        foreach ($requests as $request) {
            $outcome = $credit->credit($request);

            if ($outcome->credited) {
                $credited++;
                $this->info("#{$request->id} {$request->source_chain}: credited {$request->fresh()->amount} {$request->token}");

                continue;
            }

            if ($outcome->expired) {
                $expired++;
                $this->line("#{$request->id} {$request->source_chain}: window closed, nothing arrived");

                continue;
            }

            $this->line("#{$request->id} {$request->source_chain}: {$outcome->message}");
        }

        $this->info("Looked at {$requests->count()}: {$credited} credited, {$expired} expired.");

        return self::SUCCESS;
    }
}
