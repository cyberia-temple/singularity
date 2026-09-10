<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * The wallet's way onto chains Cyberia has no liquidity on.
 *
 * A swap in this wallet trades against Cyberia's own pools. "I hold USDC on
 * Base and want SOL" is a different question, and this chain cannot answer it:
 * answering it means holding inventory on both sides, on every pair somebody
 * might name. So the wallet asks a router that already does, and this class is
 * the whole of the relationship.
 *
 * What it adds to a browser talking to that router directly is exactly two
 * things, and they are the reason it exists:
 *
 *  - **The fee is composed here.** Cyberia's cut is a field in the quote
 *    request. A browser that assembled that request could delete the field,
 *    and every wallet that ever shipped a fee in its bundle has had it
 *    deleted. So the browser sends what it wants to trade; the address and the
 *    size of the fee are added on this side and are not accepted from it.
 *  - **The shape is pinned.** Only the fields this app understands travel in
 *    either direction — a step the wallet is asked to sign carries a `to`,
 *    `data`, `value` and a gas price, and nothing else reaches the signer.
 *
 * What it deliberately is not: a custodian. No key lives here, nothing is
 * signed here, and the deposit goes from the user's own address to the
 * router's contract in the user's own transaction. If this host disappears
 * mid-swap the route still completes — the router has the deposit and the
 * destination address, and neither is ours.
 */
class CrosschainRouter
{
    /** The router's own name for "the coin this chain runs on". */
    public const NATIVE = '0x0000000000000000000000000000000000000000';

    /** Origin legs the wallet can actually sign. See `quote()`. */
    /**
     * The virtual machines this wallet can put a signature on.
     *
     * Not a list of what the router serves — it serves eight — but of what a
     * browser holding this vault can actually sign. EVM has been here from the
     * start; Solana joined it because the wallet already derives a keypair,
     * already builds and broadcasts transactions on it, and the router answers
     * an SVM leg with plain instructions rather than a payload only a
     * specialist wallet could read.
     *
     * Bitcoin, TON, Tron and the rest stay out until the same is true of them:
     * a leg the wallet cannot sign is a route that fails after somebody has
     * already agreed to it, which is the one failure worth refusing early.
     */
    private const SIGNABLE_VMS = ['evm', 'svm'];

    public function enabled(): bool
    {
        return (bool) config('crosschain.enabled', true)
            && $this->api() !== '';
    }

    private function api(): string
    {
        return rtrim((string) config('crosschain.api', ''), '/');
    }

    /**
     * Where Cyberia's fee lands, or null when this host collects nothing.
     *
     * Both halves have to be there. An address with no size and a size with no
     * address are the same thing — no fee — and saying so is better than
     * asking a router for 0 bps to nobody.
     */
    public function feeAddress(): ?string
    {
        $address = trim((string) config('crosschain.fee.address', ''));

        if (! preg_match('/^0x[0-9a-fA-F]{40}$/', $address) || $this->feeBps() <= 0) {
            return null;
        }

        return $address;
    }

    /**
     * Basis points this app asks for, clamped to the ceiling in config.
     *
     * Deliberately not a function of anybody's standing. XP briefly discounted
     * this, and the objection that killed it is decisive: XP is handed out for
     * opening a page and can be farmed, so it must not be allowed to decide
     * anything that moves money. What experience buys is access to parts of
     * this project, where a farmed balance takes nothing from anybody.
     */
    public function feeBps(): int
    {
        $bps = (int) config('crosschain.fee.bps', 0);
        $max = (int) config('crosschain.fee.max_bps', 300);

        return max(0, min($bps, $max));
    }

