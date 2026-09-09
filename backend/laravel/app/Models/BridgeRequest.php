<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property int $id
 * @property int|null $user_id
 * @property string $direction
 * @property string $token
 * @property string $source_chain
 * @property string|null $source_tx_hash
 * @property int $source_nonce
 * @property string|null $sender_address
 * @property string $recipient_address
 * @property string|null $deposit_address
 * @property string|null $deposit_wif
 * @property int|null $deposit_index
 * @property bool $swept
 * @property bool $wrapper_burned
 * @property Carbon|null $source_verified_at
 * @property Carbon|null $payout_broadcast_at
 * @property Carbon|null $payout_confirmed_at
 * @property string $amount
 * @property string|null $fee_amount
 * @property string|null $fee_usd
 * @property bool $gas_drop_planned
 * @property string|null $gas_drop_amount
 * @property bool $convert_to_native
 * @property bool|null $converted
 * @property string $status
 * @property string|null $destination_tx_hash
 * @property string|null $error_message
 * @property Carbon|null $completed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class BridgeRequest extends Model
{
    /**
     * The durable states of one transfer, in the order a healthy one walks
     * them. Every name here is a different answer to "what does a retry do?".
     *
     *   awaiting_deposit  — a one-time address is watched; nothing owed yet.
     *   pending           — the source transfer is claimed, not yet verified.
     *   processing        — a worker holds this request right now.
     *   awaiting_liquidity— the deposit is REAL and the destination cannot pay
     *                       it yet. Nothing has been burned, nothing has been
     *                       sent. This is the state that had to exist: request
     *                       #68 had no way to say it, so it burned instead.
     *   paying_out        — a payout is on the wire; its hash is already
     *                       stored. A retry reconciles that hash, never pays.
     *   burn_pending      — the recipient has their money; the wrapper the
     *                       user deposited is still alive. A retry burns only.
     *   completed / failed / expired — terminal.
     */
    public const AWAITING_DEPOSIT = 'awaiting_deposit';

    public const PENDING = 'pending';

    public const PROCESSING = 'processing';

    public const AWAITING_LIQUIDITY = 'awaiting_liquidity';

    public const PAYING_OUT = 'paying_out';

    public const BURN_PENDING = 'burn_pending';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const EXPIRED = 'expired';

    /**
     * States a worker may pick a request up from. `failed` is included so the
     * operator retry path is the same code as the queue's — but picking it up
     * never means paying again: {@see hasPayout()} governs that.
     */
    public const PROCESSABLE = [
        self::PENDING,
        self::AWAITING_LIQUIDITY,
        self::PAYING_OUT,
        self::BURN_PENDING,
        self::FAILED,
    ];

    /**
     * States in which the bridge still owes the recipient a payout — what the
     * console and the user's "active" list must keep showing.
     */
    public const IN_FLIGHT = [
        self::AWAITING_DEPOSIT,
        self::PENDING,
        self::PROCESSING,
        self::AWAITING_LIQUIDITY,
        self::PAYING_OUT,
        self::BURN_PENDING,
    ];

    protected $fillable = [
        'user_id',
        'direction',
        'token',
        'source_chain',
        'source_tx_hash',
        'source_nonce',
        'sender_address',
        'recipient_address',
        'deposit_address',
        'deposit_wif',
        'deposit_index',
        'swept',
        'wrapper_burned',
        'source_verified_at',
        'payout_broadcast_at',
        'payout_confirmed_at',
        'amount',
        'fee_amount',
        'fee_usd',
        'gas_drop_planned',
        'gas_drop_amount',
        'convert_to_native',
        'converted',
        'status',
        'destination_tx_hash',
        'error_message',
        'completed_at',
    ];

    protected function casts(): array
    {
        return [
            'amount' => 'decimal:18',
            'fee_amount' => 'decimal:18',
            'fee_usd' => 'decimal:8',
            'gas_drop_planned' => 'boolean',
            'gas_drop_amount' => 'decimal:18',
            'convert_to_native' => 'boolean',
            'converted' => 'boolean',
            'deposit_wif' => 'encrypted',
            'deposit_index' => 'integer',
            'swept' => 'boolean',
            'wrapper_burned' => 'boolean',
            'source_nonce' => 'integer',
            'source_verified_at' => 'datetime',
            'payout_broadcast_at' => 'datetime',
            'payout_confirmed_at' => 'datetime',
            'completed_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function isPending(): bool
    {
        return $this->status === 'pending';
    }

    public function isAwaitingDeposit(): bool
    {
        return $this->status === 'awaiting_deposit';
    }

    public function markAwaitingDeposit(): void
    {
        $this->update(['status' => 'awaiting_deposit']);
    }

    public function isCompleted(): bool
    {
        return $this->status === 'completed';
    }

    public function isExpired(): bool
    {
        return $this->status === 'expired';
    }

    public function markExpired(): void
    {
        $this->update(['status' => 'expired']);
    }

    public function markProcessing(): void
    {
        $this->update(['status' => self::PROCESSING]);
    }

    /**
     * Take exclusive ownership of this request in one statement.
     *
     * `UPDATE … WHERE id = ? AND status IN (…)` is the whole point: two
     * workers — a queued job and a `bridge:relay` in a terminal — can both
     * read a pending row, and exactly one of them gets a row count of 1.
     * Nothing downstream has to wonder whether it is alone.
     */
    public function claimForProcessing(): bool
    {
        $claimed = static::query()
            ->whereKey($this->getKey())
            ->whereIn('status', self::PROCESSABLE)
            ->update(['status' => self::PROCESSING, 'updated_at' => now()]) === 1;

        if ($claimed) {
            $this->refresh();
        }

        return $claimed;
    }

    /**
     * The user's money really arrived. From here the bridge owes a payout and
     * the obligation survives every failure below.
     */
    public function markSourceVerified(): void
    {
        if ($this->source_verified_at === null) {
            $this->update(['source_verified_at' => now()]);
        }
    }

    /**
     * A verified deposit with nowhere to land yet. Recoverable by design: no
     * burn happened, no payout was attempted, and the row keeps its place in
     * the obligation ledger until the inventory is topped up.
     */
    public function markAwaitingLiquidity(string $reason): void
    {
        $this->update([
            'status' => self::AWAITING_LIQUIDITY,
            'error_message' => $reason,
        ]);
    }

    /**
     * Write the payout hash the instant it exists, before any receipt is
     * waited for. This single row is what makes the crash window between
     * "broadcast" and "recorded" survivable.
     */
    public function markPayoutBroadcast(string $destinationTxHash): void
    {
        $this->update([
            'status' => self::PAYING_OUT,
            'destination_tx_hash' => $destinationTxHash,
            'payout_broadcast_at' => $this->payout_broadcast_at ?? now(),
            'error_message' => null,
        ]);
    }

    public function markBurnPending(string $reason): void
    {
        $this->update([
            'status' => self::BURN_PENDING,
            'error_message' => $reason,
        ]);
    }

    /**
     * Has a payout already left this server for this request? If yes, nothing
     * — no retry, no `--force`, no duplicate job — may send another.
     */
    public function hasPayout(): bool
    {
        return $this->destination_tx_hash !== null && $this->destination_tx_hash !== '';
    }

    public function isAwaitingLiquidity(): bool
    {
        return $this->status === self::AWAITING_LIQUIDITY;
    }

    public function isBurnPending(): bool
    {
        return $this->status === self::BURN_PENDING;
    }

    public function markCompleted(string $destinationTxHash): void
    {
        $this->update([
            'status' => self::COMPLETED,
            'destination_tx_hash' => $destinationTxHash,
            'payout_confirmed_at' => $this->payout_confirmed_at ?? now(),
            'completed_at' => now(),
            'error_message' => null,
        ]);
    }

    public function markFailed(string $error): void
    {
        $this->update([
            'status' => self::FAILED,
            'error_message' => $error,
        ]);
    }
}
