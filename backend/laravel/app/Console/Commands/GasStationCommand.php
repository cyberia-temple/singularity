<?php

namespace App\Console\Commands;

use App\Models\GasSponsorship;
use App\Services\GasSponsorService;
use App\Services\TelegramOpsNotifier;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * Where the gas station stands, and a shout when it is about to stop working.
 *
 * There are two ways for sponsored fees to quietly die, and the difference is
 * the whole reason this command exists: the tank runs out of CYBER to give
 * away, or the operator key runs out of CYBER to pay for giving it away. Both
 * look identical from the outside — the button stops working — and the second
 * one has already happened once on this host, to the bridge relayer, unnoticed
 * for hours.
 *
 * Reads only. Funding, policy and pausing are `scripts/gas-station.ts`, which
 * takes a key; this takes none.
 */
#[Signature('gas:station {--alert : Report to the operator when the tank or the key is low}')]
#[Description('Show the wallet gas station: tank, operator key, and what it has served')]
class GasStationCommand extends Command
{
    /** The least time between two shouts about the same problem. */
    private const ALERT_SILENCE_HOURS = 6;

    /** How long a reported warning is remembered, so a repeat has a baseline. */
    private const ALERT_MEMORY_DAYS = 30;

    /** Every warning this command can raise, so a cleared one can be forgotten. */
    private const ALERT_IDS = ['paused', 'tank', 'operator'];

    public function handle(GasSponsorService $sponsor, TelegramOpsNotifier $telegram): int
    {
        if (! $sponsor->enabled()) {
            $this->warn('Sponsored fees are off.');
            $this->line(match (true) {
                ! (bool) config('wallet.sponsor.enabled') => '  WALLET_GAS_SPONSOR_ENABLED is false.',
                $sponsor->station() === null => '  WALLET_GAS_STATION_ADDRESS is unset — deploy scripts/deploy-gas-station.ts first.',
                default => '  GAS_SPONSOR_PRIVATE_KEY is unset. There is deliberately no fallback to the bridge relayer key.',
            });

            return self::SUCCESS;
        }

        $summary = $sponsor->summary();

        if ($summary === null) {
            $this->error('The station could not be read. This is an RPC problem, not an empty tank.');

            return self::FAILURE;
        }

        $operator = $sponsor->operatorAddress();
        $operatorBalance = $operator === null ? null : $sponsor->nativeBalance($operator);
        $drip = $summary['drip'] === '0' ? '1' : $summary['drip'];
        $dripsLeft = (int) bcdiv($summary['tank'], $drip, 0);
        $servedToday = GasSponsorship::where('created_at', '>=', now()->startOfDay())->count();

        $this->line('Station:  '.$sponsor->station().($summary['paused'] ? '  [PAUSED]' : ''));
        $this->line('Tank:     '.$this->cyber($summary['tank']).' CYBER  ('.$dripsLeft.' drips left)');
        $this->line('Drip:     '.$this->cyber($summary['drip']).' CYBER per claim, '
            .'ceiling '.$this->cyber($summary['ceiling']).', cooldown '.round($summary['cooldown'] / 3600, 1).'h');
        $this->line('Today:    '.$this->cyber($summary['remainingToday']).' CYBER left of '
            .$this->cyber($summary['dailyCap']).' cap, '.$servedToday.' served');
        $this->line('Lifetime: '.$summary['served'].' drips, '.$this->cyber($summary['spent']).' CYBER');
        $this->line('Operator: '.($operator ?? 'unreadable key').'  '
            .($operatorBalance === null ? '(balance unreadable)' : $this->cyber($operatorBalance).' CYBER'));

        $warnings = $this->warnings($summary, $dripsLeft, $operatorBalance);

        foreach ($warnings as $warning) {
            $this->warn($warning['text']);
        }

        if ($this->option('alert')) {
            // Before anything is sent: a problem that has gone away is
            // forgotten, so the next time it appears it is news again.
            $this->forgetCleared($warnings);

            if ($warnings !== []) {
                $this->notifyOperator($telegram, $warnings, $summary, $dripsLeft);
            }
        }

        return self::SUCCESS;
    }