    /**
     * Every chain the router will move value between.
     *
     * Cached because it is the same answer for every visitor and changes when
     * a new chain is onboarded, which is not often. `vm` travels with each row
     * because it is the whole of the wallet's own eligibility rule: this
     * wallet can sign an EVM deposit, and the destination can be anything the
     * router delivers to.
     *
     * @return array<int, array<string, mixed>>
     */
    public function chains(): array
    {
        if (! $this->enabled()) {
            return [];
        }

        return Cache::remember(
            'crosschain.chains.v1',
            (int) config('crosschain.cache_seconds', 600),
            function (): array {
                $response = Http::timeout($this->timeout())
                    ->acceptJson()
                    ->get($this->api().'/chains');

                if (! $response->successful()) {
                    return [];
                }

                $chains = $response->json('chains');

                if (! is_array($chains)) {
                    return [];
                }

                $rows = [];

                foreach ($chains as $chain) {
                    if (! is_array($chain) || ! isset($chain['id'])) {
                        continue;
                    }

                    // A chain the router has switched off is not a corridor
                    // that is merely busy — it cannot be quoted at all, and
                    // listing it would be offering something that 400s.
                    if (($chain['disabled'] ?? false) === true) {
                        continue;
                    }

                    $currency = is_array($chain['currency'] ?? null) ? $chain['currency'] : [];

                    $rows[] = [
                        'id' => (int) $chain['id'],
                        'name' => (string) ($chain['displayName'] ?? $chain['name'] ?? $chain['id']),
                        'symbol' => (string) ($currency['symbol'] ?? ''),
                        'decimals' => (int) ($currency['decimals'] ?? 18),
                        'vm' => (string) ($chain['vmType'] ?? 'evm'),
                        'explorer' => (string) ($chain['explorerUrl'] ?? ''),
                        // "Limited" means only some tokens cross; the wallet
                        // says which rather than discovering it at quote time.
                        'tokens' => (string) ($chain['tokenSupport'] ?? 'All'),
                        'deposits' => (bool) ($chain['depositEnabled'] ?? true),
                    ];
                }

                usort($rows, fn (array $a, array $b) => strcmp($a['name'], $b['name']));

                return $rows;
            },
        );
    }

    /** @return array<string, mixed>|null */
    public function chain(int $id): ?array
    {
        foreach ($this->chains() as $chain) {
            if ($chain['id'] === $id) {
                return $chain;
            }
        }

        return null;
    }

    /**
     * Tokens on one chain, by name or symbol.
     *
     * The router's own catalogue rather than a list shipped here: a token it
     * has never heard of cannot be routed, so offering one would be offering a
     * quote that fails. `verified` is the router's flag and is passed through
     * as it came — the wallet marks unverified rows rather than hiding them,
     * because a real token nobody has verified is still the one the user owns.
     *
     * @return array<int, array<string, mixed>>
     */
    public function tokens(int $chainId, string $term = ''): array
    {
        if (! $this->enabled()) {
            return [];
        }

        $term = trim($term);
        $key = 'crosschain.tokens.v1.'.$chainId.'.'.strtolower($term);

        return Cache::remember($key, 300, function () use ($chainId, $term): array {
            $response = Http::timeout($this->timeout())
                ->acceptJson()
                ->post($this->api().'/currencies/v1', array_filter([
                    'chainIds' => [$chainId],
                    'term' => $term === '' ? null : $term,
                    'limit' => 30,
                    'verified' => $term === '',
                    'useExternalSearch' => $term !== '',
                    'depositAddressOnly' => false,
                ], fn ($value) => $value !== null));

            if (! $response->successful()) {
                return [];
            }

            $rows = [];

            // The catalogue comes back grouped — one list per match — so it is
            // flattened here rather than in three different callers.
            foreach ((array) $response->json() as $group) {
                foreach (is_array($group) ? $group : [] as $token) {
                    if (! is_array($token) || ! isset($token['address'], $token['symbol'])) {
                        continue;
                    }

                    $rows[] = [
                        'chainId' => (int) ($token['chainId'] ?? $chainId),
                        'address' => (string) $token['address'],
                        'symbol' => (string) $token['symbol'],
                        'name' => (string) ($token['name'] ?? $token['symbol']),
                        'decimals' => (int) ($token['decimals'] ?? 18),
                        'verified' => (bool) (($token['metadata']['verified'] ?? false) === true),
                        'logo' => (string) ($token['metadata']['logoURI'] ?? ''),
                    ];
                }
            }

            return $rows;
        });
    }

