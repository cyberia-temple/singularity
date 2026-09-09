<?php

namespace App\Services;

use App\Services\Monero\MoneroWalletRpc;

/**
 * Single source of truth over config/bridge.php: route/token availability
 * rules and the public-safe subsets served to the frontend as Inertia props.
 * Adding an EVM chain is a config-only change — nothing here hardcodes chains.
 */
class BridgeConfigService
{
    public function __construct(
        private readonly BridgeRelayerService $relayerService,
        private readonly SolanaRpcProxy $solanaRpc,
    ) {}

    /**
     * @return array<string, array<string, mixed>>
     */
    public function chains(): array
    {
        return config('bridge.chains', []);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function chain(string $key): ?array
    {
        return $this->chains()[$key] ?? null;
    }

    /**
     * Chain-level kill switch ('enabled' in config/bridge.php, default on).
     * Disabled chains stay in chains()/chain() so in-flight requests can
     * still be processed, but vanish from the frontend and their routes
     * are rejected.
     */
    public function chainEnabled(string $key): bool
    {
        $chain = $this->chain($key);

        return $chain !== null && ($chain['enabled'] ?? true) !== false;
    }

    /**
     * Routes whose chains are operational: both chains exist and the source
     * chain has a deposit address (TON routes disappear while
     * BRIDGE_TON_DEPOSIT_ADDRESS is unset; evm_to_ton also requires it since
     * payouts come from the same TON hot wallet).
     *
     * @return array<string, array<string, mixed>>
     */
    public function availableRoutes(): array
    {
        $available = [];

        foreach (config('bridge.routes', []) as $direction => $route) {
            // A corridor toggled off (config/bridge.php 'enabled') is hidden
            // from the UI and rejected at submit/quote time. A coming-soon
            // corridor stays visible in the UI but is rejected here too.
            if (($route['enabled'] ?? true) === false || $this->routeComingSoon($route)) {
                continue;
            }

            $source = $this->chain($route['source_chain'] ?? '');
            $destination = $this->chain($route['destination_chain'] ?? '');

            if (! $this->routeOperational($direction, $route, $source, $destination)) {
                continue;
            }

            $available[$direction] = $route;
        }

        return $available;
    }

    /**
     * Address users deposit to on a chain: explicit deposit_address from
     * config, else the relayer EOA on EVM chains.
     */
    public function depositAddress(string $chainKey): ?string
    {
        $chain = $this->chain($chainKey);

        if (! $chain) {
            return null;
        }

        $explicit = $chain['deposit_address'] ?? null;

        if (is_string($explicit) && $explicit !== '') {
            return $explicit;
        }

        if (($chain['type'] ?? '') === 'evm') {
            return $this->relayerService->evmAddress();
        }

        return null;
    }

    /**
     * @return array<string, mixed>|null chain-specific token entry
     */
    public function tokenOnChain(string $symbol, string $chainKey): ?array
    {
        $token = config('bridge.tokens', [])[$symbol] ?? null;

        if (! is_array($token)) {
            return null;
        }

        $entry = $token['chains'][$chainKey] ?? null;

        return is_array($entry) && $this->chainEntryConfigured($entry) ? $entry : null;
    }

    /**
     * Tokens offered on a route: configured on BOTH of its chains.
     *
     * @return array<string, array<string, mixed>> keyed by symbol
     */
    public function tokensForRoute(string $direction): array
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        if (! is_array($route)) {
            return [];
        }

        $tokens = [];

        foreach (config('bridge.tokens', []) as $symbol => $token) {
            if ($this->tokenOnChain($symbol, $route['source_chain']) === null) {
                continue;
            }

            if ($this->tokenOnChain($symbol, $route['destination_chain']) === null) {
                continue;
            }

            $tokens[$symbol] = $token;
        }

        return $tokens;
    }

    /**
     * Public-safe chain list for the frontend (api keys stripped).
     *
     * @return array<int, array<string, mixed>>
     */
    public function publicChains(): array
    {
        $enabled = array_filter(
            $this->chains(),
            fn (array $chain) => ($chain['enabled'] ?? true) !== false,
        );

        return array_values(array_map(fn (array $chain) => [
            'key' => $chain['key'],
            'label' => $chain['label'],
            'type' => $chain['type'] ?? 'evm',
            'addressType' => $chain['address_type'],
            'wallet' => $chain['wallet'] ?? 'manual',
            'evmChainId' => $chain['evm_chain_id'] ?? null,
            // Browser-facing RPC: never leak an internal relayer URL (e.g.
            // http://polygon-edge:8545) to the client — prefer public_rpc_url.
            'rpcUrl' => $this->browserRpc($chain),
            'explorerTx' => $chain['explorer_tx'] ?? null,
            'explorerTxFallbacks' => $chain['explorer_tx_fallbacks'] ?? [],
            'nativeCurrency' => $chain['native_currency'] ?? null,
            'depositAddress' => $this->depositAddress($chain['key']),
        ], $enabled));
    }

