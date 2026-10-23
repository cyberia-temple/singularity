<?php

namespace App\Services;

use App\Models\BridgeRequest;
use App\Services\Bitcoin\EsploraApiService;
use App\Services\Bitcoin\UtxoPool;
use App\Services\Monero\MoneroWalletRpc;
use App\Support\BridgeAmount;
use App\Support\BridgeCapacity;
use App\Support\Environment;
use App\Support\TokenAmount;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Process\Exceptions\ProcessTimedOutException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;

class BridgeService
{
    /**
     * Bridge fee percentage (1% = 0.01) — legacy fallback for old rows only.
     */
    private const FEE_RATE = '0.01';

    /**
     * Calculate the amount after deducting the bridge fee.
     */
    public static function deductFee(string $amount): string
    {
        $fee = bcmul($amount, self::FEE_RATE, 18);
        $afterFee = bcsub($amount, $fee, 18);

        return $afterFee;
    }

    /**
     * Calculate the fee for a given amount.
     */
    public static function calculateFee(string $amount): string
    {
        return bcmul($amount, self::FEE_RATE, 18);
    }

    private function solanaRpc(): string
    {
        return (string) config('bridge.chains.solana.rpc_url');
    }

    private function solanaHotWallet(): string
    {
        return (string) config('bridge.chains.solana.deposit_address');
    }

    public function createRequest(
        ?int $userId,
        string $direction,
        string $sourceChain,
        ?string $sourceTxHash,
        int $sourceNonce,
        ?string $senderAddress,
        string $recipientAddress,
        string $amount,
        string $token = 'CYBER.sol',
        ?string $feeAmount = null,
        ?string $feeUsd = null,
        bool $gasDropPlanned = false,
        ?string $gasDropAmount = null,
        bool $convertToNative = false,
        ?string $depositAddress = null,
        ?string $depositWif = null,
        string $status = 'pending',
    ): BridgeRequest {
        $rate = BridgeAmount::rate($direction, $token);

        return BridgeRequest::create([
            'user_id' => $userId,
            'direction' => $direction,
            'token' => $token,
            'source_chain' => $sourceChain,
            'source_tx_hash' => $sourceTxHash,
            'source_nonce' => $sourceNonce,
            'sender_address' => $senderAddress,
            'recipient_address' => $recipientAddress,
            'deposit_address' => $depositAddress,
            'deposit_wif' => $depositWif,
            'amount' => $amount,
            'fee_amount' => $feeAmount,
            'conversion_numerator' => $rate['numerator'],
            'conversion_denominator' => $rate['denominator'],
            'fee_usd' => $feeUsd,
            'gas_drop_planned' => $gasDropPlanned,
            'gas_drop_amount' => $gasDropAmount,
            'convert_to_native' => $convertToNative,
            'status' => $status,
        ]);
    }

    /**
     * Verify that a Solana transaction is a real SPL transfer to our hot wallet.
     * Returns the transfer amount in raw units, or null if invalid.
     */
    public function verifySolanaDeposit(string $txHash, string $expectedSender): ?string
    {
        try {
            $response = Http::timeout(30)->post($this->solanaRpc(), [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getTransaction',
                'params' => [
                    $txHash,
                    ['encoding' => 'jsonParsed', 'commitment' => 'confirmed', 'maxSupportedTransactionVersion' => 0],
                ],
            ]);

            if (! $response->successful()) {
                Log::error('Bridge: Solana RPC HTTP error', ['tx' => $txHash, 'status' => $response->status(), 'body' => $response->body()]);

                return null;
            }

            $result = $response->json('result');

            if (! $result || ($result['meta']['err'] ?? null) !== null) {
                Log::warning('Bridge: Solana tx not found or failed', [
                    'tx' => $txHash,
                    'result_null' => $result === null,
                    'rpc_error' => $response->json('error'),
                    'meta_err' => $result['meta']['err'] ?? null,
                ]);

                return null;
            }

            // Look through inner instructions and top-level instructions for SPL transfers
            $instructions = $result['transaction']['message']['instructions'] ?? [];
            $innerInstructions = $result['meta']['innerInstructions'] ?? [];

            foreach ($innerInstructions as $inner) {
                foreach ($inner['instructions'] ?? [] as $ix) {
                    $instructions[] = $ix;
                }
            }

            Log::info('Bridge: verifySolanaDeposit scanning instructions', [
                'tx' => $txHash,
                'expectedSender' => $expectedSender,
                'instruction_count' => count($instructions),
            ]);

            foreach ($instructions as $ix) {
                $parsed = $ix['parsed'] ?? null;
                $program = $ix['program'] ?? '';
                $type = $parsed['type'] ?? '';

                if ($program !== 'spl-token') {
                    continue;
                }

                $info = $parsed['info'] ?? [];

                Log::info('Bridge: verifySolanaDeposit found spl-token ix', [
                    'type' => $type,
                    'authority' => $info['authority'] ?? 'n/a',
                    'amount' => $info['amount'] ?? ($info['tokenAmount']['amount'] ?? 'n/a'),
                ]);

                // Support both 'transfer' and 'transferChecked'
                if ($type !== 'transfer' && $type !== 'transferChecked') {
                    continue;
                }

                if (($info['authority'] ?? '') !== $expectedSender) {
                    continue;
                }

                // 'transfer' has 'amount', 'transferChecked' has 'tokenAmount.amount'
                $amount = $info['amount'] ?? ($info['tokenAmount']['amount'] ?? null);

                return $amount;
            }

            Log::warning('Bridge: verifySolanaDeposit no matching transfer found', ['tx' => $txHash]);

            return null;
        } catch (\Exception $e) {
            Log::error('Bridge: verifySolanaDeposit failed', ['tx' => $txHash, 'error' => $e->getMessage()]);

            return null;
        }
    }

