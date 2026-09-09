<?php

use App\Models\CrmContact;
use App\Models\CrmContactLink;
use App\Models\CrmSync;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

test('guests cannot reach the crm', function () {
    $this->get(route('crm.index'))->assertRedirect(route('login'));
});

test('authenticated users outside the allow list get a 404 everywhere in the crm', function () {
    $stranger = User::factory()->create(['wallet_address' => '0x'.str_repeat('e', 40)]);
    $contact = CrmContact::factory()->create();

    $this->actingAs($stranger)->get(route('crm.index'))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.people'))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.show', $contact))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.numbers'))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.machines'))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.export'))->assertNotFound();
    $this->actingAs($stranger)->post(route('crm.sync'))->assertNotFound();
    $this->actingAs($stranger)->delete(route('crm.destroy', $contact))->assertNotFound();

    $this->assertDatabaseHas('crm_contacts', ['id' => $contact->id]);
});

test('a user with no wallet attached cannot reach the crm', function () {
    $user = User::factory()->create(['wallet_address' => null]);

    $this->actingAs($user)->get(route('crm.index'))->assertNotFound();
});

test('the allow list matches wallets regardless of case', function () {
    $user = User::factory()->create([
        'wallet_address' => '0xAFF26832DB3557DAF540B0B09DEE06C24B8A38BB',
    ]);

    $this->actingAs($user)->get(route('crm.index'))->assertOk();
});

test('both operator wallets are allowed', function () {
    foreach (config('crm.admin_wallets') as $wallet) {
        $user = User::factory()->create(['wallet_address' => $wallet]);

        $this->actingAs($user)->get(route('crm.index'))->assertOk();
    }

    expect(config('crm.admin_wallets'))->toBe([
        '0xaff26832db3557daf540b0b09dee06c24b8a38bb',
        '0x6f4afc4f18bd72a92d1c0087ea5fb79754652405',
    ]);
});

test('the people lens lists every segment with its count', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Alice']);
    CrmContact::factory()->whale()->create(['name' => 'Bob']);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/People')
            ->where('segment', 'all')
            ->where('total', 2)
            ->has('rows', 2)
            // A segment is a saved question, so the whole list travels with
            // its counts — an operator picks a question, not a filter.
            ->has('segments', 13)
            ->where('segments.0.key', 'all')
            ->where('segments.0.count', 2)
            ->where('segments.4.key', 'partners')
            ->where('segments.4.count', 0)
            ->where('segments.5.key', 'whales')
            ->where('segments.5.count', 1)
        );
});

test('a segment narrows the rows to the people its rule names', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Alice']);
    CrmContact::factory()->whale()->create(['name' => 'Bob']);

    $this->actingAs($user)
        ->get(route('crm.people', ['segment' => 'whales']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('segment', 'whales')
            ->has('rows', 1)
            ->where('rows.0.name', 'Bob')
        );

    // An unknown segment is the whole base rather than an error: a stale
    // bookmark should open the lens, not a 404.
    $this->actingAs($user)
        ->get(route('crm.people', ['segment' => 'nonsense']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->where('segment', 'all'));
});

test('every row carries the freshest thing that happened to that person', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['name' => 'Alice']);
    $contact->notes()->create([
        'user_id' => $user->id,
        'type' => 'note',
        'body' => 'Asked about bridge limits',
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('rows.0.signal.key', 'signal.note')
            ->where('rows.0.signal.params.body', 'Asked about bridge limits')
        );
});

test('the search narrows the rows inside a segment', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Alice', 'email' => 'alice@example.com']);
    CrmContact::factory()->create(['name' => 'Bob', 'email' => 'bob@example.com']);

    $this->actingAs($user)
        ->get(route('crm.people', ['q' => 'alice']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->has('rows', 1)->where('total', 1));
});

test('the lens says how old the base is, and when it has never been loaded', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        // No date is a state of its own: an empty one would read as "just now".
        ->assertInertia(fn (Assert $page) => $page->where('sync', null));

    CrmSync::create([
        'trigger' => 'operator',
        'started_at' => now()->subMinutes(3),
        'finished_at' => now()->subMinutes(2),
        'counts' => ['platform' => 4],
        'added' => 6,
        'sold' => 2,
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('sync.added', 6)
            ->where('sync.sold', 2)
            ->where('sync.partial', false)
            ->where('sync.running', false)
        );
});