    /**
     * Price one route, with Cyberia's fee already in the request.
     *
     * `$request` is what the browser asked for and nothing else: the two
     * chains, the two tokens, the amount, who is spending and who receives.
     * The fee and the referrer are added here. The origin leg is refused
     * unless it is EVM, because that is the only kind of transaction this
     * wallet can sign — a Solana or Bitcoin deposit would come back as a
     * payload nothing in the browser knows how to put a signature on, and
     * finding that out after the user held a button is not a failure mode
     * worth shipping.
     *
     * The fee that comes back is read out of the router's own answer rather
     * than echoed from config. A router may cap it, round it or decline it,
     * and the only number a screen may show is the one the route will actually
     * take.
     *
     * @param  array<string, mixed>  $request
     * @return array<string, mixed>
     */
    public function quote(array $request): array
    {
        if (! $this->enabled()) {
            throw new RuntimeException('Cross-chain swaps are switched off on this host.');
        }

        $origin = $this->chain((int) $request['originChainId']);

        if ($origin === null) {
            throw new RuntimeException('This router does not serve the source network.');
        }

        if (! in_array($origin['vm'], self::SIGNABLE_VMS, true)) {
            throw new RuntimeException('The wallet cannot sign a transaction on the source network.');
        }

        if ($this->chain((int) $request['destinationChainId']) === null) {
            throw new RuntimeException('This router does not serve the destination network.');
        }

        $body = [
            'user' => $request['user'],
            'originChainId' => (int) $request['originChainId'],
            'destinationChainId' => (int) $request['destinationChainId'],
            'originCurrency' => $request['originCurrency'],
            'destinationCurrency' => $request['destinationCurrency'],
            'recipient' => $request['recipient'],
            'amount' => (string) $request['amount'],
            'tradeType' => 'EXACT_INPUT',
        ];

        /*
         * No `referrer`, and that is not an oversight.
         *
         * Relay moved referrer attribution behind an API key: a quote carrying
         * one now comes back `401 UNAUTHORIZED_QUOTE — "Please provide an api
         * key"`, and it fails the *whole* quote rather than dropping the field.
         * This host has no key, so every cross-chain quote it asked for was
         * failing — the same request without the field is answered normally.
         *
         * `appFees` is unaffected and still needs no key, which is the half
         * that matters: attribution is analytics on somebody else's dashboard,
         * the fee is the money. Putting the referrer back means adding key
         * auth, not re-adding the line.
         */

        if (isset($request['slippageBps'])) {
            $body['slippageTolerance'] = (string) (int) $request['slippageBps'];
        }

        $fee = $this->feeAddress();

        if ($fee !== null) {
            $body['appFees'] = [[
                'recipient' => $fee,
                'fee' => (string) $this->feeBps(),
            ]];
        }

        $response = Http::timeout($this->timeout())
            ->acceptJson()
            ->post($this->api().'/quote', $body);

        if (! $response->successful()) {
            throw new RuntimeException($this->reason($response->json(), $response->status()));
        }

        return $this->presentQuote((array) $response->json(), $fee !== null);
    }

    /**
     * What this app's fee has accrued to, and what can be taken out.
     *
     * The fee is collected on every routed swap, and it has never been visible
     * anywhere: it does not arrive in a wallet, and it does not arrive per
     * chain. The router holds it as **one off-chain USDC balance** against the
     * EVM address in `CROSSCHAIN_FEE_ADDRESS` — which is why that address must
     * be EVM-shaped even when the swap it was earned on happened on Solana.
     * The address is a claim ticket, not a payee.
     *
     * That design is the reason this method exists. Money that accumulates
     * somewhere nobody looks is money nobody claims, and the only thing
     * standing between "we take a fee" and "we are paid" is somebody knowing
     * there is a balance to withdraw. `crosschain:fees` asks this hourly and
     * says so in the operator channel.
     *
     * Two figures come back and they are not the same number.
     * `availableBalanceUsd` is what may be withdrawn now; `totalBalanceUsd`
     * includes fills the router has not finished settling, and reporting that
     * one as claimable would be promising money that is not there yet.
     *
     * @return array{available: float, total: float, pending: float, currencies: array<int, array<string, mixed>>}|null
     */
    public function appFeeBalance(): ?array
    {
        $address = $this->feeAddress();

        if (! $this->enabled() || $address === null) {
            return null;
        }

        $response = Http::timeout($this->timeout())
            ->acceptJson()
            ->get($this->api().'/app-fees/'.$address.'/balances');

        if (! $response->successful()) {
            throw new RuntimeException($this->reason($response->json(), $response->status()));
        }

        $body = (array) $response->json();

        return [
            'available' => (float) ($body['availableBalanceUsd'] ?? 0),
            'total' => (float) ($body['totalBalanceUsd'] ?? 0),
            'pending' => (float) ($body['outstandingFastFillBalanceUsd'] ?? 0),
            'currencies' => array_values(array_filter(
                (array) ($body['balances'] ?? []),
                'is_array',
            )),
        ];
    }

