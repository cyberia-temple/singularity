<?php

namespace App\Services\Dao;

use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * Every launched token has a DAO, and nobody has to ask for it.
 *
 * A DAO here is a name and a token whose balances weigh the votes
 * (`TokenSnapshotService`), so a launch already holds everything one needs —
 * the token exists and its holders are the electorate. This opens it the
 * moment `launchpad:watch` sees the launch.
 *
 * Idempotent by address: a token that already has a DAO (the launch was seen
 * before, or somebody registered one by hand before this existed) is linked
 * to it rather than given a second one, because two DAOs over one token would
 * split the same holders into two rooms.
 *
 * The owner is the creator's account where the creator has one — it may rename
 * it — and nobody otherwise. Nobody may delete it (`DaoPolicy`): it belongs to
 * whoever holds the token, not to whoever paid for the launch.
 */
class TokenDaoOpener
{
    public function open(LaunchpadToken $token): Dao
    {
        $address = Str::lower($token->address);

        $dao = ($token->dao_id ? Dao::find($token->dao_id) : null)
            ?? Dao::query()->whereRaw('lower(address) = ?', [$address])->oldest('id')->first();

        if ($dao === null) {
            $dao = Dao::create([
                'address' => $address,
                'name' => $this->nameFor($token),
                'user_id' => $this->creatorAccount($token)?->id,
            ]);

            // The wallet's DAO list is cached for its refresh cadence; a DAO
            // that opened with a launch should be there when its creator looks.
            Cache::forget('wallet.dao.index');
        }

        if ((int) $token->dao_id !== $dao->id) {
            $token->forceFill(['dao_id' => $dao->id])->save();
        }

        return $dao;
    }

    /**
     * The token's own name, made unique: names are what the DAO index and the
     * proposal form tell DAOs apart by, and two launches may share one.
     */
    private function nameFor(LaunchpadToken $token): string
    {
        $address = Str::lower($token->address);
        $name = trim((string) $token->name) ?: trim((string) $token->symbol) ?: Str::substr($address, 0, 10);
        $symbol = trim((string) $token->symbol);
        $short = Str::substr($address, 0, 6).'…'.Str::substr($address, -4);

        $candidates = array_unique(array_filter([
            Str::limit($name, 80, ''),
            $symbol !== '' && $symbol !== $name ? Str::limit($name, 80, '')." ({$symbol})" : null,
            Str::limit($name, 80, '')." · {$short}",
        ]));

        foreach ($candidates as $candidate) {
            if (! Dao::query()->where('name', $candidate)->exists()) {
                return $candidate;
            }
        }

        return Str::limit($name, 60, '')." · {$address}";
    }

    private function creatorAccount(LaunchpadToken $token): ?User
    {
        if (! $token->creator) {
            return null;
        }

        return User::query()
            ->whereRaw('lower(wallet_address) = ?', [Str::lower($token->creator)])
            ->oldest('id')
            ->first();
    }
}