test('a run that could not read every source is reported as partial', function () {
    $user = User::factory()->crmAdmin()->create();

    CrmSync::create([
        'trigger' => 'schedule',
        'started_at' => now()->subMinutes(3),
        'finished_at' => now()->subMinutes(2),
        'note' => CrmSync::NOTE_HOLDERS_UNREADABLE,
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->where('sync.partial', true));
});

test('somebody who sold is still in the base, under their own segment', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Sold out', 'status' => 'sold', 'type' => 'lead']);
    CrmContact::factory()->create(['name' => 'Still here']);

    $this->actingAs($user)
        ->get(route('crm.people', ['segment' => 'sold']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->has('rows', 1)
            ->where('rows.0.name', 'Sold out')
        );
});

test('a contact can be created', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->post(route('crm.store'), [
            'name' => 'Carol',
            'email' => 'carol@example.com',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertRedirect();

    $this->assertDatabaseHas('crm_contacts', [
        'name' => 'Carol',
        'source' => 'manual',
    ]);
});

test('a contact can be created from any safe contact link', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->post(route('crm.store'), [
            'contact_link_url' => 'discord.gg/cyberia',
            'contact_link_label' => 'Cyberia Discord',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertRedirect();

    $contact = CrmContact::query()->sole();

    $this->assertDatabaseHas('crm_contact_links', [
        'crm_contact_id' => $contact->id,
        'label' => 'Cyberia Discord',
        'kind' => 'discord',
        'url' => 'https://discord.gg/cyberia',
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertInertia(fn (Assert $page) => $page
            ->where('rows.0.name', 'Cyberia Discord')
            ->where('rows.0.write_ways.0.kind', 'discord')
            ->where('rows.0.write_ways.0.url', 'https://discord.gg/cyberia'));
});

test('unsafe contact links are refused', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->post(route('crm.store'), [
            'contact_link_url' => 'javascript:alert(1)',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertSessionHasErrors('contact_link_url');

    expect(CrmContact::count())->toBe(0);
});

test('contact links can be added to and removed from a dossier', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create([
        'telegram' => null,
        'x_handle' => null,
        'email' => null,
    ]);

    $this->actingAs($user)
        ->post(route('crm.contact-links.store', $contact), [
            'url' => 'https://github.com/cyberia-temple',
        ])
        ->assertRedirect();

    $link = CrmContactLink::query()->sole();
    expect($link->kind)->toBe('github');

    $this->actingAs($user)
        ->get(route('crm.show', $contact))
        ->assertInertia(fn (Assert $page) => $page
            ->where('contact.contact_links.0.id', $link->id)
            ->where('contact.write_ways.0.kind', 'github'));

    $this->actingAs($user)
        ->delete(route('crm.contact-links.destroy', [$contact, $link]))
        ->assertRedirect();

    $this->assertDatabaseMissing('crm_contact_links', ['id' => $link->id]);
});

test('a pasted profile link is stored as a bare handle', function () {
    $user = User::factory()->crmAdmin()->create();

    // Nobody transcribes a handle out of a profile they are looking at; they
    // copy the address bar. Three spellings of one handle in a column is a
    // link that works two times in three.
    $this->actingAs($user)
        ->post(route('crm.store'), [
            'name' => 'Carol',
            'telegram' => 'https://t.me/carol_here',
            'x_handle' => 'https://x.com/carol?s=20',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertRedirect();

    $this->assertDatabaseHas('crm_contacts', [
        'name' => 'Carol',
        'telegram' => 'carol_here',
        'x_handle' => 'carol',
    ]);
});

test('a person already on the books is not added twice', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['x_handle' => 'fomo_person']);

    // The whole point of the composer is entering people in handfuls, which
    // is exactly when the same account gets typed twice.
    $this->actingAs($user)
        ->post(route('crm.store'), [
            'name' => 'Same person again',
            'x_handle' => 'https://x.com/fomo_person',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertSessionHasErrors('x_handle');

    expect(CrmContact::count())->toBe(1);
});

test('several records may stand behind one address, and the dossier says so', function () {
    /*
     * An address is not an account. More than one person can stand behind
     * one — an exchange deposit address, a shared or custodial wallet, a
     * whale whose leads are filed separately — so refusing the second record
     * refused a fact about the world, and the entry with it.
     *
     * Saying "these are one person" is the identity graph's job, and it does
     * it through the address they share: both dossiers name the other.
     */
    $user = User::factory()->crmAdmin()->create();
    $solana = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    $evm = '0x'.str_repeat('a', 40);

    $whale = CrmContact::factory()->create([
        'name' => 'Кит',
        'type' => 'whale',
        'solana_address' => $solana,
        'evm_address' => $evm,
    ]);

    $this->actingAs($user)
        ->post(route('crm.store'), [
            'name' => 'Лид за тем же кошельком',
            'solana_address' => $solana,
            'evm_address' => $evm,
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    expect(CrmContact::count())->toBe(2);

    $lead = CrmContact::query()->where('name', 'Лид за тем же кошельком')->sole();

    // And the other direction: putting the address onto a record that exists.
    $second = CrmContact::factory()->create(['name' => 'Второй лид', 'solana_address' => null]);

    $this->actingAs($user)
        ->put(route('crm.update', $second), [
            'name' => 'Второй лид',
            'solana_address' => $solana,
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    expect($second->refresh()->solana_address)->toBe($solana);

    $this->actingAs($user)
        ->get(route('crm.show', $whale))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where(
                'identity.same',
                fn ($same) => collect($same)->pluck('id')->sort()->values()->all()
                    === collect([$lead->id, $second->id])->sort()->values()->all(),
            ));
});

test('a record keeps its own handle when it is edited', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['x_handle' => 'fomo_person']);

    $this->actingAs($user)
        ->put(route('crm.update', $contact), [
            'name' => 'Renamed',
            'x_handle' => 'fomo_person',
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    expect($contact->refresh()->name)->toBe('Renamed');
});

test('an X handle that could not have been one is refused', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->post(route('crm.store'), [
            'x_handle' => 'not a handle at all',
            'type' => 'lead',
            'status' => 'new',
        ])
        ->assertSessionHasErrors('x_handle');
});

test('a person found only on X is reachable from their row and their dossier', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create([
        'name' => 'Dave',
        'telegram' => null,
        'x_handle' => 'dave',
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('rows.0.write', 'https://x.com/dave')
            ->where('rows.0.action', 'write')
        );

    $this->actingAs($user)
        ->get(route('crm.show', $contact))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('contact.x_handle', 'dave')
            ->where('contact.x_url', 'https://x.com/dave')
            ->where('contact.telegram_url', null)
        );
});

test('a numeric telegram id is never offered as a way of writing', function () {
    $user = User::factory()->crmAdmin()->create();

    // What the sync knows about somebody who never set a username. `t.me/812…`
    // opens nothing, so the row's one action must not point at it.
    $contact = CrmContact::factory()->create([
        'telegram' => '819914001',
        'x_handle' => null,
        'email' => null,
    ]);

    $this->actingAs($user)
        ->get(route('crm.people'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('rows.0.write', null)
            ->where('rows.0.action', 'dossier')
        );

    $this->actingAs($user)
        ->get(route('crm.show', $contact))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->where('contact.telegram_url', null));
});

test('an invalid type is rejected', function () {
    $user = User::factory()->crmAdmin()->create();

    $this->actingAs($user)
        ->post(route('crm.store'), ['type' => 'banana', 'status' => 'new'])
        ->assertSessionHasErrors('type');
});

test('a contact can be updated', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['status' => 'new']);

    $this->actingAs($user)
        ->put(route('crm.update', $contact), ['status' => 'customer'])
        ->assertRedirect();

    expect($contact->refresh()->status)->toBe('customer');
});

test('an operator records how much a lead bought and sold', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['status' => 'new']);

    $this->actingAs($user)
        ->put(route('crm.update', $contact), [
            'status' => 'customer',
            'bought_usd' => '1250.50',
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    $this->actingAs($user)
        ->put(route('crm.update', $contact), [
            'status' => 'sold',
            'sold_usd' => '800.25',
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    expect($contact->refresh())
        ->status->toBe('sold')
        ->bought_usd->toBe('1250.50')
        ->sold_usd->toBe('800.25');
});

test('editing the record corrects every field the operator was told', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create([
        'name' => 'Old name',
        'x_handle' => null,
        'tags' => ['fomo'],
    ]);

    $this->actingAs($user)
        ->put(route('crm.update', $contact), [
            'name' => 'New name',
            'telegram' => '@new_handle',
            'x_handle' => '@newname',
            'email' => '',
            'type' => 'holder',
            'status' => 'qualified',
            'tags' => ['fomo', 'wallet'],
        ])
        ->assertRedirect()
        ->assertSessionHasNoErrors();

    $contact->refresh();

    expect($contact->name)->toBe('New name')
        ->and($contact->telegram)->toBe('new_handle')
        ->and($contact->x_handle)->toBe('newname')
        // A field cleared in the form is empty, not the string "".
        ->and($contact->email)->toBeNull()
        ->and($contact->type)->toBe('holder')
        ->and($contact->tags)->toBe(['fomo', 'wallet']);
});

test('the search finds a person by their X handle', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Alice', 'x_handle' => 'alice_x']);
    CrmContact::factory()->create(['name' => 'Bob', 'x_handle' => null]);

    $this->actingAs($user)
        ->get(route('crm.people', ['q' => 'alice_x']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->has('rows', 1)->where('total', 1));
});

test('the search reads a handle the way it is pasted', function () {
    // Handles are stored bare, and what an operator types is what they are
    // looking at: the `@`, or the whole profile URL out of the clipboard. A
    // box that only matched the stored spelling answered "not found" for
    // somebody who was on the books — which is how a person gets entered
    // twice, and how the lead added yesterday went missing.
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Carol', 'x_handle' => 'carol_x']);
    CrmContact::factory()->create(['name' => 'Bob', 'x_handle' => null]);

    foreach (['@carol_x', 'https://x.com/carol_x', 'x.com/carol_x?s=20', 'carol_x'] as $typed) {
        $this->actingAs($user)
            ->get(route('crm.people', ['q' => $typed]))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page->has('rows', 1)->where('total', 1));
    }
});

test('a person written down by hand is findable under the whales the sync just touched', function () {
    /*
     * The bug this pins. Every row on this lens is stamped by the half-hourly
     * balance refresh, so "newest first" by `updated_at` is really "in sync
     * order" — and a lead entered by hand yesterday sank under a screenful of
     * whales re-read this morning. Two answers: the default order pulls in the
     * recently written down explicitly, and `sort=added` asks the question
     * outright.
     */
    $user = User::factory()->crmAdmin()->create();

    $lead = CrmContact::factory()->create([
        'name' => 'вчерашний лид',
        'x_handle' => 'yesterday_lead',
        'type' => 'lead',
        'created_at' => now()->subDay(),
        'updated_at' => now()->subDay(),
    ]);

    // A sync touching everything else a minute ago — more rows than the
    // lens reads as candidates, which is the whole point: under the old
    // ordering the lead was not merely far down the list, it was never read.
    CrmContact::factory()->count(90)->create([
        'type' => 'whale',
        'created_at' => now()->subMonths(3),
        'updated_at' => now()->subMinute(),
    ]);

    $names = fn (array $query): array => collect(
        $this->actingAs($user)
            ->get(route('crm.people', $query))
            ->assertOk()
            ->viewData('page')['props']['rows'] ?? [],
    )->pluck('id')->all();

    expect($names([]))->toContain($lead->id)
        ->and($names(['sort' => 'added'])[0] ?? null)->toBe($lead->id);
});

test('the list can be narrowed by type and by status, and says so in the address', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'кит', 'type' => 'whale', 'status' => 'customer']);
    CrmContact::factory()->create(['name' => 'лид', 'type' => 'lead', 'status' => 'new']);

    $this->actingAs($user)
        ->get(route('crm.people', ['type' => 'lead']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->has('rows', 1)
            ->where('rows.0.type', 'lead')
            ->where('type', 'lead'));

    $this->actingAs($user)
        ->get(route('crm.people', ['status' => 'customer']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->has('rows', 1)->where('rows.0.status', 'customer'));

    // A filter nobody defined is no filter at all, never an error and never
    // an empty list: the address is typed by people too.
    $this->actingAs($user)
        ->get(route('crm.people', ['type' => 'dragon', 'sort' => 'sideways']))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->has('rows', 2)
            ->where('type', null)
            ->where('sort', 'signal'));
});

test('a contact can be soft deleted', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();

    $this->actingAs($user)
        ->delete(route('crm.destroy', $contact))
        ->assertRedirect(route('crm.people'));

    $this->assertSoftDeleted($contact);
});

test('a note can be added to a contact', function () {
    $user = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();

    $this->actingAs($user)
        ->post(route('crm.notes.store', $contact), ['body' => 'Called, interested'])
        ->assertRedirect();

    $this->assertDatabaseHas('crm_notes', [
        'crm_contact_id' => $contact->id,
        'user_id' => $user->id,
        'body' => 'Called, interested',
    ]);
});

test('the export returns a csv download', function () {
    $user = User::factory()->crmAdmin()->create();
    CrmContact::factory()->create(['name' => 'Alice']);

    $response = $this->actingAs($user)->get(route('crm.export'));

    $response->assertOk();
    expect($response->headers->get('content-type'))->toContain('text/csv');
});
