<?php

namespace App\Services\Social;

use App\Models\AnalyticsUser;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Notifications\Notification;
use Illuminate\Support\Facades\DB;

/**
 * One notification, delivered to everyone who agreed to be delivered to.
 *
 * Every action somebody takes here — a post, a proposal, a vote, a comment, a
 * reaction, a new DAO, a trade — is announced to the whole community, because
 * a community where nothing tells you something happened is one nobody comes
 * back to. Two audiences and not one, because this project has two kinds of
 * person: the site's accounts, and the wallet installations that never signed
 * up for anything (`AnalyticsUser` — the wallet is non-custodial, so a
 * subscription hangs off the installation's own uuid rather than off a login).
 * Most people here are the second kind, which is exactly why pushing only
 * accounts would mean pushing almost nobody.
 *
 * Only devices that *have* a subscription are walked, plus any accounts the
 * caller names (the people an action is *about* — a proposal's author, the
 * comment being replied to — get the bell row even without push). Everything
 * else is a row that cannot be reached.
 *
 * The actor is excluded where they can be identified (an account). Delivery is
 * per recipient and one failure never stops the rest — a push service drops
 * endpoints without telling anybody, and the next person has nothing to do
 * with it. Synchronous: callers defer it past the response, since production
 * runs no queue worker.
 */
class Broadcaster
{
    /** Rows held in memory at once while the list is walked. */
    private const CHUNK = 200;

    /**
     * How many devices one action may wake.
     *
     * Not a policy about attention — a stop on a synchronous loop that runs
     * after a web request on a host with no queue worker. If the audience ever
     * outgrows it, the fan-out belongs on a queue, and this constant is where
     * that becomes visible instead of as a process that runs for minutes.
     */
    private const CEILING = 2000;

    /**
     * @param  iterable<int|null>  $alsoUserIds  Accounts to reach even without a push subscription.
     */
    public function broadcast(Notification $notification, ?int $actorId = null, iterable $alsoUserIds = []): int
    {
        $sent = 0;

        $deliver = function (object $recipient) use ($notification, &$sent): void {
            if ($sent >= self::CEILING) {
                return;
            }

            try {
                $recipient->notify($notification);
                $sent++;
            } catch (\Throwable $e) {
                report($e);
            }
        };

        $named = collect($alsoUserIds)->filter()->map(fn ($id) => (int) $id)->unique()->values()->all();

        $this->accounts($actorId, $named)
            ->chunkById(self::CHUNK, fn ($users) => $users->each($deliver));

        $this->installations()
            ->chunkById(self::CHUNK, fn ($installs) => $installs->each($deliver));

        return $sent;
    }

    /**
     * Site accounts with at least one live subscription, plus the named ones,
     * minus the actor.
     *
     * @param  list<int>  $named
     */
    private function accounts(?int $actorId, array $named): Builder
    {
        return User::query()
            ->whereNull('merged_into_id')
            ->when($actorId !== null, fn ($query) => $query->whereKeyNot($actorId))
            ->where(fn ($query) => $query
                ->whereExists(fn ($exists) => $exists->select(DB::raw(1))
                    ->from('push_subscriptions')
                    ->whereColumn('push_subscriptions.subscribable_id', 'users.id')
                    ->where('push_subscriptions.subscribable_type', User::class))
                ->when($named !== [], fn ($or) => $or->orWhereIn('users.id', $named)));
    }

    /**
     * Wallet installations with a subscription.
     *
     * An installation is not matched against the actor: the uuid is minted in
     * a browser and this server never learns whose wallet it is, so the actor
     * hearing about their own action on their own phone is the honest price of
     * not being able to identify them.
     */
    private function installations(): Builder
    {
        return AnalyticsUser::query()
            ->whereExists(fn ($query) => $query->select(DB::raw(1))
                ->from('push_subscriptions')
                ->whereColumn('push_subscriptions.subscribable_id', 'analytics_users.id')
                ->where('push_subscriptions.subscribable_type', AnalyticsUser::class));
    }
}