    /**
     * Where a started swap has got to.
     *
     * The deposit is on chain and the router is delivering; this is the only
     * question left, and it is asked of the router because only the router
     * knows what it has filled. `unknown` is its honest answer for a request
     * it has not seen yet, and is passed through as exactly that rather than
     * being rendered as a failure.
     *
     * @return array<string, mixed>
     */
    public function status(string $requestId): array
    {
        if (! $this->enabled()) {
            throw new RuntimeException('Cross-chain swaps are switched off on this host.');
        }

        $response = Http::timeout($this->timeout())
            ->acceptJson()
            ->get($this->api().'/intents/status', ['requestId' => $requestId]);

        if (! $response->successful()) {
            throw new RuntimeException($this->reason($response->json(), $response->status()));
        }

        $body = (array) $response->json();
        $transactions = [];

        foreach ((array) ($body['inTxHashes'] ?? []) as $hash) {
            $transactions[] = ['side' => 'in', 'hash' => (string) $hash];
        }

        foreach ((array) ($body['txHashes'] ?? []) as $hash) {
            $transactions[] = ['side' => 'out', 'hash' => (string) $hash];
        }

        return [
            'status' => (string) ($body['status'] ?? 'unknown'),
            'details' => (string) ($body['details'] ?? ''),
            'transactions' => $transactions,
        ];
    }

