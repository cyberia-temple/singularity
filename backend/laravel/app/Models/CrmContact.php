<?php

namespace App\Models;

use App\Support\Handles;
use Database\Factories\CrmContactFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * @property int $id
 * @property string|null $name
 * @property string|null $email
 * @property string|null $telegram
 * @property string|null $x_handle
 * @property string|null $evm_address
 * @property string|null $solana_address
 * @property string $type
 * @property string $status
 * @property string $source
 * @property int|null $user_id
 * @property string|null $cyber_balance
 * @property string|null $cyber_sol_balance
 * @property string|null $bought_usd
 * @property string|null $sold_usd
 * @property array<int, string>|null $tags
 * @property array<string, mixed>|null $metadata
 * @property Carbon|null $last_synced_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class CrmContact extends Model
{
    /** @use HasFactory<CrmContactFactory> */
    use HasFactory, SoftDeletes;

    public const TYPES = ['lead', 'partner', 'holder', 'whale'];

    /**
     * The pipeline, plus the two ways out of it.
     *
     * `sold` is written by the sync rather than chosen: somebody who emptied
     * their wallet is not a record to delete — they are a person we know, and
     * that they sold is the most interesting thing on their file. `lost` stays
     * an operator's judgement, and the sync never overwrites it.
     */
    public const STATUSES = ['new', 'contacted', 'qualified', 'customer', 'sold', 'lost'];

    /**
     * Where the record came from. `holder` is written by the on-chain scan and
     * was missing from this list, so a row discovered on Solana rendered its
     * own translation key on screen.
     */
    public const SOURCES = ['manual', 'platform', 'bridge', 'holder', 'whale_bot'];

    public const CHAINS = ['evm', 'solana', 'both', 'none'];

    protected $fillable = [
        'name',
        'email',
        'telegram',
        'x_handle',
        'evm_address',
        'solana_address',
        'type',
        'status',
        'source',
        'user_id',
        'cyber_balance',
        'cyber_sol_balance',
        'bought_usd',
        'sold_usd',
        'tags',
        'metadata',
        'last_synced_at',
    ];

    protected function casts(): array
    {
        return [
            'tags' => 'array',
            'metadata' => 'array',
            'cyber_balance' => 'decimal:18',
            'cyber_sol_balance' => 'decimal:6',
            'bought_usd' => 'decimal:2',
            'sold_usd' => 'decimal:2',
            'last_synced_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return HasMany<CrmNote, $this>
     */
    public function notes(): HasMany
    {
        return $this->hasMany(CrmNote::class)->latest();
    }

    /**
     * @return HasMany<CrmTask, $this>
     */
    public function tasks(): HasMany
    {
        return $this->hasMany(CrmTask::class)->byDueDate();
    }

    /** @return HasMany<CrmContactLink, $this> */
    public function contactLinks(): HasMany
    {
        return $this->hasMany(CrmContactLink::class)->oldest('id');
    }

    /**
     * The correspondence, oldest first.
     *
     * Notes are latest-first because a note is read as "what is the newest
     * thing somebody wrote about them"; a conversation is read in the order
     * it happened, which is the opposite.
     *
     * @return HasMany<CrmMessage, $this>
     */
    public function messages(): HasMany
    {
        return $this->hasMany(CrmMessage::class)->inOrder();
    }

    /** @return HasOne<CrmMessage, $this> */
    public function latestMessage(): HasOne
    {
        return $this->hasOne(CrmMessage::class)->ofMany(['sent_at' => 'max', 'id' => 'max']);
    }

    public function isWhale(): bool
    {
        return $this->type === 'whale';
    }

    /**
     * What to call this person on screen.
     *
     * A record can arrive carrying nothing but an address, so the fallback
     * chain is the order in which a name is worth reading: what they are
     * called, then a handle somebody could write to, then an address, then
     * the row number — which at least identifies the record itself.
     */
    public function displayName(): string
    {
        if ($this->name) {
            return $this->name;
        }

        if ($this->telegram) {
            return $this->telegram;
        }

        if ($this->x_handle) {
            return '@'.$this->x_handle;
        }

        if ($this->relationLoaded('contactLinks') && $this->contactLinks->isNotEmpty()) {
            return $this->contactLinks->first()->label;
        }

        return $this->evm_address ?: '#'.$this->getKey();
    }

    /** The handle under the name: a conversation first, then a profile. */
    public function displayHandle(): ?string
    {
        return $this->telegram ?: ($this->x_handle ? '@'.$this->x_handle : null);
    }

    /**
     * Filter by a free-text query across name, email, handles and addresses.
     *
     * Searched in both the spelling that was typed and the spelling this
     * column stores. Handles go in bare (`Handles`), and what an operator
     * looking for somebody types is what they are looking at — `@name`, or
     * the profile URL out of the clipboard — so a box that only matched the
     * stored form answered "not found" for a person who is on the books, and
     * that answer is how somebody gets entered a second time.
     *
     * Tags are searched too: a tag is the operator's own filing, and the
     * word they will look for later is the word they filed it under.
     *
     * @param  Builder<CrmContact>  $query
     */
    public function scopeSearch(Builder $query, ?string $term): void
    {
        $term = trim((string) $term);

        if ($term === '') {
            return;
        }

        $spellings = array_values(array_unique(array_filter([
            $term,
            Handles::searchable($term),
        ])));

        $query->where(function (Builder $outer) use ($spellings) {
            foreach ($spellings as $spelling) {
                $like = '%'.$spelling.'%';

                $outer->orWhere(function (Builder $q) use ($like) {
                    $q->where('name', 'like', $like)
                        ->orWhere('email', 'like', $like)
                        ->orWhere('telegram', 'like', $like)
                        ->orWhere('x_handle', 'like', $like)
                        ->orWhere('evm_address', 'like', $like)
                        ->orWhere('solana_address', 'like', $like)
                        ->orWhere('tags', 'like', $like)
                        ->orWhereHas('contactLinks', fn (Builder $links) => $links
                            ->where('label', 'like', $like)
                            ->orWhere('url', 'like', $like));
                });
            }
        });
    }

    /**
     * Filter by wallet chain: evm/solana count any contact holding that
     * address (so a contact with both wallets matches either filter).
     *
     * @param  Builder<CrmContact>  $query
     */
    public function scopeChain(Builder $query, ?string $chain): void
    {
        match ($chain) {
            'evm' => $query->whereNotNull('evm_address'),
            'solana' => $query->whereNotNull('solana_address'),
            'both' => $query->whereNotNull('evm_address')->whereNotNull('solana_address'),
            'none' => $query->whereNull('evm_address')->whereNull('solana_address'),
            default => null,
        };
    }
}
