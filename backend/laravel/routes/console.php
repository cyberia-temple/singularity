<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('slots:expire-prepares')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('slots:import-pumpfun')->hourly()->withoutOverlapping();
// The full import discovers new platform, bridge, CYBER.sol holder and whale
// wallets. It includes a getProgramAccounts scan, so keep it off the hot path.
Schedule::command('crm:sync')->daily()->withoutOverlapping();
// Cached balances are much cheaper to read one wallet at a time. Refresh the
// oldest batch so every known EVM/Solana wallet eventually cycles through,
// even when the CRM grows beyond one batch.
Schedule::command('crm:sync --balances-only --limit=100')->everyThirtyMinutes()->withoutOverlapping();
// ~87 chunked eth_getLogs calls per run (1000-block node cap) — keep the
// interval well above the runtime and never overlap.
Schedule::command('dex:apr')->everyFifteenMinutes()->withoutOverlapping();
// Credit XP for on-chain activity the browser can't be trusted to report.
// Idempotent, and scoped to recently-active accounts, so a short interval
// keeps levels/quests feeling live without rescanning the whole user base.
Schedule::command('gamification:sync')->everyTenMinutes()->withoutOverlapping();
// Harvest satellite-chain emission channels and top up their FundedFarms with
// backed bridged ASH (unified ASH emission, Path A). Buffers days ahead, so
// hourly keeps balances and reward rates in sync without racing.
Schedule::command('farm:fund-satellites')->hourly()->withoutOverlapping();
// Token sites are pinned when they are uploaded; this only catches the ones
// that missed it because the IPFS node was down at that moment, so it is a
// no-op on a healthy host.
Schedule::command('launchpad:pin-sites')->hourly()->withoutOverlapping();
// The prediction oracle. Frequent because a price market is settled from the
// first reading taken after it closes, and every minute of lag is a minute the
// answer can drift from the question; cheap because a run with nothing to
// settle is one eth_call and a cached quote, and signs nothing.
Schedule::command('predictions:resolve')->everyFiveMinutes()->withoutOverlapping();
// Deposits that land on an address instead of arriving as a signed
// transaction: nothing notifies this server, so it looks. Every two minutes
// because that is a Monero block — polling faster asks the same question
// about the same unconfirmed deposit twice.
Schedule::command('bridge:sweep-deposits')->everyTwoMinutes()->withoutOverlapping();
// Capacity holds taken before a wallet prompt that never came back. They stop
// counting against liquidity the moment they expire — this only closes the
// row, and it never touches a hold that has a transfer behind it.
Schedule::command('bridge:release-reservations')->everyFiveMinutes()->withoutOverlapping();
// The wallet chat relay is a queue, not an archive: drop delivered and
// undelivered envelopes alike once they are past the retention window, so the
// server stops holding a record of who talked to whom.
Schedule::command('wallet:chat-prune')->daily()->withoutOverlapping();
// The operators' room is a working record, not an archive: what was worth
// keeping left it as a task. Files go with the message that brought them,
// because a file whose reason has been deleted is an orphan on a disk.
Schedule::command('crm:chat-prune')->daily()->withoutOverlapping();
// The inference API's metering log is a quota and an invoice, not an archive
// of who asked what — drop rows once they are past the retention window.
Schedule::command('ai:prune-usage')->daily()->withoutOverlapping();
// Sponsored fees fail silently: when the tank or the operator key runs dry the
// button simply stops working, and nobody reports a wallet that never offered
// them anything. Reads only, and it shouts at most once every six hours.
Schedule::command('gas:station --alert')->hourly()->withoutOverlapping();
// Funding that the browser never got to report: a wallet funded while closed,
// a deposit that confirmed after the tab was gone. The activation funnel wants
// those users most, because a wallet that was funded and never came back is
// the drop-off worth fixing. Bounded per run and reads only.
Schedule::command('analytics:verify-funding')->everyThirtyMinutes()->withoutOverlapping();
// Is everything running. Reads only — it probes, records and reports, and can
// restart nothing, which is what makes it safe to run unattended. Alerts fire
// on state changes only, so a service that has been down for a week is
// mentioned once a day rather than every five minutes.
Schedule::command('services:check --alert')->everyFiveMinutes()->withoutOverlapping();
// Thirty services swept every five minutes is ten thousand rows a day: a
// rolling uptime window, never an archive.
Schedule::command('services:prune')->dailyAt('04:10')->withoutOverlapping();
// The product report, delivered rather than published. /crm/numbers has
// answered these questions for weeks and nobody opens it — a dashboard is a
// place you must decide to go to. Sent at the same hour the console wakes its
// snoozed rows, in the timezone the operators live in, so the day starts with
// the numbers instead of with a decision to go and look at them.
Schedule::command('analytics:digest --send')
    ->dailyAt(sprintf('%02d:00', (int) config('crm.console.morning_hour', 9)))
    ->timezone((string) config('crm.console.timezone', 'Europe/Moscow'))
    ->withoutOverlapping();
// Badges nobody is watching for. Detection used to run in exactly two places —
// claiming a nickname, and a button on /profile nobody knew about — so the last
// award on prod was 2026-07-30 while a badge earned on 2026-08-22 sat unminted.
// Bounded per run and rotating, because a badge is not urgent; --alert says so
// when the mint itself is what failed, which was previously silent.
Schedule::command('achievements:sync --alert')->hourly()->withoutOverlapping();
// The one notification that brings anybody back. Everything else the
// gamification system sends is a receipt for something already done, which is
// why nobody remembers the quests exist. Once a day, in the evening, in the
// timezone the people here live in — that is also the entire quiet-hours
// policy, since a setting nobody opens protects nobody.
Schedule::command('gamification:remind')
    ->dailyAt('19:00')
    ->timezone((string) config('crm.console.timezone', 'Europe/Moscow'))
    ->withoutOverlapping();
// Peers that stopped announcing, and the swarm counts on releases nobody is
// announcing to any more. An empty swarm is never announced to again, so
// without this a release keeps showing the seeders it had the day the last one
// closed their client.
Schedule::command('tracker:prune')->hourly()->withoutOverlapping();
// Who owns each release. The token is transferable and a sold release moves
// with it; everything else on the row is fixed by the CID it was minted from.
Schedule::command('tracker:sync')->dailyAt('05:20')->withoutOverlapping();
