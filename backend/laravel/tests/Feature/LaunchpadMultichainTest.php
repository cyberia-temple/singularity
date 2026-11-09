<?php

use App\Actions\Wallet\RecoverEvmAddress;
use App\Models\LaunchpadToken;
use Illuminate\Support\Facades\Storage;

const MULTICHAIN_TOKEN = '0x3333333333333333333333333333333333333333';
const MULTICHAIN_CREATOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MULTICHAIN_SIGNATURE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(function () {
    Storage::fake('public');
    $this->mock(RecoverEvmAddress::class)
        ->shouldReceive('handle')
        ->andReturn(MULTICHAIN_CREATOR);
});

/** Message format signed by the multichain launcher. */
function launchpadMessage(?int $chainId = null): string
{
    $chain = $chainId === null ? '' : ' on chain '.$chainId;

    return 'Edit Cyberia Launchpad metadata for '.MULTICHAIN_TOKEN.$chain.' at '.now()->toIso8601String();
}

it('keeps one metadata row per chain for the same token address', function () {
    // Cyberia, Robinhood and Cyberia 2.0 (Fuji), whose launches the wallet signs too.
    foreach ([49406, 4663, 49407] as $chainId) {
        $this->post('/api/launchpad/tokens', [
            'address' => MULTICHAIN_TOKEN,
            'chain_id' => $chainId,
            'message' => launchpadMessage($chainId),
            'signature' => MULTICHAIN_SIGNATURE,
            'name' => 'Lain',
            'symbol' => 'LAIN',
        ], ['Accept' => 'application/json'])
            ->assertOk()
            ->assertJsonPath('token.chain_id', $chainId);
    }

    expect(LaunchpadToken::where('address', MULTICHAIN_TOKEN)->count())->toBe(3);

    $this->getJson('/api/launchpad/tokens')
        ->assertOk()
        ->assertJsonCount(3, 'tokens');
});

it('files metadata from single-chain clients under Cyberia', function () {
    $this->post('/api/launchpad/tokens', [
        'address' => MULTICHAIN_TOKEN,
        'message' => launchpadMessage(),
        'signature' => MULTICHAIN_SIGNATURE,
        'name' => 'Lain',
    ], ['Accept' => 'application/json'])
        ->assertOk()
        ->assertJsonPath('token.chain_id', 49406);
});

it('rejects a chain the launchpad does not support', function () {
    $this->post('/api/launchpad/tokens', [
        'address' => MULTICHAIN_TOKEN,
        'chain_id' => 999999,
        'message' => launchpadMessage(999999),
        'signature' => MULTICHAIN_SIGNATURE,
    ], ['Accept' => 'application/json'])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('chain_id');
});

it('rejects a signed message that is not bound to the posted chain', function () {
    $this->post('/api/launchpad/tokens', [
        'address' => MULTICHAIN_TOKEN,
        'chain_id' => 4663,
        // Signed for Cyberia, replayed onto the satellite chain row.
        'message' => launchpadMessage(49406),
        'signature' => MULTICHAIN_SIGNATURE,
    ], ['Accept' => 'application/json'])
        ->assertStatus(422);

    expect(LaunchpadToken::where('chain_id', 4663)->count())->toBe(0);
});

it('scopes creator ownership to a single chain', function () {
    LaunchpadToken::create([
        'chain_id' => 49406,
        'address' => MULTICHAIN_TOKEN,
        'creator' => '0xcccccccccccccccccccccccccccccccccccccccc',
    ]);

    // Cyberia belongs to somebody else...
    $this->post('/api/launchpad/tokens', [
        'address' => MULTICHAIN_TOKEN,
        'chain_id' => 49406,
        'message' => launchpadMessage(49406),
        'signature' => MULTICHAIN_SIGNATURE,
    ], ['Accept' => 'application/json'])->assertForbidden();

    // ...while the same address on another chain is a different contract.
    $this->post('/api/launchpad/tokens', [
        'address' => MULTICHAIN_TOKEN,
        'chain_id' => 4663,
        'message' => launchpadMessage(4663),
        'signature' => MULTICHAIN_SIGNATURE,
        'name' => 'Lain',
    ], ['Accept' => 'application/json'])
        ->assertOk()
        ->assertJsonPath('token.creator', MULTICHAIN_CREATOR);
});
