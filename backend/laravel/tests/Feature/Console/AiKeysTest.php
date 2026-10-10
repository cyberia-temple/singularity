<?php

use App\Models\AiApiKey;
use App\Models\AiApiRequest;
use App\Models\CrmContact;
use App\Models\User;
use App\Services\Ai\AiKeyService;
use Illuminate\Support\Str;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $this->withoutVite();
    config()->set('crm.admin_wallets', ['0x00000000000000000000000000000000000000aa']);
    config()->set('crm.admin_user_ids', []);
});

function lainosConsoleOperator(): User
{
    return User::factory()->create([
        'wallet_address' => '0x00000000000000000000000000000000000000aa',
    ]);
}

it('shows LainOS keys and metering without exposing a secret', function () {
    // Keep "a minute ago" inside today even when CI starts this test at
    // midnight UTC.
    $this->travelTo(now()->startOfDay()->addHours(12));

    $address = '0x00000000000000000000000000000000000000bb';
    $instanceId = (string) Str::uuid();
    $owner = User::factory()->create([
        'name' => 'Alice Lain',
        'wallet_address' => $address,
    ]);
    $contact = CrmContact::factory()->create([
        'name' => 'Alice dossier',
        'user_id' => $owner->id,
        'evm_address' => $address,
    ]);

    ['key' => $key] = app(AiKeyService::class)->issue(
        $address,
        'bedroom node',
        client: AiApiKey::CLIENT_LAINOS,
        instanceId: $instanceId,
    );
    app(AiKeyService::class)->issue(
        '0x00000000000000000000000000000000000000cc',
        'ordinary client',
    );
    $key->forceFill(['last_used_at' => now()->subMinutes(7)])->save();

    AiApiRequest::create([
        'ai_api_key_id' => $key->id,
        'model' => 'lain-free',
        'served_model' => 'lain-free',
        'provider' => 'openrouter',
        'prompt_tokens' => 11,
        'completion_tokens' => 7,
        'status' => 200,
        'streamed' => false,
        'created_at' => now()->subMinute(),
    ]);
    AiApiRequest::create([
        'ai_api_key_id' => $key->id,
        'model' => 'lain-free',
        'served_model' => 'lain-free',
        'provider' => 'openrouter',
        'prompt_tokens' => 3,
        'completion_tokens' => 2,
        'status' => 200,
        'streamed' => false,
        'created_at' => now()->subDays(2),
    ]);

    $this->actingAs(lainosConsoleOperator())
        ->get('/crm/api-keys')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/AiKeys')
            ->where('summary.total', 1)
            ->where('summary.active', 1)
            ->where('summary.used_today', 1)
            ->where('summary.requests_today', 1)
            ->where('summary.tokens_today', 18)
            ->has('keys', 1)
            ->where('keys.0.instance_id', $instanceId)
            ->where('keys.0.owner.name', 'Alice Lain')
            ->where('keys.0.contact.id', $contact->id)
            ->where('keys.0.status', 'active')
            ->where('keys.0.usage.today.requests', 1)
            ->where('keys.0.usage.today.tokens', 18)
            ->where('keys.0.usage.lifetime.requests', 2)
            ->where('keys.0.usage.lifetime.tokens', 23)
            ->missing('keys.0.token_hash')
        );
});

it('keeps the LainOS key table inside the hidden operator console', function () {
    $this->get('/crm/api-keys')->assertRedirect();
    $this->actingAs(User::factory()->create())->get('/crm/api-keys')->assertNotFound();
});

it('issues a free LainOS key once from the operator console', function () {
    $address = '0x00000000000000000000000000000000000000bb';

    $response = $this->actingAs(lainosConsoleOperator())
        ->postJson('/crm/api-keys', [
            'address' => $address,
            'name' => 'Alice bedroom node',
        ])
        ->assertCreated()
        ->assertJsonPath('key.address', $address)
        ->assertJsonPath('key.name', 'Alice bedroom node')
        ->assertJsonMissingPath('key.token_hash');

    $token = $response->json('token');
    $key = AiApiKey::query()->sole();

    expect($token)
        ->toStartWith(AiKeyService::PREFIX)
        ->and($key->client)->toBe(AiApiKey::CLIENT_LAINOS)
        ->and($key->gate_exempt)->toBeTrue()
        ->and(Str::isUuid($key->instance_id))->toBeTrue()
        ->and($key->token_hash)->toBe(hash('sha256', $token))
        ->and($key->token_hash)->not->toBe($token);
});

it('validates and protects LainOS key issuance', function () {
    $this->actingAs(lainosConsoleOperator())
        ->postJson('/crm/api-keys', ['address' => 'not-an-address'])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('address');

    $this->actingAs(User::factory()->create())
        ->postJson('/crm/api-keys', [
            'address' => '0x00000000000000000000000000000000000000bb',
        ])
        ->assertNotFound();
});
