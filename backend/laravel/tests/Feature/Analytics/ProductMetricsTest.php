<?php

use App\Models\AnalyticsAddress;
use App\Services\Analytics\AnalyticsFilters;
use App\Services\Analytics\ProductMetricsService;
use Illuminate\Support\Carbon;

/**
 * The definitions, tested as definitions.
 *
 * Each of these numbers is one somebody will make a decision on, and each has
 * a plausible wrong version: WAU that counts people who opened the app, a
 * North Star that counts addresses instead of people, a retention bucket that
 * reports 0% because the cohort is three days old, a success rate that folds
 * in the swaps nobody signed. Those wrong versions are what is being ruled out
 * here, not the arithmetic.
 */
function metrics(): ProductMetricsService
{
    return app(ProductMetricsService::class);
}

function lastDays(int $days = 30): AnalyticsFilters
{
    return new AnalyticsFilters(
        from: Carbon::now('UTC')->subDays($days)->startOfDay(),
        to: Carbon::now('UTC'),
    );
}

/* ----------------------------------------------------------- north star -- */

test('weekly active funded users needs both halves', function () {
    $now = Carbon::now('UTC');

    // Funded and active: counts.
    $counted = installation(['funded_at' => $now->copy()->subDays(10)]);
    logEvent($counted, 'swap_completed', $now->copy()->subDays(2));

    // Funded, but has done nothing this week — a wallet with money in it is
    // not a user of this product.
    $dormant = installation(['funded_at' => $now->copy()->subDays(10)]);
    logEvent($dormant, 'swap_completed', $now->copy()->subDays(20));

    // Active, but never funded — somebody looking around.
    $browsing = installation();
    logEvent($browsing, 'swap_completed', $now->copy()->subDay());

    // Funded and here, but only opened the app.
    $lurking = installation(['funded_at' => $now->copy()->subDays(3)]);
    logEvent($lurking, 'app_opened', $now->copy()->subHour());
    logEvent($lurking, 'swap_opened', $now->copy()->subHour());

    expect(metrics()->weeklyActiveFundedUsers(lastDays()))->toBe(1);
});

test('one person with many addresses is one weekly active funded user', function () {
    $now = Carbon::now('UTC');
    $user = installation(['funded_at' => $now->copy()->subDays(5)]);

    // The same installation, four networks, four settled actions.
    foreach (['cyberia', 'robinhood', 'bnb', 'base'] as $chain) {
        AnalyticsAddress::query()->insertOrIgnore([
            'user_id' => $user->id,
            'chain' => $chain,
            'address' => '0x'.str_pad((string) crc32($chain), 40, '0'),
            'created_at' => $now,
        ]);
        logEvent($user, 'swap_completed', $now->copy()->subDay(), ['chain' => $chain]);
    }

    expect(metrics()->weeklyActiveFundedUsers(lastDays()))->toBe(1);
});

/* ------------------------------------------------------------ activity -- */

test('WAU counts people who did something, not people who showed up', function () {
    $now = Carbon::now('UTC');

    $opened = installation();
    logEvent($opened, 'app_opened', $now->copy()->subDay());
    logEvent($opened, 'session_started', $now->copy()->subDay());
    logEvent($opened, 'swap_quote_received', $now->copy()->subDay());

    $acted = installation();
    logEvent($acted, 'transaction_confirmed', $now->copy()->subDays(3));

    $lastMonth = installation();
    logEvent($lastMonth, 'transaction_confirmed', $now->copy()->subDays(20));

    $overview = metrics()->overview(lastDays());

    expect($overview['wau'])->toBe(1)
        ->and($overview['mau'])->toBe(2);
});

/* ----------------------------------------------------------- retention -- */

