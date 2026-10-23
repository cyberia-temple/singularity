<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use App\Concerns\HasTeams;
use App\Support\ProfileHandle;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Appends;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Laravel\Fortify\TwoFactorAuthenticatable;
use Laravel\Sanctum\HasApiTokens;
use NotificationChannels\WebPush\HasPushSubscriptions;

#[Fillable(['name', 'email', 'password', 'current_team_id', 'wallet_address', 'solana_wallet_address', 'monero_wallet_address', 'twitter_id', 'twitter_username'])]
#[Hidden(['avatar_path', 'password', 'two_factor_secret', 'two_factor_recovery_codes', 'remember_token'])]
#[Appends(['avatar', 'profile_url'])]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, HasPushSubscriptions, HasTeams, Notifiable, TwoFactorAuthenticatable;

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'two_factor_confirmed_at' => 'datetime',
            'referred_at' => 'datetime',
        ];
    }

    /**
     * Who invited this account, if anybody. Set once and never moved — see
     * ReferralService::attach() for what may set it.
     */
    public function referrer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'referred_by');
    }

    /** The accounts this one invited. */
    public function referrals(): HasMany
    {
        return $this->hasMany(User::class, 'referred_by');
    }

    /**
     * The chain is the canonical public identity. The editable account name
     * remains available as a fallback for users without an on-chain nickname.
     */
    protected function name(): Attribute
    {
        return Attribute::make(
            get: fn (string $value, array $attributes): string => $attributes['onchain_nickname'] ?? $value,
        );
    }

    protected function avatar(): Attribute
    {
        return Attribute::make(
            get: fn (): ?string => $this->avatar_path
                ? Storage::disk('public')->url($this->avatar_path)
                : null,
        );
    }

    protected function profileUrl(): Attribute
    {
        return Attribute::make(
            get: fn (): string => ProfileHandle::url(
                $this->getKey(),
                $this->getRawOriginal('onchain_nickname'),
            ),
        );
    }

    public function activities(): HasMany
    {
        return $this->hasMany(Activity::class);
    }

    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }

    /**
     * Users who follow this user.
     *
     * @return BelongsToMany<User, $this>
     */
    public function followers(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'user_follows', 'followed_id', 'follower_id')
            ->withTimestamps();
    }

    /**
     * Users this user follows.
     *
     * @return BelongsToMany<User, $this>
     */
    public function following(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'user_follows', 'follower_id', 'followed_id')
            ->withTimestamps();
    }

    public function proposals(): HasMany
    {
        return $this->hasMany(Proposal::class);
    }

    public function proposalVotes(): HasMany
    {
        return $this->hasMany(ProposalVote::class);
    }

    public function proposalComments(): HasMany
    {
        return $this->hasMany(ProposalComment::class);
    }

    public function lainChatMessages(): HasMany
    {
        return $this->hasMany(LainChatMessage::class);
    }

    public function lainChatSessions(): HasMany
    {
        return $this->hasMany(LainChatSession::class);
    }

    public function solanaStakingPosition(): HasOne
    {
        return $this->hasOne(SolanaStakingPosition::class);
    }

    /**
     * Progression row (xp, level, streak). Absent until the first tracked
     * action — use GamificationService::statsFor() when a row is required.
     */
    public function stat(): HasOne
    {
        return $this->hasOne(UserStat::class);
    }

    /** The wallet this profile keeps, sealed in the browser (sync). */
    public function walletSyncBackup(): HasOne
    {
        return $this->hasOne(WalletSyncBackup::class);
    }

    public function xpEntries(): HasMany
    {
        return $this->hasMany(XpEntry::class);
    }

    public function quests(): HasMany
    {
        return $this->hasMany(UserQuest::class);
    }

    /**
     * The surviving account this user was merged into, if any. A non-null
     * value means this account is absorbed: it can no longer authenticate
     * and its identity columns have been cleared.
     */
    public function mergedInto(): BelongsTo
    {
        return $this->belongsTo(User::class, 'merged_into_id');
    }

    /**
     * Accounts previously merged into this one.
     */
    public function mergedAccounts(): HasMany
    {
        return $this->hasMany(User::class, 'merged_into_id');
    }

    /**
     * CRM tasks assigned to this user.
     *
     * @return HasMany<CrmTask, $this>
     */
    public function crmTasks(): HasMany
    {
        return $this->hasMany(CrmTask::class, 'assigned_to_user_id');
    }

    /**
     * The operators on the CRM allow list (config/crm.php). They are the only
     * accounts that can open the CRM, and therefore the only ones a CRM task
     * can be assigned to. Both halves of EnsureCrmAdmin are asked here, in the
     * same order and lowercased the same way, or a task could be assigned to
     * somebody who cannot open the page it is on.
     *
     * @param  Builder<User>  $query
     */
    public function scopeCrmOperators(Builder $query): void
    {
        $ids = config('crm.admin_user_ids', []);

        $query->where(function (Builder $query) use ($ids) {
            $query->whereIn(
                DB::raw('lower(wallet_address)'),
                config('crm.admin_wallets', []),
            );

            if ($ids !== []) {
                $query->orWhereIn('id', $ids);
            }
        })->orderBy('id');
    }
}