    /**
     * Verify an SPL deposit by computing the balance delta on the hot wallet
     * for a specific mint. More robust than instruction scanning because it
     * also confirms the mint matches what we expected (prevents replay of a
     * transfer of a different token claiming to be USDC etc.).
     *
     * @return string|null raw amount delta on the hot wallet, or null if not a valid deposit
     */
    public function verifySolanaTokenDeposit(
        string $txHash,
        string $expectedSender,
        string $expectedMint,
        ?string $expectedRecipient = null,
    ): ?string {
        $expectedRecipient ??= $this->solanaHotWallet();

        try {
            $response = Http::timeout(30)->post($this->solanaRpc(), [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getTransaction',
                'params' => [
                    $txHash,
                    ['encoding' => 'jsonParsed', 'commitment' => 'confirmed', 'maxSupportedTransactionVersion' => 0],
                ],
            ]);

            if (! $response->successful()) {
                Log::error('Bridge: Solana RPC HTTP error', ['tx' => $txHash, 'status' => $response->status()]);

                return null;
            }

            $result = $response->json('result');

            if (! $result || ($result['meta']['err'] ?? null) !== null) {
                Log::warning('Bridge: Solana tx not found or failed', ['tx' => $txHash]);

                return null;
            }

            $pre = $this->indexTokenBalances($result['meta']['preTokenBalances'] ?? []);
            $post = $this->indexTokenBalances($result['meta']['postTokenBalances'] ?? []);

            $key = $expectedRecipient.':'.$expectedMint;
            $preRaw = $pre[$key] ?? '0';
            $postRaw = $post[$key] ?? '0';

            if (bccomp($postRaw, $preRaw, 0) <= 0) {
                Log::warning('Bridge: hot wallet balance did not increase', [
                    'tx' => $txHash,
                    'mint' => $expectedMint,
                    'pre' => $preRaw,
                    'post' => $postRaw,
                ]);

                return null;
            }

            // Verify the sender actually lost the same amount (sanity check).
            $senderKey = $expectedSender.':'.$expectedMint;
            $senderPre = $pre[$senderKey] ?? null;
            $senderPost = $post[$senderKey] ?? '0';

            if ($senderPre !== null && bccomp($senderPre, $senderPost, 0) <= 0) {
                Log::warning('Bridge: sender balance did not decrease', [
                    'tx' => $txHash,
                    'sender' => $expectedSender,
                    'pre' => $senderPre,
                    'post' => $senderPost,
                ]);

                return null;
            }

            return bcsub($postRaw, $preRaw, 0);
        } catch (\Exception $e) {
            Log::error('Bridge: verifySolanaTokenDeposit failed', [
                'tx' => $txHash,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Verify a native SOL deposit by computing the lamport balance delta on
     * the hot wallet (system-transfer deposits carry no token balances). The
     * sender must have lost lamports in the same transaction so a transfer
     * between third parties can't be replayed as a deposit.
     *
     * @return string|null raw lamport delta on the hot wallet, or null if not a valid deposit
     */
    public function verifySolanaNativeDeposit(
        string $txHash,
        string $expectedSender,
        ?string $expectedRecipient = null,
    ): ?string {
        $expectedRecipient ??= $this->solanaHotWallet();

        try {
            $response = Http::timeout(30)->post($this->solanaRpc(), [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getTransaction',
                'params' => [
                    $txHash,
                    ['encoding' => 'jsonParsed', 'commitment' => 'confirmed', 'maxSupportedTransactionVersion' => 0],
                ],
            ]);

            if (! $response->successful()) {
                Log::error('Bridge: Solana RPC HTTP error', ['tx' => $txHash, 'status' => $response->status()]);

                return null;
            }

            $result = $response->json('result');

            if (! $result || ($result['meta']['err'] ?? null) !== null) {
                Log::warning('Bridge: Solana tx not found or failed', ['tx' => $txHash]);

                return null;
            }

            $lamports = $this->indexLamportBalances($result);
            [$recipientPre, $recipientPost] = $lamports[$expectedRecipient] ?? ['0', '0'];

            if (bccomp($recipientPost, $recipientPre, 0) <= 0) {
                Log::warning('Bridge: hot wallet lamports did not increase', [
                    'tx' => $txHash,
                    'pre' => $recipientPre,
                    'post' => $recipientPost,
                ]);

                return null;
            }

            [$senderPre, $senderPost] = $lamports[$expectedSender] ?? [null, null];

            if ($senderPre === null || bccomp($senderPre, (string) $senderPost, 0) <= 0) {
                Log::warning('Bridge: sender lamports did not decrease', [
                    'tx' => $txHash,
                    'sender' => $expectedSender,
                ]);

                return null;
            }

            return bcsub($recipientPost, $recipientPre, 0);
        } catch (\Exception $e) {
            Log::error('Bridge: verifySolanaNativeDeposit failed', [
                'tx' => $txHash,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Index meta.preBalances/postBalances by account pubkey → [pre, post]
     * lamport strings, using the parallel transaction.message.accountKeys.
     *
     * @param  array<string, mixed>  $result  getTransaction result (jsonParsed)
     * @return array<string, array{0: string, 1: string}>
     */
    private function indexLamportBalances(array $result): array
    {
        $accountKeys = $result['transaction']['message']['accountKeys'] ?? [];
        $pre = $result['meta']['preBalances'] ?? [];
        $post = $result['meta']['postBalances'] ?? [];

        $indexed = [];

        foreach (array_values($accountKeys) as $i => $entry) {
            $pubkey = is_array($entry) ? ($entry['pubkey'] ?? null) : $entry;

            if (is_string($pubkey) && isset($pre[$i], $post[$i])) {
                $indexed[$pubkey] = [(string) $pre[$i], (string) $post[$i]];
            }
        }

        return $indexed;
    }

    /**
     * Index pre/postTokenBalances entries by "owner:mint" → raw amount string.
     *
     * @param  array<int, array<string, mixed>>  $entries
     * @return array<string, string>
     */
    private function indexTokenBalances(array $entries): array
    {
        $indexed = [];

        foreach ($entries as $entry) {
            $owner = $entry['owner'] ?? null;
            $mint = $entry['mint'] ?? null;
            $amount = $entry['uiTokenAmount']['amount'] ?? null;

            if (is_string($owner) && is_string($mint) && is_string($amount)) {
                $indexed[$owner.':'.$mint] = $amount;
            }
        }

        return $indexed;
    }

    /**
     * Verify an ERC20 deposit on an EVM chain. Returns the raw transfer amount
     * (in the token's decimals) or null if the tx does not contain a matching
     * Transfer(sender → expectedRecipient) event for the given token.
     */
    public function verifyEvmDeposit(
        string $txHash,
        string $expectedSender,
        string $tokenAddress,
        string $expectedRecipient,
        ?string $rpcUrl = null,
    ): ?string {
        $rpc = $rpcUrl
            ?: config('services.bridge.evm_rpc_url')
            ?: config('services.ethereum.rpc_url', 'https://rpc.cyberia.church');

        try {
            $response = Http::timeout(15)->post($rpc, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'eth_getTransactionReceipt',
                'params' => [$txHash],
            ]);

            $receipt = $response->json('result');

            if (! is_array($receipt) || ($receipt['status'] ?? null) !== '0x1') {
                Log::warning('Bridge: EVM receipt missing or failed', ['tx' => $txHash]);

                return null;
            }

            $transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
            $token = strtolower($tokenAddress);
            $sender = strtolower($expectedSender);
            $recipient = strtolower($expectedRecipient);

            foreach ($receipt['logs'] ?? [] as $log) {
                if (strtolower($log['address'] ?? '') !== $token) {
                    continue;
                }

                $topics = $log['topics'] ?? [];

                if (count($topics) < 3 || strtolower($topics[0]) !== $transferTopic) {
                    continue;
                }

                $from = '0x'.strtolower(substr($topics[1], -40));
                $to = '0x'.strtolower(substr($topics[2], -40));

                if ($from !== $sender || $to !== $recipient) {
                    continue;
                }

                return TokenAmount::hexToDec($log['data'] ?? '0x0');
            }

            Log::warning('Bridge: no matching Transfer log', [
                'tx' => $txHash,
                'token' => $tokenAddress,
                'expected_recipient' => $expectedRecipient,
            ]);

            return null;
        } catch (\Throwable $e) {
            Log::error('Bridge: verifyEvmDeposit failed', [
                'tx' => $txHash,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Verify a NATIVE-coin deposit on an EVM chain (e.g. BNB sent to the
     * relayer EOA on BSC): the tx itself must move value from the sender to
     * the deposit address and be successfully mined. Returns the value in wei.
     */
    public function verifyEvmNativeDeposit(
        string $txHash,
        string $expectedSender,
        string $expectedRecipient,
        string $rpcUrl,
    ): ?string {
        try {
            $txResponse = Http::timeout(15)->post($rpcUrl, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'eth_getTransactionByHash',
                'params' => [$txHash],
            ]);

            $tx = $txResponse->json('result');

            if (! is_array($tx)) {
                Log::warning('Bridge: EVM native tx not found', ['tx' => $txHash]);

                return null;
            }

            if (strtolower((string) ($tx['from'] ?? '')) !== strtolower($expectedSender)
                || strtolower((string) ($tx['to'] ?? '')) !== strtolower($expectedRecipient)) {
                Log::warning('Bridge: EVM native tx sender/recipient mismatch', ['tx' => $txHash]);

                return null;
            }

            $receiptResponse = Http::timeout(15)->post($rpcUrl, [
                'jsonrpc' => '2.0',
                'id' => 2,
                'method' => 'eth_getTransactionReceipt',
                'params' => [$txHash],
            ]);

            $receipt = $receiptResponse->json('result');

            if (! is_array($receipt) || ($receipt['status'] ?? null) !== '0x1') {
                Log::warning('Bridge: EVM native receipt missing or failed', ['tx' => $txHash]);

                return null;
            }

            $value = TokenAmount::hexToDec((string) ($tx['value'] ?? '0x0'));

            return bccomp($value, '0', 0) > 0 ? $value : null;
        } catch (\Throwable $e) {
            Log::error('Bridge: verifyEvmNativeDeposit failed', [
                'tx' => $txHash,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Direct/mint-model relay, config-driven: the route's source and
     * destination chains (config/bridge.php) pick the verification and payout
     * strategies, so adding an EVM chain is a config-only change.
     *
     * The order below is the whole fix for bridge request #68. It used to be
     * verify → burn → pay, so a destination that could not pay was discovered
     * with the user's wrapper already destroyed and nothing to hand back. It
     * is now:
     *
     *   verify → capacity (under the destination pool's lock) → pay → record
     *   the hash durably → confirm → burn
     *
     * Every step before the payout is reversible, and every step after it is
     * idempotent. The state "wrapper burned, payout impossible" has no path
     * left that reaches it.
     */
    public function processDirectRelay(BridgeRequest $request): bool
    {
        if (! in_array($request->status, [
            BridgeRequest::PENDING,
            BridgeRequest::PROCESSING,
            BridgeRequest::AWAITING_LIQUIDITY,
            BridgeRequest::PAYING_OUT,
            BridgeRequest::BURN_PENDING,
        ], true)) {
            return false;
        }

        $context = $this->relayContext($request);

        if ($context === null) {
            return false;
        }

        if ($request->status !== BridgeRequest::PROCESSING) {
            $request->markProcessing();
        }

        try {
            // A request that has already spent money never re-enters the
            // payout branch, whatever state it was picked up in.
            if ($request->hasPayout()) {
                return $this->resumeAfterPayout($request, $context);
            }

            $feeAmount = (string) ($request->fee_amount ?: '0');
            $nativeGasFee = BridgeAmount::sourceFee($request->direction, $request->token,
                app(BridgeFeeService::class)->nativePayoutFee($request->direction, $request->token), $request);

            if (bccomp($nativeGasFee, $feeAmount, 18) > 0) {
                $feeAmount = $nativeGasFee;
                $request->update(['fee_amount' => $feeAmount]);
            }

            $netAmount = bcsub((string) $request->amount, $feeAmount, 18);

            if (bccomp($netAmount, '0', 18) <= 0) {
                $this->failRelay($request, 'Net amount after fee is zero or negative');

                return false;
            }

            $sourceChain = $context['source_chain'];
            $sourceToken = $context['source_token'];

            $verified = $this->verifySourceDeposit($request, $sourceChain, $sourceToken);

            if ($verified === null) {
                $this->failRelay($request, "Could not verify {$sourceChain['label']} deposit transaction");

                return false;
            }

            $claimedRaw = TokenAmount::toRaw((string) $request->amount, (int) $sourceToken['decimals']);

            // The on-chain transfer is the ground truth. The requested amount
            // can drift a few wei ABOVE what actually arrived (float casts in
            // the web layer and SQLite's REAL storage round 18-dec strings at
            // ~15 significant digits), and a user can also simply deposit less
            // than they typed. Either way settle for what the chain says —
            // never fail the request, never pay out more than was received.
            if (bccomp($verified, $claimedRaw, 0) < 0) {
                $verifiedAmount = TokenAmount::fromRaw($verified, (int) $sourceToken['decimals']);

                Log::warning('Bridge: deposit below claimed amount, settling for verified', [
                    'id' => $request->id,
                    'claimed' => $claimedRaw,
                    'verified' => $verified,
                ]);

                $request->update(['amount' => $verifiedAmount]);
                $claimedRaw = $verified;
                $netAmount = bcsub($verifiedAmount, $feeAmount, 18);

                if (bccomp($netAmount, '0', 18) <= 0) {
                    $this->failRelay($request, 'Net amount after fee is zero or negative');

                    return false;
                }
            }

            // The deposit is real: from here the bridge owes this payout and
            // the obligation is never released by a failure or a retry. The
            // ledger entry is written here as well as at submit, so a transfer
            // that reached the relayer by any other road is still counted
            // against the destination reserve.
            $request->markSourceVerified();
            app(BridgeAdmissionService::class)->commit($request, null);

            $destinationNet = BridgeAmount::destination($request->direction, $request->token, $netAmount, $request);

            if (bccomp($destinationNet, '0', 18) <= 0) {
                $this->failRelay($request, 'Converted destination amount is below one atomic unit');

                return false;
            }

            return $this->deliver($request, $context, $destinationNet, $claimedRaw);
        } catch (\Throwable $e) {
            $this->failRelay($request, $e->getMessage());
            Log::error('Bridge: direct relay failed', [
                'id' => $request->id,
                'error' => $e->getMessage(),
            ]);

            return false;
        }
    }

    /**
     * Capacity check and payout, both inside the destination pool's lock.
     *
     * Holding one lock across "read the balance" and "spend the balance" is
     * what stops two payouts from each believing they are the last one the
     * inventory covers. The read is deliberately re-done here rather than
     * trusted from submit time: minutes may have passed, and the answer is
     * about the world.
     *
     * @param  array<string, mixed>  $context
     */
    private function deliver(BridgeRequest $request, array $context, string $netAmount, string $claimedRaw): bool
    {
        $admission = app(BridgeAdmissionService::class);
        $inventory = app(BridgeInventoryService::class);
        $pool = $inventory->poolKey($request->direction, $request->token);

        if ($pool === null) {
            $this->failRelay($request, "Route {$request->direction} has no destination inventory pool");

            return false;
        }

        $lock = $admission->poolLock($pool);

        try {
            $lock->block((int) config('bridge.inventory.pool_lock_wait_seconds', 5));
        } catch (LockTimeoutException) {
            // Somebody else is paying out of this balance. Nothing has been
            // burned or sent, so parking is free and the retry is safe.
            $request->markAwaitingLiquidity('Another payout is using the destination reserve — retrying shortly');

            return false;
        }

        try {
            $decimals = $inventory->destinationDecimals($request->direction, $request->token) ?? 18;
            $netRaw = TokenAmount::toRaw($netAmount, $decimals);
            $capacity = $admission->capacityForPayout($request);

            if (! $capacity->covers($netRaw)) {
                $request->markAwaitingLiquidity($this->liquidityReason($capacity, $netRaw, $decimals));

                Log::warning('Bridge: payout parked awaiting liquidity', [
                    'id' => $request->id,
                    'pool' => $pool,
                    'capacity' => $capacity->state,
                    'needed_raw' => $netRaw,
                    'available_raw' => $capacity->availableRaw,
                ]);

                return false;
            }

            $confirmed = $this->payoutDestination(
                $request,
                $context['destination_chain'],
                $context['destination_token'],
                $context['token_config'],
                $netAmount,
            );

            if (! $confirmed) {
                // A payout that broadcast but was not confirmed keeps its hash
                // and its state: the retry reconciles that hash instead of
                // sending a second one. Either way the wrapper is untouched.
                if (! $request->hasPayout()) {
                    $this->failRelay($request, $request->error_message ?: 'Destination payout failed');
                }

                return false;
            }

            $request->update(['payout_confirmed_at' => now()]);

            return $this->burnAndComplete($request, $context, $claimedRaw);
        } finally {
            $lock->release();
        }
    }

    /**
     * Picked up with a payout hash already on the row: reconcile it, never
     * send a second one.
     *
     * @param  array<string, mixed>  $context
     */
    private function resumeAfterPayout(BridgeRequest $request, array $context): bool
    {
        $hash = (string) $request->destination_tx_hash;

        if ($request->payout_confirmed_at === null) {
            $status = $this->payoutSucceeded($context['destination_chain'], $hash);

            if ($status === false) {
                // Definitively reverted: nothing moved, so the payout may be
                // attempted again. Clearing the hash is the only place in this
                // service where that is allowed, and it is on chain evidence.
                Log::warning('Bridge: recorded payout reverted on chain, allowing a fresh attempt', [
                    'id' => $request->id,
                    'tx' => $hash,
                ]);
                $request->update([
                    'destination_tx_hash' => null,
                    'payout_broadcast_at' => null,
                    'status' => BridgeRequest::PENDING,
                ]);

                return $this->processDirectRelay($request->refresh());
            }

            if ($status === null) {
                // Unknown: the transaction was broadcast and we cannot see it
                // yet. Waiting costs a delay; guessing costs a double payout.
                $request->update([
                    'status' => BridgeRequest::PAYING_OUT,
                    'error_message' => 'Payout broadcast; waiting for confirmation on the destination chain',
                ]);

                return false;
            }

            $request->update(['payout_confirmed_at' => now()]);
        }

        $claimedRaw = TokenAmount::toRaw(
            (string) $request->amount,
            (int) ($context['source_token']['decimals'] ?? 18),
        );

        return $this->burnAndComplete($request, $context, $claimedRaw);
    }

    /**
     * The last step, and the only destructive one.
     *
     * Leaving a chain where the deposit is a relayer-owned wrapper (the home
     * chain, or an 'owned' entry like bridged CYBER on Robinhood) with a
     * mint-model token: destroy the wrapper the user deposited so supply stays
     * backed by the destination-side reserve. Deposits on external EVM chains
     * (e.g. canonical USDT on BSC) are reserves — never burn.
     *
     * It happens only after the recipient has been paid, so a burn that fails
     * leaves the request in `burn_pending` — an accounting job for a retry,
     * not a lost transfer.
     *
     * @param  array<string, mixed>  $context
     */
    private function burnAndComplete(BridgeRequest $request, array $context, string $claimedRaw): bool
    {
        app(BridgeAdmissionService::class)->settle($request);

        if ($this->needsWrapperBurn($request, $context)) {
            $burned = $this->burnEvmWrapper(
                (string) $context['source_token']['address'],
                $claimedRaw,
                $request,
                $context['source_chain'],
            );

            if (! $burned) {
                $request->markBurnPending(
                    'Payout delivered; burning the deposited wrapper failed and will be retried',
                );

                Log::error('Bridge: payout delivered but wrapper burn failed', [
                    'id' => $request->id,
                    'tx' => $request->destination_tx_hash,
                ]);

                return false;
            }

            $request->update(['wrapper_burned' => true]);
        }

        $request->markCompleted((string) $request->destination_tx_hash);

        return true;
    }

    /**
     * @param  array<string, mixed>  $context
     */
    private function needsWrapperBurn(BridgeRequest $request, array $context): bool
    {
        $sourceChain = $context['source_chain'];
        $sourceToken = $context['source_token'];

        return ($sourceChain['type'] ?? '') === 'evm'
            && ($sourceChain['key'] === config('bridge.home_chain', 'cyberia')
                || ($sourceToken['owned'] ?? false))
            && ($context['token_config']['model'] ?? 'direct') === 'mint'
            && ! ($sourceToken['native'] ?? false)
            && ! $request->wrapper_burned;
    }

    /**
     * Resolve every config lookup a relay needs, marking the request failed
     * with the precise reason when one is missing.
     *
     * @return array<string, mixed>|null
     */
    private function relayContext(BridgeRequest $request): ?array
    {
        $tokenConfig = config('bridge.tokens', [])[$request->token] ?? null;

        if (! is_array($tokenConfig)) {
            $this->failRelay($request, "Unknown token: {$request->token}");

            return null;
        }

        $route = config('bridge.routes', [])[$request->direction] ?? null;

        if (! is_array($route)) {
            $this->failRelay($request, "Unknown direction: {$request->direction}");

            return null;
        }

        $sourceChain = config('bridge.chains', [])[$route['source_chain']] ?? null;
        $destinationChain = config('bridge.chains', [])[$route['destination_chain']] ?? null;

        if (! is_array($sourceChain) || ! is_array($destinationChain)) {
            $this->failRelay($request, "Route {$request->direction} references an unknown chain");

            return null;
        }

        $sourceToken = $tokenConfig['chains'][$sourceChain['key']] ?? null;
        $destinationToken = $tokenConfig['chains'][$destinationChain['key']] ?? null;

        if (! is_array($sourceToken) || ! is_array($destinationToken)) {
            $this->failRelay($request, "Token {$request->token} is not configured for route {$request->direction}");

            return null;
        }

        return [
            'token_config' => $tokenConfig,
            'route' => $route,
            'source_chain' => $sourceChain,
            'destination_chain' => $destinationChain,
            'source_token' => $sourceToken,
            'destination_token' => $destinationToken,
        ];
    }

    /**
     * Terminal failure. The reservation is returned to the pool only when the
     * source transfer was never confirmed — after that the promise stands.
     */
    private function failRelay(BridgeRequest $request, string $error): void
    {
        $request->markFailed($error);
        app(BridgeAdmissionService::class)->releaseFor($request, 'request failed before a verified deposit');
    }

    private function liquidityReason(BridgeCapacity $capacity, string $netRaw, int $decimals): string
    {
        if ($capacity->isUnavailable()) {
            return 'Destination inventory could not be read, so the payout is held rather than guessed'
                .($capacity->reason ? ' ('.$capacity->reason.')' : '');
        }

        return sprintf(
            'Awaiting liquidity on the destination chain: %s needed, %s available',
            TokenAmount::fromRaw($netRaw, $decimals),
            $capacity->availableAmount() ?? '0',
        );
    }

    /**
     * Verify the source-chain deposit and return the raw deposited amount.
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function verifySourceDeposit(BridgeRequest $request, array $chain, array $tokenEntry): ?string
    {
        return match ($chain['type'] ?? '') {
            'solana' => ($tokenEntry['native'] ?? false)
                ? $this->verifySolanaNativeDeposit(
                    $request->source_tx_hash,
                    $request->sender_address,
                    $chain['deposit_address'] ?? null,
                )
                : $this->verifySolanaTokenDeposit(
                    $request->source_tx_hash,
                    $request->sender_address,
                    (string) $tokenEntry['mint'],
                    $chain['deposit_address'] ?? null,
                ),
            'evm' => ($tokenEntry['native'] ?? false)
                ? $this->verifyEvmNativeDeposit(
                    $request->source_tx_hash,
                    $request->sender_address,
                    $this->evmDepositAddress($chain),
                    (string) $chain['rpc_url'],
                )
                : $this->verifyEvmDeposit(
                    $request->source_tx_hash,
                    $request->sender_address,
                    (string) $tokenEntry['address'],
                    $this->evmDepositAddress($chain),
                    (string) $chain['rpc_url'],
                ),
            'ton' => $this->verifyTonDeposit($request, $chain, $tokenEntry),
            // Whatever the user deposited to THIS request's one-time address is
            // what gets minted — the address binds the deposit to this request
            // and its committed recipient. No amount or tx hash needed, which
            // is the only shape a Monero deposit can have at all: nobody
            // outside this wallet can look one up.
            'yenten', 'monero', 'bitcoin', 'litecoin' => app(BridgeDepositWatcher::class)
                ->confirmedBalance($request, $chain),
            default => null,
        };
    }

    /**
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function verifyTonDeposit(BridgeRequest $request, array $chain, array $tokenEntry): ?string
    {
        $txHash = TonApiService::normalizeTxHash($request->source_tx_hash);
        $sender = TonApiService::normalizeAddress($request->sender_address);
        $recipient = TonApiService::normalizeAddress((string) ($chain['deposit_address'] ?? ''));

        if (! $txHash || ! $sender || ! $recipient) {
            Log::warning('Bridge: TON deposit fields failed normalization', [
                'id' => $request->id,
                'tx_ok' => (bool) $txHash,
                'sender_ok' => (bool) $sender,
            ]);

            return null;
        }

        $tonApi = app(TonApiService::class);

        if ($tokenEntry['native'] ?? false) {
            $verified = $tonApi->verifyNativeDeposit($txHash, $sender, $recipient);
        } else {
            $master = TonApiService::normalizeAddress((string) $tokenEntry['master']);

            if (! $master) {
                return null;
            }

            $verified = $tonApi->verifyJettonDeposit($txHash, $sender, $master, $recipient);
        }

        if ($verified === null) {
            return null;
        }

        // TON Connect submits the external-message hash, not the transaction
        // hash. Re-point the request at the canonical event id so the same
        // deposit resubmitted under its other encoding trips the
        // source_tx_hash unique constraint instead of double-minting.
        if ($verified['event_id'] !== $txHash) {
            try {
                $request->update(['source_tx_hash' => $verified['event_id']]);
            } catch (UniqueConstraintViolationException) {
                Log::warning('Bridge: TON deposit already claimed under its canonical hash', [
                    'id' => $request->id,
                    'event_id' => $verified['event_id'],
                ]);

                return null;
            }
        }

        return $verified['amount'];
    }

    /**
     * Deposit address on an EVM chain: explicit config value or relayer EOA.
     *
     * @param  array<string, mixed>  $chain
     */
    private function evmDepositAddress(array $chain): string
    {
        $explicit = $chain['deposit_address'] ?? null;

        if (is_string($explicit) && $explicit !== '') {
            return $explicit;
        }

        return (string) app(BridgeRelayerService::class)->evmAddress();
    }

    /**
     * Pay out the net amount on the destination chain.
     *
     * Returns true only when the payout is CONFIRMED. A false with a hash on
     * the request means "broadcast, not yet confirmed" — a state the caller
     * must never treat as a failure, because retrying it double-pays.
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     * @param  array<string, mixed>  $tokenConfig
     */
    private function payoutDestination(
        BridgeRequest $request,
        array $chain,
        array $tokenEntry,
        array $tokenConfig,
        string $netAmount,
    ): bool {
        return match ($chain['type'] ?? '') {
            'evm' => $this->payoutEvm($request, $chain, $tokenEntry, $tokenConfig, $netAmount),
            'solana' => $this->payoutSolana($request, $chain, $tokenEntry, $netAmount),
            'ton' => $this->payoutTon($request, $chain, $tokenEntry, $netAmount),
            'yenten' => $this->payoutYenten($request, $chain, $tokenEntry, $netAmount),
            'monero' => $this->payoutMonero($request, $tokenEntry, $netAmount),
            'bitcoin', 'litecoin' => $this->payoutUtxo($request, $chain, $tokenEntry, $netAmount),
            default => tap(false, fn () => $request->markFailed("No payout strategy for chain type '{$chain['type']}'")),
        };
    }

    /**
     * On-chain verdict on a payout hash we already recorded:
     *   true  = it happened,
     *   false = it is on chain and reverted (nothing moved),
     *   null  = we cannot tell — never re-pay on this answer.
     *
     * @param  array<string, mixed>  $chain
     */
    private function payoutSucceeded(array $chain, string $txHash): ?bool
    {
        return match ($chain['type'] ?? '') {
            'evm' => $this->evmTxSucceeded((string) $chain['rpc_url'], $txHash),
            'solana' => $this->solanaTxSucceeded((string) $chain['rpc_url'], $txHash),
            // The wallet that sent it is the only thing that can be asked
            // about a Monero transaction, and it is right here.
            'monero' => app(MoneroWalletRpc::class)->payoutSucceeded($txHash),
            // A Bitcoin-family payout cannot revert: it is in a block, in the
            // mempool, or nowhere yet. The index therefore answers true or
            // "cannot tell", and never false — a broadcast that has not
            // surfaced may still be in flight.
            'bitcoin', 'litecoin' => app(EsploraApiService::class)
                ->transactionExists((string) ($chain['key'] ?? ''), $txHash),
            // TON and Yenten payouts carry a query_id / request id and their
            // relay scripts reconcile a lost broadcast themselves; we cannot
            // add a cheaper check here than re-running them, so an unknown
            // stays unknown rather than becoming a second transfer.
            default => null,
        };
    }

    /**
     * Signature status for a recorded Solana payout. `getSignatureStatuses`
     * with history search is the one read that answers "did this signature
     * ever land" without needing the transaction to still be in the recent
     * cache.
     */
    private function solanaTxSucceeded(string $rpcUrl, string $signature): ?bool
    {
        try {
            $response = Http::timeout(15)->post($rpcUrl, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getSignatureStatuses',
                'params' => [[$signature], ['searchTransactionHistory' => true]],
            ]);

            if (! $response->successful()) {
                return null;
            }

            $status = $response->json('result.value.0');

            if (! is_array($status)) {
                return null;
            }

            return ($status['err'] ?? null) === null;
        } catch (\Throwable $e) {
            Log::warning('Bridge: solana signature status check failed', [
                'signature' => $signature,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Record a payout hash the moment it is known — before any receipt wait,
     * before any confirmation. Everything that keeps a crashed process from
     * paying twice hangs off this one write.
     */
    private function recordBroadcast(?BridgeRequest $request, ?string $hash): void
    {
        if ($request === null || $hash === null || $hash === '' || $request->hasPayout()) {
            return;
        }

        $request->markPayoutBroadcast($hash);
        app(BridgeAdmissionService::class)->settle($request);
    }

    /**
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     * @param  array<string, mixed>  $tokenConfig
     */
    private function payoutEvm(
        BridgeRequest $request,
        array $chain,
        array $tokenEntry,
        array $tokenConfig,
        string $netAmount,
    ): bool {
        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);

        $gasDropWei = '0';

        if ($request->gas_drop_planned && $request->gas_drop_amount) {
            $gasDropWei = TokenAmount::toRaw((string) $request->gas_drop_amount, 18);
        }

        $isHomeChain = ($chain['key'] ?? '') === config('bridge.home_chain', 'cyberia');

        if ($tokenEntry['native'] ?? false) {
            // Native-coin payout from the relayer balance (e.g. BNB on BSC).
            $args = ['scripts/relay-native-transfer.ts', $request->recipient_address, $amountRaw];
        } elseif (($tokenConfig['model'] ?? 'direct') === 'mint'
            && ($isHomeChain || ($tokenEntry['owned'] ?? false))) {
            // Relayer owns the wrapper (home chain, or an 'owned' entry such
            // as bridged CYBER on Robinhood): mint to recipient on demand.
            $args = ['scripts/relay-mint.ts', (string) $tokenEntry['address'], $request->recipient_address, $amountRaw, $gasDropWei];
        } else {
            // External chain or direct model: pay out of relayer inventory
            // (e.g. canonical USDT on BSC) with a plain ERC20 transfer.
            $args = ['scripts/relay-erc20-transfer.ts', (string) $tokenEntry['address'], $request->recipient_address, $amountRaw, $gasDropWei];
        }

        $outcome = $this->runEvmRelayScript($args, $chain, $request->id, $request);

        if ($outcome['hash'] === null) {
            $request->markFailed('Relay failed on '.$chain['label']);

            return false;
        }

        $this->recordBroadcast($request, $outcome['hash']);

        return $outcome['confirmed'];
    }

    /**
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function payoutSolana(BridgeRequest $request, array $chain, array $tokenEntry, string $netAmount): bool
    {
        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);

        $scriptDir = Environment::isProduction()
            ? '/singularity/crypto/anchor'
            : base_path('/../../crypto/anchor');

        $home = env('HOME', $_SERVER['HOME'] ?? '/home/lain');

        $walletPath = Environment::isProduction()
            ? '/solana/id.json'
            : $home.'/.config/solana/id.json';

        // Native SOL pays out with a plain system transfer from the hot
        // wallet; SPL tokens go through the parametrised token relay.
        $args = ($tokenEntry['native'] ?? false)
            ? [
                'scripts/relay-sol-transfer.ts',
                $request->recipient_address,
                $amountRaw,
            ]
            : [
                'scripts/relay-spl-transfer.ts',
                (string) $tokenEntry['mint'],
                $request->recipient_address,
                $amountRaw,
                (string) ($tokenEntry['token_program'] ?? 'token'),
            ];

        // The relay scripts print {"broadcastTxHash":…} the moment the
        // signature exists and before they wait for confirmation, so the
        // signature is on the row even if this process dies waiting. A Solana
        // signature is not recoverable from anywhere else — losing it means
        // the only way to find the payout is a human reading an explorer.
        $captured = '';

        try {
            $result = Process::path($scriptDir)
                ->env([
                    'ANCHOR_PROVIDER_URL' => (string) $chain['rpc_url'],
                    'ANCHOR_WALLET' => $walletPath,
                ])
                ->timeout((int) config('bridge.relay.solana_timeout_seconds', 120))
                ->run(
                    ['npx', 'ts-node', '--transpile-only', ...$args],
                    function (string $type, string $buffer) use (&$captured, $request) {
                        $captured .= $buffer;
                        $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
                    },
                );
        } catch (ProcessTimedOutException) {
            $broadcast = $this->extractRelayTxHash($captured);
            $this->recordBroadcast($request, $broadcast);

            Log::warning('Bridge relay payout solana timed out', [
                'id' => $request->id,
                'broadcast_tx_hash' => $broadcast,
                'output' => $captured,
            ]);

            if ($broadcast === null) {
                $request->markFailed('Solana relay timed out before broadcasting');
            }

            return false;
        }

        Log::info('Bridge relay payout solana', [
            'id' => $request->id,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        $broadcast = $this->extractRelayTxHash($result->output());
        $this->recordBroadcast($request, $broadcast);

        if ($result->exitCode() !== 0) {
            if ($broadcast === null) {
                $request->markFailed('Solana relay failed: '.$result->errorOutput());
            }

            return false;
        }

        $json = $this->lastJsonLine($result->output());

        if (! $json || empty($json['txHash'])) {
            if ($broadcast === null) {
                $request->markFailed('Could not parse Solana relay output');
            }

            return false;
        }

        $this->recordBroadcast($request, (string) $json['txHash']);

        return true;
    }

    /**
     * TON payout via crypto/ton relay scripts: native Toncoin through
     * relay-ton-transfer.ts, jettons through relay-jetton-transfer.ts.
     * query_id = request id makes the transfer idempotent: each script checks
     * for an existing outgoing transfer with the same query_id before sending.
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function payoutTon(BridgeRequest $request, array $chain, array $tokenEntry, string $netAmount): bool
    {
        $mnemonic = (string) config('services.bridge.ton_relayer_mnemonic');

        if ($mnemonic === '') {
            $request->markFailed('TON relayer mnemonic not configured (TON_RELAYER_MNEMONIC)');

            return false;
        }

        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);
        $captured = '';

        $scriptDir = Environment::isProduction()
            ? '/singularity/crypto/ton'
            : base_path('/../../crypto/ton');

        $args = ($tokenEntry['native'] ?? false)
            ? [
                'scripts/relay-ton-transfer.ts',
                $request->recipient_address,
                $amountRaw,
                (string) $request->id,
            ]
            : [
                'scripts/relay-jetton-transfer.ts',
                (string) $tokenEntry['master'],
                $request->recipient_address,
                $amountRaw,
                (string) $request->id,
            ];

        $result = Process::path($scriptDir)
            ->env([
                'TON_RELAYER_MNEMONIC' => $mnemonic,
                'TONCENTER_RPC_URL' => (string) ($chain['toncenter_rpc_url'] ?? 'https://toncenter.com/api/v2/jsonRPC'),
                'TONCENTER_API_KEY' => (string) config('services.bridge.toncenter_api_key', ''),
                'TONAPI_URL' => (string) ($chain['api_url'] ?? 'https://tonapi.io'),
                'TONAPI_KEY' => (string) ($chain['api_key'] ?? ''),
            ])
            ->timeout((int) config('bridge.relay.ton_timeout_seconds', 240))
            ->run(['npx', 'tsx', ...$args], function (string $type, string $buffer) use (&$captured, $request) {
                $captured .= $buffer;
                $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
            });

        Log::info('Bridge relay payout ton', [
            'id' => $request->id,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        if ($result->exitCode() !== 0) {
            if (! $request->hasPayout()) {
                $request->markFailed('TON relay failed: '.$result->errorOutput());
            }

            return false;
        }

        $json = $this->lastJsonLine($result->output());

        if (! $json || empty($json['txHash'])) {
            if (! $request->hasPayout()) {
                $request->markFailed('Could not parse TON relay output');
            }

            return false;
        }

        $this->recordBroadcast($request, (string) $json['txHash']);

        return true;
    }

    /**
     * Native YTN payout through the official light-wallet API. The WIF stays
     * local to the relay process; only the signed raw transaction is broadcast.
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function payoutYenten(BridgeRequest $request, array $chain, array $tokenEntry, string $netAmount): bool
    {
        // Liquidity is pooled across every relayer-controlled address: the
        // central wallet plus the one-time deposit addresses (funds from
        // prior yenten_to_evm bridge-ins). The recipient receives the net
        // amount exactly; the network fee is paid by the pool out of the
        // flat YTN bridge fee retained above (yenten_payout_fee_ytn).
        $wifs = $this->yentenPayoutKeys($chain);

        if ($wifs === []) {
            $request->markFailed('Yenten relayer key not configured (BRIDGE_YENTEN_RELAYER_WIF / deposits)');

            return false;
        }

        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);
        $captured = '';
        $scriptDir = Environment::isProduction()
            ? '/singularity/crypto/yenten'
            : base_path('/../../crypto/yenten');

        $result = Process::path($scriptDir)
            ->env([
                'YENTEN_RELAYER_WIFS' => json_encode(array_values($wifs)),
                'YENTEN_CHANGE_ADDRESS' => (string) ($chain['deposit_address'] ?? ''),
                'YENTEN_API_URL' => (string) ($chain['api_url'] ?? 'https://api.yentencoin.info'),
            ])
            // Generous: the relay script retries slow light-wallet API reads
            // and reconciles a lost /broadcast response by polling the txid.
            ->timeout((int) config('bridge.relay.yenten_timeout_seconds', 300))
            ->run([
                'npm', 'run', '--silent', 'relay', '--',
                $request->recipient_address,
                $amountRaw,
                (string) $request->id,
            ], function (string $type, string $buffer) use (&$captured, $request) {
                $captured .= $buffer;
                $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
            });

        Log::info('Bridge relay payout yenten', [
            'id' => $request->id,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        if ($result->exitCode() !== 0) {
            if (! $request->hasPayout()) {
                $request->markFailed('Yenten relay failed: '.$result->errorOutput());
            }

            return false;
        }

        $json = $this->lastJsonLine($result->output());

        if (! $json || empty($json['txHash'])) {
            if (! $request->hasPayout()) {
                $request->markFailed('Could not parse Yenten relay output');
            }

            return false;
        }

        // Mark the deposit addresses whose coins funded this payout as swept.
        foreach ((array) ($json['spentAddresses'] ?? []) as $address) {
            BridgeRequest::where('deposit_address', $address)->update(['swept' => true]);
        }

        $this->recordBroadcast($request, (string) $json['txHash']);

        return true;
    }

    /**
     * Relayer signing keys for a Yenten payout: the central wallet plus the
     * one-time deposit-address keys still holding funds (unswept). Deposit keys
     * are stored encrypted per request.
     *
     * @param  array<string, mixed>  $chain
     * @return array<int, string> WIFs
     */
    private function yentenPayoutKeys(array $chain): array
    {
        $wifs = [];

        $central = (string) ($chain['relayer_wif'] ?? '');

        if ($central !== '') {
            $wifs[] = $central;
        }

        // Bounded set of unswept deposit keys. Only COMPLETED requests: their
        // deposit is claimed and minted, so the coins belong to the pool. An
        // awaiting_deposit address may hold a deposit the user has not claimed
        // yet — spending it would make the later claim come up empty. Never-
        // funded/expired rows are excluded the same way, so the relay does not
        // hammer the API over addresses that cannot hold pool funds.
        $deposits = BridgeRequest::query()
            ->where('source_chain', 'yenten')
            ->where('status', 'completed')
            ->whereNotNull('deposit_wif')
            ->where('swept', false)
            ->latest('id')
            ->limit(50)
            ->pluck('deposit_wif');

        foreach ($deposits as $wif) {
            if (is_string($wif) && $wif !== '') {
                $wifs[] = $wif;
            }
        }

        return array_values(array_unique($wifs));
    }

    /**
     * Send real Monero, once.
     *
     * There is no relay script and no subprocess here: `monero-wallet-rpc`
     * builds, signs and relays inside one HTTP call, so the whole payout is
     * that call plus the two questions around it.
     *
     * Those two questions are the entire design. A Monero transaction has no
     * client-chosen id to make the send idempotent, so the failure that
     * matters is not a refused payout — it is a `transfer` that went through
     * and whose *answer* was lost, leaving nothing on the row to stop a retry
     * from sending a second one. So: before spending, ask the wallet what it
     * has already sent for this request; mark the intent durably; send; and if
     * the answer does not come back, ask again with the amount match enabled,
     * because by then "possibly already paid" outranks "possibly pay twice".
     *
     * @param  array<string, mixed>  $tokenEntry
     */
    /**
     * Bitcoin and Litecoin, signed by the relay in crypto/utxo.
     *
     * The same arrangement as Yenten, because it is the same problem: the
     * pool is a set of addresses rather than one wallet, the recipient must
     * receive the net figure exactly, and the miner's fee comes out of the
     * flat bridge fee this corridor retained upstream. What differs is only
     * where the chain is read — a keyless Esplora index, the one both of these
     * chains have and Yenten does not.
     *
     * The hash is recorded as it is printed, before the broadcast, so a
     * process killed between sending and reporting still leaves a row that
     * names the transaction it sent.
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $tokenEntry
     */
    private function payoutUtxo(BridgeRequest $request, array $chain, array $tokenEntry, string $netAmount): bool
    {
        $chainKey = (string) ($chain['key'] ?? '');
        $wifs = app(UtxoPool::class)->wifs($chainKey);

        if ($wifs === []) {
            $request->markFailed(strtoupper($chainKey).' payout key is not configured on this server');

            return false;
        }

        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);
        $captured = '';
        $scriptDir = Environment::isProduction()
            ? '/singularity/crypto/utxo'
            : base_path('/../../crypto/utxo');

        $result = Process::path($scriptDir)
            ->env(array_filter([
                'UTXO_RELAYER_WIFS' => json_encode(array_values($wifs)),
                'UTXO_CHANGE_ADDRESS' => (string) ($chain['deposit_address'] ?? ''),
                'UTXO_ESPLORA_URL' => (string) ($chain['esplora_url'] ?? ''),
                'UTXO_FEE_TARGET_BLOCKS' => (string) ($chain['fee_target_blocks'] ?? ''),
                'UTXO_MAX_FEE_RATE' => (string) ($chain['max_fee_rate'] ?? ''),
            ], fn (string $value) => $value !== ''))
            // Generous: the relay retries a rate-limited index and, if the
            // broadcast's answer is lost, spends up to forty seconds asking
            // whether the transaction it already signed is visible.
            ->timeout((int) config('bridge.relay.utxo_timeout_seconds', 300))
            ->run([
                'npm', 'run', '--silent', 'relay', '--',
                $chainKey,
                (string) $request->recipient_address,
                $amountRaw,
                (string) $request->id,
            ], function (string $type, string $buffer) use (&$captured, $request) {
                $captured .= $buffer;
                $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
            });

        Log::info('Bridge relay payout utxo', [
            'id' => $request->id,
            'chain' => $chainKey,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        if ($result->exitCode() !== 0) {
            if (! $request->hasPayout()) {
                $request->markFailed(strtoupper($chainKey).' relay failed: '.$result->errorOutput());
            }

            return false;
        }

        $json = $this->lastJsonLine($result->output());

        if (! $json || empty($json['txHash'])) {
            if (! $request->hasPayout()) {
                $request->markFailed('Could not parse the '.$chainKey.' relay output');
            }

            return false;
        }

        // The deposit addresses whose coins funded this payout are spent now;
        // leaving them unswept would have the next payout read them again and
        // find nothing.
        foreach ((array) ($json['spentAddresses'] ?? []) as $address) {
            BridgeRequest::where('deposit_address', $address)->update(['swept' => true]);
        }

        $this->recordBroadcast($request, (string) $json['txHash']);

        return true;
    }

    private function payoutMonero(BridgeRequest $request, array $tokenEntry, string $netAmount): bool
    {
        $wallet = app(MoneroWalletRpc::class);

        if (! $wallet->configured()) {
            $request->markFailed('Monero payouts need a wallet on this server (BRIDGE_XMR_WALLET_RPC_URL)');

            return false;
        }

        $recipient = (string) $request->recipient_address;
        $amountRaw = TokenAmount::toRaw($netAmount, (int) $tokenEntry['decimals']);
        $note = "bridge:{$request->id}";
        // `payout_broadcast_at` with no hash beside it is this corridor's
        // record that a transfer was already handed to the wallet and never
        // reported back. The status cannot carry that — the relay sets it to
        // PROCESSING on the way in — so the timestamp is the marker, stamped
        // below before the money moves and cleared only where a payout is
        // proven on chain to have failed.
        $attempted = $request->payout_broadcast_at !== null;

        $already = $wallet->payoutFor(
            $note,
            $attempted ? $recipient : null,
            $attempted ? $amountRaw : null,
        );

        if ($already !== null) {
            Log::warning('Bridge: adopting an existing Monero payout instead of sending a second', [
                'id' => $request->id,
                'tx' => $already,
            ]);
            $this->recordBroadcast($request, $already);

            return true;
        }

        // The intent, written before the money moves. Nothing else on this row
        // can say "a transfer was attempted" until a hash exists.
        $request->update([
            'status' => BridgeRequest::PAYING_OUT,
            'payout_broadcast_at' => now(),
        ]);

        $sent = $wallet->transfer($recipient, $amountRaw, $note);

        if ($sent === null) {
            // No hash came back, which is NOT the same as nothing being sent.
            $recovered = $wallet->payoutFor($note, $recipient, $amountRaw);

            if ($recovered !== null) {
                Log::warning('Bridge: Monero payout recovered after a lost response', [
                    'id' => $request->id,
                    'tx' => $recovered,
                ]);
                $this->recordBroadcast($request, $recovered);

                return true;
            }

            if (! $request->hasPayout()) {
                $request->markFailed('Monero payout failed: the wallet returned no transaction');
            }

            return false;
        }

        Log::info('Bridge relay payout monero', [
            'id' => $request->id,
            'tx' => $sent['tx_hash'],
            'fee' => $sent['fee'],
        ]);

        $this->recordBroadcast($request, $sent['tx_hash']);

        return true;
    }

    /**
     * Run a hardhat relay script against an arbitrary EVM chain and return
     * the resulting tx hash, or null on failure.
     *
     * The relay scripts broadcast the payout, print its hash, then block on
     * the receipt. A slow destination RPC can push that wait past the timeout
     * even though the payout is already in the mempool — so we stream stdout
     * into a buffer and, on timeout, recover the broadcast hash. Returning it
     * lets the caller record the request completed instead of failing it; a
     * blind retry would send the payout a second time.
     *
     * `$request`, when given, has the broadcast hash written onto it the
     * instant the script prints it — from inside the output stream, before the
     * process has even exited. That is what a crash between the broadcast and
     * the DB write survives.
     *
     * @param  array<int, string>  $args  script path + its arguments
     * @param  array<string, mixed>  $chain
     * @return array{hash: string|null, confirmed: bool}
     */
    private function runEvmRelayScript(
        array $args,
        array $chain,
        int $requestId,
        ?BridgeRequest $request = null,
    ): array {
        $hardhatDir = Environment::isProduction()
            ? '/singularity/crypto/hardhat'
            : base_path('/../../crypto/hardhat');

        $captured = '';

        try {
            $result = Process::path($hardhatDir)
                ->env([
                    'EVM_RPC_URL' => (string) $chain['rpc_url'],
                    'EVM_CHAIN_ID' => (string) ($chain['evm_chain_id'] ?? ''),
                    // Back-compat for scripts still reading the legacy var.
                    'CYBERIA_RPC_URL' => (string) $chain['rpc_url'],
                    'BRIDGE_RELAYER_PRIVATE_KEY' => app(BridgeRelayerService::class)->privateKey() ?? '',
                ])
                ->timeout($this->relayScriptTimeout())
                ->run(['npx', 'tsx', ...$args], function (string $type, string $buffer) use (&$captured, $request) {
                    $captured .= $buffer;
                    $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
                });
        } catch (ProcessTimedOutException $e) {
            $broadcastHash = $this->extractRelayTxHash($captured);
            $this->recordBroadcast($request, $broadcastHash);

            Log::warning('Bridge relay evm script timed out waiting for receipt', [
                'id' => $requestId,
                'chain' => $chain['key'] ?? null,
                'script' => $args[0] ?? null,
                'broadcast_tx_hash' => $broadcastHash,
                'output' => $captured,
            ]);

            // null when it timed out before broadcasting — safe to retry then.
            return ['hash' => $broadcastHash, 'confirmed' => false];
        }

        Log::info('Bridge relay evm script', [
            'id' => $requestId,
            'chain' => $chain['key'] ?? null,
            'script' => $args[0] ?? null,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        if ($result->exitCode() !== 0) {
            // The script can broadcast the payout and then exit non-zero while
            // waiting for the receipt (a flaky destination RPC dropping the
            // connection: `read ETIMEDOUT`). The tx is already on-chain, so a
            // blind retry double-pays. If a broadcast hash reached us, confirm
            // it on-chain: recover it unless the chain says it reverted.
            $broadcastHash = $this->extractRelayTxHash($result->output());

            if ($broadcastHash === null) {
                return ['hash' => null, 'confirmed' => false];
            }

            $onChain = $this->evmTxSucceeded((string) $chain['rpc_url'], $broadcastHash);

            if ($onChain === false) {
                return ['hash' => null, 'confirmed' => false];
            }

            $this->recordBroadcast($request, $broadcastHash);

            Log::warning('Bridge relay evm script exited non-zero after broadcasting; recovered hash', [
                'id' => $requestId,
                'chain' => $chain['key'] ?? null,
                'script' => $args[0] ?? null,
                'broadcast_tx_hash' => $broadcastHash,
                'stderr' => $result->errorOutput(),
            ]);

            return ['hash' => $broadcastHash, 'confirmed' => $onChain === true];
        }

        $hash = $this->extractRelayTxHash($result->output());
        $this->recordBroadcast($request, $hash);

        return ['hash' => $hash, 'confirmed' => $hash !== null];
    }

    /**
     * Wall-clock budget for one relay subprocess. The job's own timeout and
     * the queue's retry_after are both derived from this in config, so a slow
     * chain can never be handed to a second worker mid-payout.
     */
    private function relayScriptTimeout(): int
    {
        return max(30, (int) config('bridge.relay.script_timeout_seconds', 120));
    }

    /**
     * On-chain receipt status for a relayer payout hash:
     *   true  = mined and succeeded,
     *   false = mined and reverted (a real failure, safe to retry),
     *   null  = not found yet / RPC unreachable (treat as still pending — the
     *           tx was broadcast, so recovering its hash beats a double-pay).
     */
    private function evmTxSucceeded(string $rpcUrl, string $txHash): ?bool
    {
        try {
            $response = Http::timeout(15)->post($rpcUrl, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'eth_getTransactionReceipt',
                'params' => [$txHash],
            ]);

            $receipt = $response->json('result');

            if (! $response->successful() || ! is_array($receipt)) {
                return null;
            }

            return match ($receipt['status'] ?? null) {
                '0x1' => true,
                '0x0' => false,
                default => null,
            };
        } catch (\Throwable $e) {
            Log::warning('Bridge: evmTxSucceeded receipt check failed', [
                'tx' => $txHash,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Pull the relayer tx hash from EVM relay-script stdout, newest line first.
     * Accepts the confirmed {"txHash":...} line and the pre-receipt
     * {"broadcastTxHash":...} line the scripts print the moment the tx is
     * broadcast, so a receipt-wait timeout can still recover the hash. The
     * native conversion path keeps the first mint broadcast as its retry
     * guard, even when later conversion broadcasts share an output chunk.
     */
    private function extractRelayTxHash(string $output, bool $firstBroadcast = false): ?string
    {
        $lines = array_filter(array_map('trim', explode("\n", $output)));

        if ($firstBroadcast) {
            foreach ($lines as $line) {
                $json = json_decode($line, true);
                $hash = is_array($json) ? ($json['broadcastTxHash'] ?? null) : null;

                if (is_string($hash) && $hash !== '') {
                    return $hash;
                }
            }
        }

        foreach (array_reverse($lines) as $line) {
            $json = json_decode($line, true);

            if (! is_array($json)) {
                continue;
            }

            $hash = $json['txHash'] ?? $json['broadcastTxHash'] ?? null;

            if (is_string($hash) && $hash !== '') {
                return $hash;
            }
        }

        return null;
    }

    /**
     * Burn the relayer's freshly-received wrapper-token balance so EVM supply
     * stays in sync with the destination-side reserve. Used by the mint model
     * when bridging OUT of an EVM chain.
     *
     * @param  array<string, mixed>  $chain
     */
    private function burnEvmWrapper(string $tokenAddress, string $amountWei, BridgeRequest $request, array $chain): bool
    {
        if ($request->wrapper_burn_tx_hash !== null) {
            $succeeded = $this->evmTxSucceeded((string) $chain['rpc_url'], $request->wrapper_burn_tx_hash);

            if ($succeeded !== false) {
                return $succeeded === true;
            }

            $request->update(['wrapper_burn_tx_hash' => null]);
        }

        $hardhatDir = Environment::isProduction()
            ? '/singularity/crypto/hardhat'
            : base_path('/../../crypto/hardhat');

        $captured = '';

        try {
            $result = Process::path($hardhatDir)
                ->env([
                    'EVM_RPC_URL' => (string) $chain['rpc_url'],
                    'EVM_CHAIN_ID' => (string) ($chain['evm_chain_id'] ?? ''),
                    'CYBERIA_RPC_URL' => (string) $chain['rpc_url'],
                    'BRIDGE_RELAYER_PRIVATE_KEY' => app(BridgeRelayerService::class)->privateKey() ?? '',
                ])
                ->timeout($this->relayScriptTimeout())
                ->run([
                    'npx', 'tsx', 'scripts/relay-burn.ts',
                    $tokenAddress,
                    $amountWei,
                ], function (string $type, string $buffer) use (&$captured, $request) {
                    $captured .= $buffer;
                    $this->recordWrapperBurn($request, $this->extractRelayTxHash($captured));
                });
        } catch (ProcessTimedOutException) {
            $this->recordWrapperBurn($request, $this->extractRelayTxHash($captured));

            Log::warning('Bridge relay wrapper burn timed out', [
                'id' => $request->id,
                'burn_tx_hash' => $request->wrapper_burn_tx_hash,
            ]);

            return $request->wrapper_burn_tx_hash !== null
                && $this->evmTxSucceeded((string) $chain['rpc_url'], $request->wrapper_burn_tx_hash) === true;
        }

        $this->recordWrapperBurn($request, $this->extractRelayTxHash($result->output()));

        Log::info('Bridge relay burn wrapper', [
            'id' => $request->id,
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'exit' => $result->exitCode(),
        ]);

        if ($request->wrapper_burn_tx_hash === null) {
            return false;
        }

        return $result->exitCode() === 0
            || $this->evmTxSucceeded((string) $chain['rpc_url'], $request->wrapper_burn_tx_hash) === true;
    }

    private function recordWrapperBurn(BridgeRequest $request, ?string $hash): void
    {
        if ($hash !== null && $hash !== '' && $request->wrapper_burn_tx_hash === null) {
            $request->update(['wrapper_burn_tx_hash' => $hash]);
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function lastJsonLine(string $output): ?array
    {
        $lines = array_filter(explode("\n", trim($output)));
        $last = end($lines);

        if ($last === false) {
            return null;
        }

        $decoded = json_decode($last, true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Read-only native source proof. A missing RPC answer is retryable; a
     * transaction that proves a different transfer must never reach a signer.
     *
     * @return array<string, mixed>|null
     */
    private function nativeSourceRpc(string $url, string $method, array $params): ?array
    {
        try {
            $response = Http::timeout(30)->post($url, [
                'jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params,
            ]);

            $result = $response->successful() ? $response->json('result') : null;

            return is_array($result) && $result !== [] ? $result : null;
        } catch (\Exception) {
            Log::warning('Bridge: native source RPC unavailable', ['method' => $method]);

            return null;
        }
    }

    private function solanaRecipientHex(string $address): ?string
    {
        $alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        $number = '0';

        if (strlen($address) < 32 || strlen($address) > 44) {
            return null;
        }

        foreach (str_split($address) as $character) {
            $digit = strpos($alphabet, $character);

            if ($digit === false) {
                return null;
            }

            $number = bcadd(bcmul($number, '58', 0), (string) $digit, 0);
        }

        $bytes = '';
        while (bccomp($number, '0', 0) > 0) {
            $bytes = chr((int) bcmod($number, '256')).$bytes;
            $number = bcdiv($number, '256', 0);
        }
        $bytes = str_repeat("\x00", strspn($address, '1')).$bytes;

        return strlen($bytes) === 32 ? bin2hex($bytes) : null;
    }

    /**
     * The wrapper burn proves gross; RedeemCyberSol proves net and recipient.
     * This also supports a smart wallet calling the bridge internally. Only
     * direct calls get an additional calldata check; no current fee is read.
     *
     * @return array{gross: string, net: string}|null
     */
    private function verifyNativeEvmRedemption(BridgeRequest $request): ?array
    {
        $bridge = strtolower((string) (config('services.bridge.evm_bridge_address') ?: '0xEf2c8E731006EEDD8F44f5Ea03A389635BB28f90'));
        $wrapper = strtolower((string) (config('bridge.tokens', [])['CYBER.sol']['chains']['cyberia']['address'] ?? ''));
        $sender = strtolower((string) $request->sender_address);
        $recipient = $this->solanaRecipientHex((string) $request->recipient_address);
        $hash = strtolower((string) $request->source_tx_hash);

        if (! preg_match('/^0x[0-9a-f]{64}$/', $hash)
            || ! preg_match('/^0x[0-9a-f]{40}$/', $sender)
            || ! preg_match('/^0x[0-9a-f]{40}$/', $bridge)
            || ! preg_match('/^0x[0-9a-f]{40}$/', $wrapper)
            || $recipient === null || $request->source_nonce < 0) {
            throw new \UnexpectedValueException('Native redemption source details are missing or invalid');
        }

        $rpc = (string) config('bridge.chains.cyberia.rpc_url');
        $receipt = $this->nativeSourceRpc($rpc, 'eth_getTransactionReceipt', [$hash]);
        $transaction = $this->nativeSourceRpc($rpc, 'eth_getTransactionByHash', [$hash]);

        if ($receipt === null || $transaction === null) {
            return null;
        }

        if (! isset($receipt['status'], $receipt['transactionHash'], $receipt['logs'], $transaction['hash'])) {
            return null;
        }

        if (($receipt['status'] ?? null) !== '0x1'
            || strtolower((string) ($receipt['transactionHash'] ?? '')) !== $hash
            || strtolower((string) ($transaction['hash'] ?? '')) !== $hash) {
            throw new \UnexpectedValueException('Native redemption transaction did not succeed');
        }

        $redeemTopic = '0xb0f588ab32e51856c4eb70cdd8ace980ec59d74616c821513d605629ec06b610';
        $transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        $senderTopic = '0x'.str_pad(substr($sender, 2), 64, '0', STR_PAD_LEFT);
        $burn = null;
        $proof = null;

        foreach ($receipt['logs'] ?? [] as $log) {
            $address = strtolower((string) ($log['address'] ?? ''));
            $topics = array_map(fn ($topic) => is_string($topic) ? strtolower($topic) : '', $log['topics'] ?? []);
            $data = strtolower((string) ($log['data'] ?? ''));

            if ($address === $wrapper && $topics === [$transferTopic, $senderTopic, '0x'.str_repeat('0', 64)]
                && preg_match('/^0x[0-9a-f]{64}$/', $data) && ! ($log['removed'] ?? false)) {
                $burn = TokenAmount::hexToDec($data);
            }

            if ($address !== $bridge || ($topics[0] ?? null) !== $redeemTopic) {
                continue;
            }

            if ($topics === [$redeemTopic, $senderTopic]
                && preg_match('/^0x[0-9a-f]{192}$/', $data)
                && substr($data, 66, 64) === $recipient
                && TokenAmount::hexToDec(substr($data, 130, 64)) === (string) $request->source_nonce
                && ! ($log['removed'] ?? false)) {
                $net = TokenAmount::hexToDec(substr($data, 2, 64));

                if ($proof !== null || $burn === null || bccomp($burn, '0', 0) <= 0
                    || bccomp($net, '0', 0) <= 0 || bccomp($net, $burn, 0) > 0) {
                    throw new \UnexpectedValueException('Native redemption burn and event do not agree');
                }

                $proof = ['gross' => $burn, 'net' => $net];
            }

            // A burn belongs to its following redemption, never to a later
            // nonce in a wallet batch containing several bridge calls.
            $burn = null;
        }

        if ($proof === null) {
            throw new \UnexpectedValueException('No matching native redemption and wrapper burn');
        }

        if (strtolower((string) ($transaction['to'] ?? '')) === $bridge) {
            $input = strtolower((string) ($transaction['input'] ?? ''));

            if (strtolower((string) ($transaction['from'] ?? '')) !== $sender
                || ! preg_match('/^0x6714c820[0-9a-f]{128}$/', $input)
                || TokenAmount::hexToDec(substr($input, 10, 64)) !== $proof['gross']
                || substr($input, 74, 64) !== $recipient) {
                throw new \UnexpectedValueException('Native redemption calldata does not agree with its receipt');
            }
        }

        // Stored legacy decimal amounts can lose sub-microtoken precision.
        // Tolerate less than one deliverable microtoken, including a rounded
        // value just below an exact boundary. Payout still uses receipt units.
        $decimals = (int) (config('bridge.tokens', [])['CYBER.sol']['chains']['solana']['decimals'] ?? 6);
        $difference = bcsub(TokenAmount::toRaw((string) $request->amount, 18), $proof['gross'], 0);
        if (bccomp($difference, '0', 0) < 0) {
            $difference = bcsub('0', $difference, 0);
        }
        if (bccomp($difference, bcpow('10', (string) (18 - $decimals), 0), 0) >= 0) {
            throw new \UnexpectedValueException('Claimed amount does not match the native redemption gross amount');
        }

        return $proof;
    }

    /**
     * Verify native Token-2022 deposits by actual account deltas. Index by
     * account, then sum by owner: a second account must not overwrite a first.
     */
    private function verifyNativeSolanaDeposit(BridgeRequest $request): ?string
    {
        $hash = (string) $request->source_tx_hash;
        $sender = (string) $request->sender_address;
        $recipient = $this->solanaHotWallet();
        $token = config('bridge.tokens', [])['CYBER.sol']['chains']['solana'] ?? [];
        $mint = (string) ($token['mint'] ?? '');
        $decimals = (int) ($token['decimals'] ?? 6);

        if ($hash === '' || $sender === '' || $recipient === '' || $mint === '' || $sender === $recipient) {
            throw new \UnexpectedValueException('Native Solana source details are missing or invalid');
        }

        $result = $this->nativeSourceRpc($this->solanaRpc(), 'getTransaction', [
            $hash, ['encoding' => 'jsonParsed', 'commitment' => 'confirmed', 'maxSupportedTransactionVersion' => 0],
        ]);

        if ($result === null) {
            return null;
        }

        $keys = $result['transaction']['message']['accountKeys'] ?? [];
        $signer = collect($keys)->contains(fn ($key) => is_array($key)
            && ($key['pubkey'] ?? null) === $sender && ($key['signer'] ?? false) === true);

        if (! array_key_exists('err', $result['meta'] ?? [])
            || ! isset($result['transaction']['signatures'], $result['transaction']['message']['accountKeys'], $result['meta']['preTokenBalances'], $result['meta']['postTokenBalances'])) {
            return null;
        }

        if ($result['meta']['err'] !== null
            || ! in_array($hash, $result['transaction']['signatures'] ?? [], true) || ! $signer) {
            throw new \UnexpectedValueException('Native Solana deposit did not succeed for the claimed sender');
        }

        $accounts = [];
        foreach (['pre' => 'preTokenBalances', 'post' => 'postTokenBalances'] as $side => $field) {
            foreach ($result['meta'][$field] ?? [] as $balance) {
                if (($balance['mint'] ?? null) !== $mint) {
                    continue;
                }

                $index = $balance['accountIndex'] ?? null;
                $owner = $balance['owner'] ?? null;
                $raw = $balance['uiTokenAmount']['amount'] ?? null;

                if ($owner === null || $raw === null) {
                    return null;
                }

                if (! is_int($index) || $index < 0 || ! is_string($owner)
                    || ! is_string($raw) || ! ctype_digit($raw)
                    || ($balance['uiTokenAmount']['decimals'] ?? null) !== $decimals
                    || (isset($balance['programId']) && $balance['programId'] !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
                    || isset($accounts[$index][$side])
                    || (isset($accounts[$index]['owner']) && $accounts[$index]['owner'] !== $owner)) {
                    throw new \UnexpectedValueException('Native Solana token balance proof is invalid');
                }

                $accounts[$index]['owner'] = $owner;
                $accounts[$index][$side] = $raw;
            }
        }

        $credit = '0';
        $debit = '0';
        foreach ($accounts as $account) {
            $delta = bcsub($account['post'] ?? '0', $account['pre'] ?? '0', 0);
            if ($account['owner'] === $recipient) {
                $credit = bcadd($credit, $delta, 0);
            } elseif ($account['owner'] === $sender) {
                $debit = bcsub($debit, $delta, 0);
            }
        }

        if (bccomp($credit, '0', 0) <= 0 || bccomp($debit, $credit, 0) !== 0) {
            throw new \UnexpectedValueException('Native Solana deposit has no matching sender debit and hot-wallet credit');
        }

        return $credit;
    }

    private function awaitNativeSourceProof(BridgeRequest $request): void
    {
        $request->update([
            'status' => BridgeRequest::PENDING,
            'error_message' => 'Source transaction could not be read yet — retrying verification before any payout',
        ]);
    }

    /**
     * Process Solana->EVM: verify deposit, then call relay script to mint CYBER.sol on EVM.
     */
    public function processSolToEvm(BridgeRequest $request): bool
    {
        if (! in_array($request->status, BridgeRequest::PROCESSABLE, true)
            && $request->status !== BridgeRequest::PROCESSING) {
            return false;
        }

        // CyberBridge mints on release, so this destination has no inventory
        // ceiling — but it still must never pay twice.
        if ($request->hasPayout()) {
            Log::warning('Bridge: sol_to_evm already has a payout hash, not re-releasing', [
                'id' => $request->id,
                'tx' => $request->destination_tx_hash,
            ]);
            $request->markCompleted((string) $request->destination_tx_hash);

            return true;
        }

        $request->markProcessing();
        $captured = '';

        try {
            // Verify the Solana transaction is a real deposit to our hot wallet
            $verifiedAmount = $this->verifyNativeSolanaDeposit($request);

            if ($verifiedAmount === null) {
                $this->awaitNativeSourceProof($request);

                return false;
            }

            Log::info('Bridge: Solana deposit verified', [
                'id' => $request->id,
                'verified_amount_raw' => $verifiedAmount,
                'claimed_amount' => $request->amount,
            ]);

            $solanaDecimals = (int) (config('bridge.tokens', [])['CYBER.sol']['chains']['solana']['decimals'] ?? 6);
            $verifiedHuman = TokenAmount::fromRaw($verifiedAmount, $solanaDecimals);
            $amountWei = TokenAmount::toRaw($verifiedHuman, 18);
            $request->update(['amount' => $verifiedHuman, 'fee_amount' => '0']);
            $request->markSourceVerified();
            app(BridgeAdmissionService::class)->commit($request, null)?->update([
                'amount' => $verifiedHuman, 'net_raw' => $amountWei,
            ]);

            // Optional native-CYBER gas drop for empty recipients.
            $gasDropWei = '0';
            if ($request->gas_drop_planned && $request->gas_drop_amount) {
                $gasDropWei = TokenAmount::toRaw((string) $request->gas_drop_amount, 18);
            }

            Log::info('Bridge: sol_to_evm verified payout', [
                'id' => $request->id,
                'verified_amount_raw' => $verifiedAmount,
                'payout_wei' => $amountWei,
                'gas_drop_wei' => $gasDropWei,
                'convert_to_native' => $request->convert_to_native,
            ]);

            $hardhatDir = Environment::isProduction()
                ? '/singularity/crypto/hardhat'
                : base_path('/../../crypto/hardhat');

            $result = Process::path($hardhatDir)
                ->env([
                    'CYBERIA_RPC_URL' => Environment::isProduction()
                        ? 'http://polygon-edge:8545'
                        : 'https://rpc.cyberia.church',
                    'BRIDGE_EVM_CONTRACT_ADDRESS' => config('services.bridge.evm_bridge_address'),
                    'BRIDGE_RELAYER_PRIVATE_KEY' => app(BridgeRelayerService::class)->privateKey() ?? '',
                    'CYBERSOL_BURN_SWAP_ADDRESS' => (string) config('bridge.convert.burn_swap_address'),
                    'CYBER_SOL_TOKEN_ADDRESS' => (string) (config('bridge.tokens', [])['CYBER.sol']['chains']['cyberia']['address'] ?? ''),
                ])
                ->timeout($this->relayScriptTimeout())
                ->run([
                    'npx', 'tsx', 'scripts/relay-bridge.ts',
                    'sol_to_evm',
                    $request->recipient_address,
                    $amountWei,
                    (string) $request->id,
                    $gasDropWei,
                    $request->convert_to_native ? '1' : '0',
                ], function (string $type, string $buffer) use (&$captured, $request) {
                    $captured .= $buffer;
                    $this->recordBroadcast($request, $this->extractRelayTxHash($captured, firstBroadcast: true));
                });

            Log::info('Bridge relay sol_to_evm', [
                'id' => $request->id,
                'stdout' => $result->output(),
                'stderr' => $result->errorOutput(),
                'exit' => $result->exitCode(),
            ]);

            $this->recordBroadcast($request, $this->extractRelayTxHash($result->output(), firstBroadcast: true));

            if ($result->exitCode() !== 0) {
                if (! $request->hasPayout()) {
                    $this->failRelay($request, 'Relay failed: '.$result->errorOutput());
                }

                return false;
            }

            $lines = array_filter(explode("\n", trim($result->output())));
            $json = json_decode(end($lines), true);

            if ($json && isset($json['txHash'])) {
                // Record the conversion outcome: the relayer falls back to a
                // plain CYBER.sol delivery when the burn-swap lacks liquidity.
                if ($request->convert_to_native) {
                    $request->update(['converted' => (bool) ($json['converted'] ?? false)]);
                }

                $this->recordBroadcast($request, (string) $json['txHash']);
                $request->markCompleted((string) $json['txHash']);

                return true;
            }

            if (! $request->hasPayout()) {
                $this->failRelay($request, 'Could not parse relay output');
            }

            return false;
        } catch (\Exception $e) {
            if (! $request->hasPayout()) {
                $this->failRelay($request, $e->getMessage());
            }

            Log::error('Bridge: SolToEvm failed', ['id' => $request->id, 'error' => $e->getMessage()]);

            return false;
        }
    }

    /**
     * Process EVM->Solana: send CYBER SPL tokens from hot wallet to recipient.
     *
     * The destructive half of this corridor is not ours: `redeemCyberSol()`
     * burns the user's CYBER.sol inside their own transaction, before this
     * server hears about it. So the reservation in the official UI is the only
     * thing standing between a user and a burn with no payout behind it — and
     * when one arrives anyway (someone calling the contract directly), the
     * request parks in `awaiting_liquidity` with the obligation on the books
     * instead of failing quietly.
     *
     * Closing that last gap absolutely is a CONTRACT change, not a server one:
     * `redeemCyberSol` would have to take a signed reservation — relayer
     * signature over (sender, amount, recipient, nonce, expiry), replayed
     * nonces rejected on chain — or the corridor would have to become an
     * escrow that locks rather than burns, releasing only on the relayer's
     * confirmation. Both need a deployed contract and a migration of the live
     * supply, so neither is done here.
     */
    public function processEvmToSol(BridgeRequest $request): bool
    {
        if (! in_array($request->status, BridgeRequest::PROCESSABLE, true)
            && $request->status !== BridgeRequest::PROCESSING) {
            return false;
        }

        if ($request->hasPayout()) {
            Log::warning('Bridge: evm_to_sol already has a payout signature, not re-sending', [
                'id' => $request->id,
                'tx' => $request->destination_tx_hash,
            ]);
            $request->markCompleted((string) $request->destination_tx_hash);

            return true;
        }

        $request->markProcessing();
        $captured = '';

        try {
            $proof = $this->verifyNativeEvmRedemption($request);

            if ($proof === null) {
                $this->awaitNativeSourceProof($request);

                return false;
            }

            // Convert amount to Solana smallest units (CYBER.sol mint decimals).
            $solanaDecimals = (int) (config('bridge.tokens', [])['CYBER.sol']['chains']['solana']['decimals'] ?? 6);
            $amountRaw = TokenAmount::toRaw(TokenAmount::fromRaw($proof['net'], 18), $solanaDecimals);

            $request->update([
                'amount' => TokenAmount::fromRaw($proof['gross'], 18),
                'fee_amount' => TokenAmount::fromRaw(bcsub($proof['gross'], $proof['net'], 0), 18),
            ]);
            $request->markSourceVerified();
            app(BridgeAdmissionService::class)->commit($request, null)?->update([
                'amount' => TokenAmount::fromRaw($proof['gross'], 18), 'net_raw' => $amountRaw,
            ]);

            if (bccomp($amountRaw, '0', 0) <= 0) {
                $request->markAwaitingLiquidity('Verified redemption is below the Solana payout precision — manual reconciliation is required');

                return false;
            }

            Log::info('Bridge: evm_to_sol verified payout', [
                'id' => $request->id, 'gross_wei' => $proof['gross'], 'net_wei' => $proof['net'],
                'payout_raw' => $amountRaw,
            ]);

            $admission = app(BridgeAdmissionService::class);
            $pool = app(BridgeInventoryService::class)->poolKey($request->direction, $request->token);
            $lock = $pool === null ? null : $admission->poolLock($pool);

            try {
                $lock?->block((int) config('bridge.inventory.pool_lock_wait_seconds', 5));
            } catch (LockTimeoutException) {
                $request->markAwaitingLiquidity('Another payout is using the destination reserve — retrying shortly');

                return false;
            }

            try {
                $capacity = $admission->capacityForPayout($request);

                if (! $capacity->covers($amountRaw)) {
                    $request->markAwaitingLiquidity(
                        $this->liquidityReason($capacity, $amountRaw, $solanaDecimals),
                    );

                    return false;
                }

                $scriptDir = Environment::isProduction()
                    ? '/singularity/crypto/anchor'
                    : base_path('/../../crypto/anchor');

                $home = env('HOME', $_SERVER['HOME'] ?? '/home/lain');

                $walletPath = Environment::isProduction()
                    ? '/solana/id.json'
                    : $home.'/.config/solana/id.json';

                $result = Process::path($scriptDir)
                    ->env([
                        'ANCHOR_PROVIDER_URL' => $this->solanaRpc(),
                        'ANCHOR_WALLET' => $walletPath,
                    ])
                    ->timeout((int) config('bridge.relay.solana_timeout_seconds', 120))
                    ->run([
                        'npx', 'ts-node', '--transpile-only', 'scripts/relay-release-native.ts',
                        $request->recipient_address,
                        $amountRaw,
                    ], function (string $type, string $buffer) use (&$captured, $request) {
                        $captured .= $buffer;
                        $this->recordBroadcast($request, $this->extractRelayTxHash($captured));
                    });

                Log::info('Bridge relay evm_to_sol', [
                    'id' => $request->id,
                    'stdout' => $result->output(),
                    'stderr' => $result->errorOutput(),
                    'exit' => $result->exitCode(),
                ]);

                $this->recordBroadcast($request, $this->extractRelayTxHash($result->output()));

                if ($result->exitCode() !== 0) {
                    if (! $request->hasPayout()) {
                        $request->markFailed('Solana relay failed: '.$result->errorOutput());
                    }

                    return false;
                }

                $lines = array_filter(explode("\n", trim($result->output())));
                $json = json_decode(end($lines), true);

                if ($json && isset($json['txHash'])) {
                    $this->recordBroadcast($request, (string) $json['txHash']);
                    $request->markCompleted((string) $json['txHash']);

                    return true;
                }

                if (! $request->hasPayout()) {
                    $request->markFailed('Could not parse Solana relay output');
                }

                return false;
            } finally {
                $lock?->release();
            }
        } catch (\UnexpectedValueException $e) {
            $this->failRelay($request, $e->getMessage());

            return false;
        } catch (\Exception $e) {
            if (! $request->hasPayout()) {
                $request->markFailed($e->getMessage());
            }

            Log::error('Bridge: EvmToSol failed', ['id' => $request->id, 'error' => $e->getMessage()]);

            return false;
        }
    }
}