    /**
     * The quote, reduced to what a wallet screen needs and what a signer may
     * be handed.
     *
     * Every step item is stripped to the fields of one transaction. Anything
     * else the router sends — a `from` that is not this account, a check URL,
     * fields added next month — never reaches the code that signs.
     *
     * @param  array<string, mixed>  $quote
     * @return array<string, mixed>
     */
    private function presentQuote(array $quote, bool $feeRequested): array
    {
        $details = is_array($quote['details'] ?? null) ? $quote['details'] : [];
        $fees = is_array($quote['fees'] ?? null) ? $quote['fees'] : [];
        $steps = [];

        foreach ((array) ($quote['steps'] ?? []) as $step) {
            if (! is_array($step)) {
                continue;
            }

            $items = [];

            foreach ((array) ($step['items'] ?? []) as $item) {
                $data = is_array($item['data'] ?? null) ? $item['data'] : [];

                /*
                 * Two shapes, and the difference is the chain's, not ours.
                 *
                 * An EVM leg is one transaction — where to, what calldata, how
                 * much value. A Solana leg is a list of instructions plus the
                 * lookup tables they are compiled against, because that is what
                 * a v0 transaction is made of and the router leaves the
                 * assembling to whoever holds the key.
                 *
                 * Both are stripped to exactly the fields a signature needs.
                 * Nothing else in the router's answer reaches the browser: a
                 * step naming another chain, or carrying anything the signer
                 * does not read, is a step nobody can audit on the way past.
                 */
                if (isset($data['instructions']) && is_array($data['instructions'])) {
                    $instructions = [];

                    foreach ($data['instructions'] as $instruction) {
                        if (! is_array($instruction)) {
                            continue;
                        }

                        $keys = [];

                        foreach ((array) ($instruction['keys'] ?? []) as $key) {
                            if (! is_array($key) || ! isset($key['pubkey'])) {
                                continue;
                            }

                            $keys[] = [
                                'pubkey' => (string) $key['pubkey'],
                                'isSigner' => (bool) ($key['isSigner'] ?? false),
                                'isWritable' => (bool) ($key['isWritable'] ?? false),
                            ];
                        }

                        $instructions[] = [
                            'programId' => (string) ($instruction['programId'] ?? ''),
                            'keys' => $keys,
                            'data' => (string) ($instruction['data'] ?? ''),
                        ];
                    }

                    if ($instructions === []) {
                        continue;
                    }

                    $items[] = [
                        'vm' => 'svm',
                        'instructions' => $instructions,
                        'lookupTables' => array_values(array_map(
                            static fn ($address): string => (string) $address,
                            (array) ($data['addressLookupTableAddresses'] ?? []),
                        )),
                    ];

                    continue;
                }

                if (! isset($data['to'], $data['chainId'])) {
                    continue;
                }

                $items[] = [
                    'vm' => 'evm',
                    'chainId' => (int) $data['chainId'],
                    'to' => (string) $data['to'],
                    'data' => (string) ($data['data'] ?? '0x'),
                    'value' => (string) ($data['value'] ?? '0'),
                    'gas' => isset($data['gas']) ? (string) $data['gas'] : null,
                    'maxFeePerGas' => isset($data['maxFeePerGas']) ? (string) $data['maxFeePerGas'] : null,
                    'maxPriorityFeePerGas' => isset($data['maxPriorityFeePerGas'])
                        ? (string) $data['maxPriorityFeePerGas']
                        : null,
                ];
            }

            if ($items === []) {
                continue;
            }

            $steps[] = [
                'id' => (string) ($step['id'] ?? 'step'),
                'description' => (string) ($step['description'] ?? ''),
                'items' => $items,
            ];
        }

        $app = $this->amount($fees['app'] ?? null);

        return [
            'requestId' => (string) ($quote['requestId'] ?? ''),
            'steps' => $steps,
            'in' => $this->amount($details['currencyIn'] ?? null),
            'out' => $this->amount($details['currencyOut'] ?? null),
            'fees' => [
                // Cyberia's own, as the router priced it.
                'app' => $app,
                // What the router charges for carrying the value across.
                'relayer' => $this->amount($fees['relayer'] ?? null),
                // What the deposit transaction itself will cost the sender.
                'gas' => $this->amount($fees['gas'] ?? null),
            ],
            // Asked for and not charged is a fact about this route, and the
            // screen says it rather than showing a fee that will not be taken.
            'feeRequested' => $feeRequested,
            'feeApplied' => $app !== null && $app['amount'] !== '0',
            'impactPercent' => (string) ($details['totalImpact']['percent'] ?? ''),
            'timeEstimate' => (int) ($details['timeEstimate'] ?? 0),
            'slippageBps' => (int) ($details['slippageTolerance']['total'] ?? 0),
        ];
    }

    /**
     * One money field of the router's answer, in raw units plus what it is.
     *
     * Raw and never a float: these are token amounts, and the browser prints
     * them with the decimals that travel beside them.
     *
     * @return array<string, mixed>|null
     */
    private function amount(mixed $value): ?array
    {
        if (! is_array($value)) {
            return null;
        }

        $currency = is_array($value['currency'] ?? null) ? $value['currency'] : [];

        return [
            'chainId' => (int) ($currency['chainId'] ?? 0),
            'address' => (string) ($currency['address'] ?? ''),
            'symbol' => (string) ($currency['symbol'] ?? ''),
            'decimals' => (int) ($currency['decimals'] ?? 18),
            'amount' => (string) ($value['amount'] ?? '0'),
            'minimum' => (string) ($value['minimumAmount'] ?? $value['amount'] ?? '0'),
            'usd' => (string) ($value['amountUsd'] ?? ''),
        ];
    }

    /**
     * What went wrong, in the router's own words where it gave any.
     *
     * A router's refusal is usually the most useful sentence available — "no
     * route", "amount too small", "chain paused" — and paraphrasing it into
     * "something went wrong" is how a user is left retrying a swap that will
     * never work.
     */
    private function reason(mixed $body, int $status): string
    {
        $message = is_array($body) ? ($body['message'] ?? null) : null;

        if (is_string($message) && $message !== '') {
            return $message;
        }

        return 'The routing service answered '.$status.'.';
    }

    private function timeout(): int
    {
        return max(5, (int) config('crosschain.timeout', 20));
    }
}
