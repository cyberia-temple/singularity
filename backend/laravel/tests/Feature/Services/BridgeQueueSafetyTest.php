<?php

use App\Jobs\ProcessBridgeRequest;
use Illuminate\Contracts\Queue\ShouldBeUnique;

/**
 * The queue's own arithmetic.
 *
 * A job that can outlive its connection's `retry_after` is not a retry policy,
 * it is a second worker started on top of the first — and for a bridge payout
 * that means a second transfer. The relationship has to hold as an inequality,
 * not as an intention, because every one of these numbers is edited by somebody
 * who is thinking about something else.
 */
test('a relay job cannot outlive the queue that would re-release it', function () {
    $job = new ProcessBridgeRequest(1);

    $slowestScript = max(
        (int) config('bridge.relay.script_timeout_seconds'),
        (int) config('bridge.relay.solana_timeout_seconds'),
        (int) config('bridge.relay.ton_timeout_seconds'),
        (int) config('bridge.relay.yenten_timeout_seconds'),
        (int) config('bridge.relay.monero_timeout_seconds'),
    );

    // One request can run a payout AND a burn, so the job needs room for two
    // of the slowest scripts back to back.
    expect($job->timeout)->toBeGreaterThanOrEqual($slowestScript * 2);

    foreach (['database', 'redis', 'beanstalkd'] as $connection) {
        $retryAfter = (int) config("queue.connections.{$connection}.retry_after");

        expect($retryAfter)->toBeGreaterThan(
            $job->timeout,
            "queue.connections.{$connection}.retry_after must exceed the relay job timeout",
        );
    }
});

test('a relay job backs off instead of hammering a dead destination', function () {
    $job = new ProcessBridgeRequest(1);

    expect($job->tries)->toBeGreaterThan(1)
        ->and($job->backoff())->toBe([60, 300, 900]);

    // Growing, never flat: a destination RPC that is down is rarely back in
    // the same second, and a parked deposit is waiting on a person.
    $previous = 0;

    foreach ($job->backoff() as $delay) {
        expect($delay)->toBeGreaterThan($previous);
        $previous = $delay;
    }
});

test('only one copy of a relay job is allowed on the queue at a time', function () {
    $job = new ProcessBridgeRequest(68);

    expect($job)->toBeInstanceOf(ShouldBeUnique::class)
        ->and($job->uniqueId())->toBe('68')
        // The uniqueness lock must outlive the attempt it is protecting, or a
        // duplicate can be enqueued while the first is still signing.
        ->and($job->uniqueFor)->toBeGreaterThan($job->timeout);
});