test('D1 D7 and D30 are measured from activation and matured before reported', function () {
    $now = Carbon::now('UTC');

    // A cohort old enough for every bucket.
    $mature = $now->copy()->subDays(45)->startOfWeek(Carbon::MONDAY)->addDay();

    $returned = installation([
        'created_at' => $mature,
        'first_seen_at' => $mature,
        'activated_at' => $mature,
        'funded_at' => $mature,
    ]);
    logEvent($returned, 'swap_completed', $mature);
    logEvent($returned, 'swap_completed', $mature->copy()->addDay());
    logEvent($returned, 'swap_completed', $mature->copy()->addDays(6));
    logEvent($returned, 'swap_completed', $mature->copy()->addDays(29));

    $left = installation([
        'created_at' => $mature,
        'first_seen_at' => $mature,
        'activated_at' => $mature,
    ]);
    logEvent($left, 'swap_completed', $mature);

    $cohorts = collect(metrics()->retentionCohorts(lastDays(60)))
        ->firstWhere('week', $mature->copy()->startOfWeek(Carbon::MONDAY)->toDateString());

    expect($cohorts['size'])->toBe(2)
        ->and($cohorts['rates']['d1'])->toBe(50.0)
        ->and($cohorts['rates']['d7'])->toBe(50.0)
        ->and($cohorts['rates']['d30'])->toBe(50.0);
});

test('a cohort too young for a bucket reports nothing, never zero', function () {
    $now = Carbon::now('UTC');
    $fresh = $now->copy()->subDay();

    $user = installation([
        'created_at' => $fresh,
        'first_seen_at' => $fresh,
        'activated_at' => $fresh,
    ]);
    logEvent($user, 'swap_completed', $fresh);

    $cohort = collect(metrics()->retentionCohorts(lastDays()))
        ->firstWhere('week', $fresh->copy()->startOfWeek(Carbon::MONDAY)->toDateString());

    // Reporting 0% here would say "nobody came back" when it means "nobody
    // has had the chance".
    expect($cohort['rates']['d7'])->toBeNull()
        ->and($cohort['rates']['d30'])->toBeNull();
});

/* ---------------------------------------------------------- activation -- */

test('activation and funding rates are cohort rates, and the medians skip who never got there', function () {
    $now = Carbon::now('UTC');
    $start = $now->copy()->subDays(10);

    installation([
        'created_at' => $start,
        'first_seen_at' => $start,
        'funded_at' => $start->copy()->addHours(2),
        'activated_at' => $start->copy()->addHours(3),
        'first_transaction_at' => $start->copy()->addHours(3),
    ]);
    installation([
        'created_at' => $start,
        'first_seen_at' => $start,
        'funded_at' => $start->copy()->addHours(6),
    ]);
    // Installed, never funded: in the denominator, out of both medians.
    installation(['created_at' => $start, 'first_seen_at' => $start]);
    installation(['created_at' => $start, 'first_seen_at' => $start]);

    $activation = metrics()->activation(lastDays());

    expect($activation['cohort'])->toBe(4)
        ->and($activation['funded_rate'])->toBe(50.0)
        ->and($activation['activation_rate'])->toBe(25.0)
        // Median of two hours and six hours.
        ->and($activation['median_seconds_to_funding'])->toBe(4 * 3600)
        ->and($activation['median_seconds_to_first_transaction'])->toBe(3 * 3600);
});

test('the main funnel follows one cohort forward rather than counting four windows', function () {
    $now = Carbon::now('UTC');

    // Acquired inside the window, and went the whole way.
    $full = installation([
        'wallet_created_at' => $now->copy()->subDays(5),
        'funded_at' => $now->copy()->subDays(5),
        'activated_at' => $now->copy()->subDays(5),
    ]);
    logEvent($full, 'swap_completed', $now->copy()->subDays(5));
    logEvent($full, 'swap_completed', $now->copy()->subDays(2));

    // Acquired and stopped at a wallet.
    installation(['wallet_created_at' => $now->copy()->subDays(4)]);

    // Acquired long before the window: must not enter this cohort at all,
    // however busy they have been inside it.
    $old = installation([
        'created_at' => $now->copy()->subDays(200),
        'first_seen_at' => $now->copy()->subDays(200),
        'wallet_created_at' => $now->copy()->subDays(200),
        'funded_at' => $now->copy()->subDays(200),
        'activated_at' => $now->copy()->subDays(200),
    ]);
    logEvent($old, 'swap_completed', $now->copy()->subDay());

    $funnel = collect(metrics()->mainFunnel(lastDays()))->keyBy('key');

    expect($funnel['first_open']['value'])->toBe(2)
        ->and($funnel['wallet']['value'])->toBe(2)
        ->and($funnel['funded']['value'])->toBe(1)
        ->and($funnel['activated']['value'])->toBe(1)
        // Retained: a settled action at least a day after activation.
        ->and($funnel['retained']['value'])->toBe(1)
        ->and($funnel['funded']['of_top'])->toBe(50.0);
});

