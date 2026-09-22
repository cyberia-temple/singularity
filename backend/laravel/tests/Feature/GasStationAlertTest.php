<?php

use App\Services\GasSponsorService;
use App\Services\TelegramOpsNotifier;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Mockery\MockInterface;

/**
 * When the gas station is allowed to interrupt somebody.
 *
 * The station is watched hourly and the thing it watches drains: the operator
 * key pays the gas that delivers every drip, so its balance is a slightly
 * different number on every sweep. The first version of this alert keyed its
 * silence window on the *text* of the warning — which carries that balance —
 * so the same unchanged problem was announced as new roughly every hour, and
 * the channel it announces into is the one channel this project has.
 *
 * What is pinned here is therefore not the wording but the rule: a problem is
 * said once, again only when the number behind it has materially fallen, and
 * once more if it clears and comes back.
 */
$station = function (array $overrides = []) {
    $summary = array_merge([
        'tank' => '980000000000000000',          // 0.98 CYBER
        'drip' => '10000000000000000',           // 0.01 CYBER — 98 drips
        'ceiling' => '50000000000000000',
        'cooldown' => 86400,
        'dailyCap' => '1000000000000000000',
        'remainingToday' => '1000000000000000000',
        'served' => 12,
        'spent' => '120000000000000000',
        'paused' => false,
    ], $overrides['summary'] ?? []);

    test()->mock(GasSponsorService::class, function (MockInterface $mock) use ($summary, $overrides) {
        $mock->shouldReceive('enabled')->andReturn(true);
        $mock->shouldReceive('station')->andReturn('0xA21300000000000000000000000000000000E7b2');
        $mock->shouldReceive('summary')->andReturn($summary);
        $mock->shouldReceive('operatorAddress')->andReturn('0x1111111111111111111111111111111111111111');
        $mock->shouldReceive('nativeBalance')->andReturn(
            $overrides['operator'] ?? '48417000000000000',  // 0.048417 CYBER
        );
    });
};

/** How many times Telegram was actually asked to carry a message. */
function opsSends(): int
{
    return (int) app(TelegramOpsNotifier::class)->sent;
}

beforeEach(function () {
    Cache::flush();
    config()->set('wallet.sponsor.low_water_drips', 50);
    config()->set('wallet.sponsor.operator_min_wei', '50000000000000000');

    // A stand-in for the one ops channel: it says the message was delivered,
    // which is what decides whether the command remembers having sent it.
    app()->instance(TelegramOpsNotifier::class, new class extends TelegramOpsNotifier
    {
        public int $sent = 0;

        public function send(string $text, string $channel = self::OPS): bool
        {
            $this->sent++;

            return true;
        }
    });
});

it('says a low operator key once and then stops repeating it', function () use ($station) {
    $station();
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);

    // An hour later, one drip poorer. The problem is the same problem; the
    // number in the sentence is not, and that used to be enough to resend it.
    Carbon::setTestNow(now()->addHour());
    $station(['operator' => '48000000000000000']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);

    // A day of that, still above half of what was reported.
    Carbon::setTestNow(now()->addDay());
    $station(['operator' => '30000000000000000']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);
});

it('speaks up again once the number behind it has halved', function () use ($station) {
    $station();
    $this->artisan('gas:station --alert')->assertSuccessful();

    Carbon::setTestNow(now()->addHours(7));
    $station(['operator' => '20000000000000000']);   // under half of 0.048417
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(2);
});

it('holds its tongue for the silence window even when the number collapses', function () use ($station) {
    $station();
    $this->artisan('gas:station --alert')->assertSuccessful();

    Carbon::setTestNow(now()->addMinutes(30));
    $station(['operator' => '1']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);
});

it('treats a problem that cleared and came back as news', function () use ($station) {
    $station();
    $this->artisan('gas:station --alert')->assertSuccessful();

    // Topped up: nothing is wrong, nothing is said, and the baseline goes.
    Carbon::setTestNow(now()->addHour());
    $station(['operator' => '900000000000000000']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);

    // Drained again to exactly where it was. Same number, different drought.
    Carbon::setTestNow(now()->addHour());
    $station(['operator' => '48417000000000000']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(2);
});

it('says a paused station once and does not nag about a state', function () use ($station) {
    $station([
        'summary' => ['paused' => true],
        'operator' => '900000000000000000',
    ]);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);

    Carbon::setTestNow(now()->addDays(3));
    $station([
        'summary' => ['paused' => true],
        'operator' => '900000000000000000',
    ]);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(1);
});

it('never opens its mouth when the station is healthy', function () use ($station) {
    $station(['operator' => '900000000000000000']);
    $this->artisan('gas:station --alert')->assertSuccessful();

    expect(opsSends())->toBe(0);
});
