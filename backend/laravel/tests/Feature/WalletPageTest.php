<?php

use App\Models\User;
use Inertia\Testing\AssertableInertia;

const XMR_PAYOUT_ADDRESS = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

beforeEach(function () {
    $this->withoutVite();
});

/**
 * The wallet is the home screen of the desktop and mobile shells, so it has to
 * open for someone who has never had a Cyberia account: the keys are generated
 * and stored in the browser, and gating them behind a server that never sees
 * them would be theatre. Signing in adds exactly one thing — the XMR payout
 * binding.
 */
it('opens without an account, because the keys were never ours to gate', function () {
    $this->get('/wallet')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Wallet')
            ->where('moneroPayoutAddress', null)
        );
});

/**
 * The endpoint handed over is this app's own relay, not Solana's public
 * cluster: the cluster answers `403 Access forbidden` to any request carrying
 * a browser `Origin`, so the address that used to be here read the chain from
 * curl and from nowhere else.
 */
it('hands the wallet page the Solana relay and the saved payout address', function () {
    $user = User::factory()->create(['monero_wallet_address' => XMR_PAYOUT_ADDRESS]);

    $this->actingAs($user)
        ->get('/wallet')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Wallet')
            ->where('solanaRpcUrl', url('/api/solana/rpc'))
            ->where('moneroPayoutAddress', XMR_PAYOUT_ADDRESS)
        );
});

it('falls back to the configured endpoint when the relay is switched off', function () {
    config([
        'solana.rpc.enabled' => false,
        'services.staking.public_rpc_url' => 'https://api.mainnet-beta.solana.com',
    ]);

    $this->get('/wallet')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->where('solanaRpcUrl', 'https://api.mainnet-beta.solana.com')
        );
});

it('never sends key material to the browser', function () {
    $user = User::factory()->create();

    $this->actingAs($user)
        ->get('/wallet')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Wallet')
            ->where('moneroPayoutAddress', null)
            // The wallet is derived in the browser: no seed, phrase or private
            // key may ever appear in the page props.
            ->missing('seed')
            ->missing('mnemonic')
            ->missing('privateKey')
        );
});

it('hands the wallet only public Arena coordinates and exposes its deep link', function () {
    config(['arena.contract_address' => '0x1111111111111111111111111111111111111111']);

    $this->get('/arena')->assertRedirect('/wallet?screen=arena');
    $this->get('/wallet')->assertInertia(fn (AssertableInertia $page) => $page
        ->where('arena.enabled', true)
        ->where('arena.contractAddress', '0x1111111111111111111111111111111111111111')
        ->where('arena.rpcUrl', 'https://rpc.cyberia.church')
        ->missing('arena.privateKey')
    );
});

/**
 * The wallet's own bridge screen is rendered from the same tables /bridge is,
 * so a corridor opened in config opens in both places at once rather than in
 * one and then, later, in the other.
 *
 * A deposit address is public by necessity — it has to be paid — but a
 * *private* key never is, and the relayer's is the one that would be worth
 * something to an attacker. The prop carries the address only.
 */
it('hands the wallet the bridge corridors it may start', function () {
    $this->get('/wallet')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Wallet')
            ->has('bridge.chains')
            ->has('bridge.routes')
            ->has('bridge.tokens')
            ->has('bridge.relayer')
            ->has('bridge.feeBps')
        );
});

it('never sends a relayer key with the bridge corridors', function () {
    $response = $this->get('/wallet')->assertOk();

    $props = $response->viewData('page')['props']['bridge'];

    expect($props)->not->toHaveKey('relayerPrivateKey');
    expect(json_encode($props))->not->toContain('private_key');

    // Every corridor names its source and destination, because the screen
    // refuses the ones whose lock leg the wallet cannot build and has to say
    // which ones those are.
    foreach ($props['routes'] as $route) {
        expect($route)->toHaveKeys(['direction', 'source', 'destination', 'operational']);
    }
});