/* ------------------------------------------------------------- product -- */

test('success rate counts from the signature, not from the screen', function () {
    $now = Carbon::now('UTC');
    $user = installation();

    // Three people opened the send screen and walked away; that is not a
    // failure, and must not appear in this ratio at all.
    logEvent($user, 'transaction_started', $now);
    logEvent($user, 'transaction_started', $now);
    logEvent($user, 'transaction_started', $now);

    logEvent($user, 'transaction_submitted', $now);
    logEvent($user, 'transaction_confirmed', $now);
    logEvent($user, 'transaction_confirmed', $now);
    logEvent($user, 'transaction_confirmed', $now);
    logEvent($user, 'transaction_failed', $now, ['error_code' => 'insufficient_gas']);

    $overview = metrics()->overview(lastDays());

    expect($overview['transaction_success_rate'])->toBe(75.0)
        ->and($overview['error_rate'])->toBe(25.0);
});

test('a quote that found no route is an error but not a failed swap', function () {
    $now = Carbon::now('UTC');
    $user = installation();

    logEvent($user, 'swap_signed', $now);
    logEvent($user, 'swap_completed', $now, ['amount_usd' => 100.0]);
    logEvent($user, 'swap_quote_failed', $now, ['error_code' => 'no_route']);
    logEvent($user, 'swap_quote_failed', $now, ['error_code' => 'no_route']);

    $swap = metrics()->outcomeRate(lastDays(), 'swap');
    $errors = collect(metrics()->errors(lastDays()));

    // Nobody signed those quotes, so the swap that did work is 100%.
    expect($swap['rate'])->toBe(100.0)
        // And the reason people could not trade is still on the dashboard.
        ->and($errors->firstWhere('error_code', 'no_route')['total'])->toBe(2);
});

test('volume sums only the rows that carried a price', function () {
    $now = Carbon::now('UTC');
    $user = installation();

    logEvent($user, 'swap_completed', $now, ['amount_usd' => 42.5]);
    logEvent($user, 'swap_completed', $now, ['amount_usd' => 7.5]);
    // An unpriced asset: counted as an action, contributing nothing to volume.
    logEvent($user, 'swap_completed', $now, ['chain' => 'cyberia']);

    $usage = collect(metrics()->productUsage(lastDays()))->firstWhere('feature', 'swap');

    expect($usage['actions'])->toBe(3)
        ->and($usage['volume_usd'])->toBe(50.0);
});

/* --------------------------------------------------------------- gas --- */

