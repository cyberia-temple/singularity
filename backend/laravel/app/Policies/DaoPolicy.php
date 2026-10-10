<?php

namespace App\Policies;

use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\User;

class DaoPolicy
{
    /** Only the creator may edit; DAOs with no recorded owner are locked. */
    public function update(User $user, Dao $dao): bool
    {
        return $dao->user_id !== null && $dao->user_id === $user->id;
    }

    /**
     * A launched token's DAO cannot be deleted, not even by the creator: it
     * opened with the launch and belongs to the holders (`TokenDaoOpener`).
     */
    public function delete(User $user, Dao $dao): bool
    {
        return $this->update($user, $dao)
            && ! LaunchpadToken::query()->where('dao_id', $dao->id)->exists();
    }
}