    /**
     * The endpoint a browser is given for a chain.
     *
     * `public_rpc_url` when the chain names one, and for Solana our own relay:
     * the public cluster refuses any request with a browser `Origin`, and
     * `rpc_url` there is a keyed endpoint that must never reach a bundle —
     * this method is the reason the key stops at this server.
     *
     * @param  array<string, mixed>  $chain
     */
    private function browserRpc(array $chain): ?string
    {
        if (isset($chain['public_rpc_url'])) {
            return (string) $chain['public_rpc_url'];
        }

        // Solana is the one chain whose `rpc_url` is never a fallback here: it
        // carries an api key. With the relay off the browser gets nothing and
        // says so, which is better than shipping the key to everyone.
        if (($chain['type'] ?? 'evm') === 'solana') {
            return $this->solanaRpc->browserEndpoint() ?: null;
        }

        return $chain['rpc_url'] ?? null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function publicRoutes(): array
    {
        $routes = [];

        foreach ($this->visibleRoutes() as $direction => $route) {
            $source = $this->chain($route['source_chain']);
            $destination = $this->chain($route['destination_chain']);

            if (! $source || ! $destination) {
                continue;
            }

            $comingSoon = $this->routeComingSoon($route);
            $operational = ! $comingSoon
                && $this->routeOperational($direction, $route, $source, $destination);

            $routes[] = [
                'direction' => $direction,
                'source' => $route['source_chain'],
                'destination' => $route['destination_chain'],
                'sourceLabel' => $source['label'],
                'destinationLabel' => $destination['label'],
                'sourceWallet' => $source['wallet'] ?? 'manual',
                'destinationAddressType' => $destination['address_type'],
                'autoProcess' => (bool) ($route['auto_process'] ?? false),
                'operational' => $operational,
                'unavailableReason' => match (true) {
                    $operational => null,
                    $comingSoon => 'Coming soon',
                    default => 'Operator setup pending',
                },
                'tokens' => array_keys($this->tokensForRoute($direction)),
            ];
        }

        return $routes;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function publicTokens(): array
    {
        $tokens = [];

        foreach (config('bridge.tokens', []) as $symbol => $token) {
            $chains = [];

            foreach ($token['chains'] ?? [] as $chainKey => $entry) {
                if (! $this->chainEntryConfigured($entry)) {
                    continue;
                }

                $chains[$chainKey] = [
                    'address' => $entry['address'] ?? null,
                    'mint' => $entry['mint'] ?? null,
                    'master' => $entry['master'] ?? null,
                    'native' => (bool) ($entry['native'] ?? false),
                    'decimals' => (int) $entry['decimals'],
                    'tokenProgram' => $entry['token_program'] ?? null,
                ];
            }

            $tokens[] = [
                'symbol' => $symbol,
                'model' => $token['model'] ?? 'direct',
                'chains' => $chains,
            ];
        }

        return $tokens;
    }

    /**
     * A token chain entry counts as configured when its identifier is present
     * (native chains need no address; wrapper addresses may be empty until the
     * contract is deployed and the env var is set).
     *
     * @param  array<string, mixed>  $entry
     */
    private function chainEntryConfigured(array $entry): bool
    {
        if (($entry['native'] ?? false) === true) {
            return true;
        }

        foreach (['address', 'mint', 'master'] as $key) {
            if (is_string($entry[$key] ?? null) && $entry[$key] !== '') {
                return true;
            }
        }

        return false;
    }

    /**
     * Routes shown in the UI. A route may be visible but not yet operational;
     * publicRoutes() exposes that state so the frontend can show the corridor
     * without allowing a broken request. Coming-soon corridors are always
     * visible — even over a disabled chain — that's the whole point of the
     * tease.
     *
     * @return array<string, array<string, mixed>>
     */
    private function visibleRoutes(): array
    {
        return array_filter(
            config('bridge.routes', []),
            fn (array $route) => $this->routeComingSoon($route)
                || (($route['enabled'] ?? true) !== false
                    && $this->chainEnabled($route['source_chain'] ?? '')
                    && $this->chainEnabled($route['destination_chain'] ?? '')),
        );
    }

    /**
     * @param  array<string, mixed>  $route
     */
    private function routeComingSoon(array $route): bool
    {
        return ($route['coming_soon'] ?? false) === true;
    }

    /**
     * @param  array<string, mixed>  $route
     * @param  array<string, mixed>|null  $source
     * @param  array<string, mixed>|null  $destination
     */
    private function routeOperational(string $direction, array $route, ?array $source, ?array $destination): bool
    {
        if (! $source || ! $destination) {
            return false;
        }

        if (! $this->chainEnabled($source['key']) || ! $this->chainEnabled($destination['key'])) {
            return false;
        }

        // Opt-in chains with operator hot wallets (TON, Yenten, manual native
        // coins) need a configured deposit/payout address before requests are
        // accepted. EVM/Solana chains have built-in defaults.
        foreach ([$source, $destination] as $chain) {
            // Monero is the exception, and not by special pleading: its
            // addresses are not configured at all. Deposits land on
            // subaddresses the wallet mints per request and payouts are spent
            // by that same wallet, so the wallet is the requirement — checked
            // just below — and a config address would be a second answer to a
            // question the wallet has already answered.
            if (($chain['type'] ?? '') === 'monero') {
                continue;
            }

            if (in_array($chain['wallet'] ?? '', ['manual', 'ton'], true)
                && $this->depositAddress($chain['key']) === null) {
                return false;
            }
        }

        if (($destination['type'] ?? '') === 'ton'
            && ! config('services.bridge.ton_relayer_mnemonic')) {
            return false;
        }

        // A Monero corridor is a wallet or it is nothing: with none attached
        // this server can neither see a deposit nor send a payout, so the
        // route is not offered at all rather than accepting money it would
        // then have to explain. `configured()` reads config and never the
        // network — this runs on every page that draws the bridge.
        if (($source['type'] ?? '') === 'monero' || ($destination['type'] ?? '') === 'monero') {
            if (! app(MoneroWalletRpc::class)->configured()) {
                return false;
            }
        }

        if (($source['type'] ?? '') === 'yenten' || ($destination['type'] ?? '') === 'yenten') {
            $yenten = $this->chain('yenten');

            if (! is_string($yenten['relayer_wif'] ?? null)
                || $yenten['relayer_wif'] === '') {
                return false;
            }
        }

        return $this->tokensForRoute($direction) !== [];
    }
}