test('sponsored gas is priced from what the station released', function () {
    $now = Carbon::now('UTC');
    $price = 0.00002;

    // The wallet price service is cached; seed the cache rather than the net.
    cache()->put(
        'wallet.prices.v3',
        ['prices' => ['cyberia' => $price], 'tokens' => [], 'fetchedAt' => $now->toIso8601String()],
        600,
    );

    $user = installation(['activated_at' => $now]);
    AnalyticsAddress::query()->insert([
        'user_id' => $user->id,
        'chain' => 'cyberia',
        'address' => '0xaaf26832db3557daf540b0b09dee06c24b8a38bb',
        'created_at' => $now,
    ]);

    // Two drips to that address, and one to an address nobody reported: the
    // total covers all three, the per-user figure only knows about one person.
    foreach ([
        '0xaaf26832db3557daf540b0b09dee06c24b8a38bb',
        '0xaaf26832db3557daf540b0b09dee06c24b8a38bb',
        '0xbbf26832db3557daf540b0b09dee06c24b8a38bb',
    ] as $address) {
        DB::table('gas_sponsorships')->insert([
            'address' => $address,
            'amount_wei' => '10000000000000000', // 0.01 CYBER
            'grounds' => 'tokens',
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    $gas = metrics()->gasSponsorship(lastDays());

    expect($gas['transactions'])->toBe(3)
        ->and($gas['sponsored_users'])->toBe(1)
        ->and($gas['total_cyber'])->toBe(0.03)
        ->and($gas['total_usd'])->toBe(round(0.03 * $price, 4))
        ->and($gas['usd_per_sponsored_user'])->toBe(round(0.03 * $price, 4))
        ->and($gas['usd_per_activated_user'])->toBe(round(0.03 * $price, 4));
});

test('a resent gas event cannot add a cent to the spend', function () {
    $now = Carbon::now('UTC');
    $user = installation();

    // Six client-side claims of success against one actual drip. The cost side
    // never reads these rows.
    for ($i = 0; $i < 6; $i++) {
        logEvent($user, 'gas_sponsorship_completed', $now, ['chain' => 'cyberia']);
    }

    DB::table('gas_sponsorships')->insert([
        'address' => '0xaaf26832db3557daf540b0b09dee06c24b8a38bb',
        'amount_wei' => '10000000000000000',
        'created_at' => $now,
        'updated_at' => $now,
    ]);

    expect(metrics()->gasSponsorship(lastDays())['total_cyber'])->toBe(0.01);
});

/* ------------------------------------------------------------- filters -- */

test('a campaign filter measures that campaign own funnel', function () {
    $now = Carbon::now('UTC');

    $fromCampaign = installation([
        'source' => 'twitter',
        'campaign' => 'launch',
        'funded_at' => $now,
        'activated_at' => $now,
    ]);
    logEvent($fromCampaign, 'swap_completed', $now);

    $direct = installation(['funded_at' => $now, 'activated_at' => $now]);
    logEvent($direct, 'swap_completed', $now);

    $scoped = new AnalyticsFilters(
        from: $now->copy()->subDays(30),
        to: $now,
        campaign: 'launch',
    );

    expect(metrics()->overview($scoped)['new_users'])->toBe(1)
        ->and(metrics()->weeklyActiveFundedUsers($scoped))->toBe(1)
        ->and(metrics()->weeklyActiveFundedUsers(lastDays()))->toBe(2);
});

test('acquisition reports conversion rather than traffic', function () {
    $now = Carbon::now('UTC');

    // A source that sends many and converts none.
    for ($i = 0; $i < 5; $i++) {
        installation(['source' => 'airdrop-farm', 'campaign' => 'giveaway']);
    }

    // A source that sends one and converts it.
    $good = installation([
        'source' => 'podcast',
        'campaign' => 'ep12',
        'wallet_created_at' => $now,
        'funded_at' => $now,
        'activated_at' => $now,
    ]);
    logEvent($good, 'swap_completed', $now);

    $rows = collect(metrics()->acquisition(lastDays()))->keyBy('source');

    expect($rows['airdrop-farm']['users'])->toBe(5)
        ->and($rows['airdrop-farm']['activated'])->toBe(0)
        ->and($rows['airdrop-farm']['activation_rate'])->toBe(0.0)
        ->and($rows['podcast']['users'])->toBe(1)
        ->and($rows['podcast']['activation_rate'])->toBe(100.0);
});

test('the chain filter narrows activity without narrowing the population', function () {
    $now = Carbon::now('UTC');

    $user = installation(['funded_at' => $now]);
    logEvent($user, 'swap_completed', $now, ['chain' => 'cyberia', 'amount_usd' => 10.0]);
    logEvent($user, 'swap_completed', $now, ['chain' => 'base', 'amount_usd' => 90.0]);

    $cyberia = new AnalyticsFilters(
        from: $now->copy()->subDays(30),
        to: $now,
        chain: 'cyberia',
    );

    expect(metrics()->overview($cyberia)['swap_volume_usd'])->toBe(10.0)
        ->and(metrics()->overview(lastDays())['swap_volume_usd'])->toBe(100.0)
        // The person is still one person on either slice.
        ->and(metrics()->weeklyActiveFundedUsers($cyberia))->toBe(1);
});