    /**
     * What is wrong right now, as facts rather than as sentences.
     *
     * Each warning carries a `measure` that *falls* as the problem gets worse,
     * because that is the only thing that makes a repeat worth sending. A
     * paused station has none — it is a state, not a quantity — and is said
     * once until it clears.
     *
     * @param  array{tank: string, drip: string, ceiling: string, cooldown: int, dailyCap: string, remainingToday: string, served: int, spent: string, paused: bool}  $summary
     * @return array<int, array{id: string, text: string, measure: ?string}>
     */
    private function warnings(array $summary, int $dripsLeft, ?string $operatorBalance): array
    {
        $warnings = [];

        if ($summary['paused']) {
            $warnings[] = [
                'id' => 'paused',
                'text' => 'The station is paused: nobody is being sponsored.',
                'measure' => null,
            ];
        }

        if ($dripsLeft < (int) config('wallet.sponsor.low_water_drips', 50)) {
            $warnings[] = [
                'id' => 'tank',
                'text' => 'Tank low: '.$dripsLeft.' drips left ('.$this->cyber($summary['tank']).' CYBER).',
                'measure' => (string) $dripsLeft,
            ];
        }

        $minimum = (string) config('wallet.sponsor.operator_min_wei', '0');

        if ($operatorBalance !== null && bccomp($operatorBalance, $minimum) < 0) {
            $warnings[] = [
                'id' => 'operator',
                'text' => 'Operator key low: '.$this->cyber($operatorBalance)
                    .' CYBER. It pays the gas that delivers each drip, so a full tank behind it sponsors nobody.',
                'measure' => $operatorBalance,
            ];
        }

        return $warnings;
    }

    /**
     * @param  array<int, array{id: string, text: string, measure: ?string}>  $warnings
     * @param  array<string, mixed>  $summary
     */
    private function notifyOperator(
        TelegramOpsNotifier $telegram,
        array $warnings,
        array $summary,
        int $dripsLeft,
    ): void {
        // Nothing is said unless at least one of these is news. The whole list
        // then goes out together, because the operator is being interrupted
        // once and should see the state of the station rather than one line of
        // it — and everything in the message is re-baselined, since it has
        // just been reported.
        if (array_filter($warnings, fn (array $warning) => $this->isNews($warning)) === []) {
            return;
        }

        $sent = $telegram->send(
            "⛽ <b>Cyberia gas station</b>\n\n"
            .implode("\n", array_map(fn (array $warning) => '• '.e($warning['text']), $warnings))
            ."\n\nTank: ".$this->cyber((string) $summary['tank']).' CYBER ('.$dripsLeft.' drips)'
            ."\nRefill: <code>npx tsx scripts/gas-station.ts fund &lt;station&gt; &lt;cyber&gt;</code>",
        );

        if ($sent) {
            $this->remember($warnings);
        }
    }

    /**
     * Whether this warning is worth interrupting somebody for again.
     *
     * The old rule was a six-hour silence keyed on the text of the warning,
     * and the text carries a live balance: the operator key loses a little to
     * every drip it delivers, so the key changed on nearly every sweep and the
     * same problem was announced hourly. The number has to get *materially*
     * worse, and materially means halved — "lower than last time" is true of a
     * draining balance on every single run.
     *
     * @param  array{id: string, text: string, measure: ?string}  $warning
     */
    private function isNews(array $warning): bool
    {
        $last = Cache::get($this->alertKey($warning['id']));

        if (! is_array($last)) {
            return true;
        }

        // A state rather than a quantity: said when it appears, and again only
        // after it has cleared and come back.
        if ($warning['measure'] === null || ($last['measure'] ?? null) === null) {
            return false;
        }

        if ((int) ($last['at'] ?? 0) > now()->subHours(self::ALERT_SILENCE_HOURS)->getTimestamp()) {
            return false;
        }

        // Integer division, so a last-reported 1 makes only 0 news.
        return bccomp($warning['measure'], bcdiv((string) $last['measure'], '2', 0), 0) <= 0;
    }

    /** @param  array<int, array{id: string, text: string, measure: ?string}>  $warnings */
    private function remember(array $warnings): void
    {
        foreach ($warnings as $warning) {
            Cache::put(
                $this->alertKey($warning['id']),
                ['measure' => $warning['measure'], 'at' => now()->getTimestamp()],
                now()->addDays(self::ALERT_MEMORY_DAYS),
            );
        }
    }

    /**
     * Forget every problem that is no longer one.
     *
     * A refilled tank draining again is news, not a repeat, and it would never
     * be announced if the baseline from the last drought survived it.
     *
     * @param  array<int, array{id: string, text: string, measure: ?string}>  $warnings
     */
    private function forgetCleared(array $warnings): void
    {
        $raised = array_column($warnings, 'id');

        foreach (self::ALERT_IDS as $id) {
            if (! in_array($id, $raised, true)) {
                Cache::forget($this->alertKey($id));
            }
        }
    }

    private function alertKey(string $id): string
    {
        return 'wallet.gas-station:alerted:'.$id;
    }

    /** Wei to CYBER, as a string — the amounts here overflow PHP's integers. */
    private function cyber(string $wei): string
    {
        return rtrim(rtrim(bcdiv($wei, '1000000000000000000', 6), '0'), '.') ?: '0';
    }
}
