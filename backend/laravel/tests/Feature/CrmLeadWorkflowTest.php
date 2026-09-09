<?php

use App\Models\CrmContact;
use App\Models\CrmMessage;
use App\Models\CrmTask;
use App\Models\User;
use Carbon\Carbon;
use Inertia\Testing\AssertableInertia as Assert;

test('a recorded conversation and its next step are saved together for this contact', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();
    $due = now()->addDays(2)->setTimezone('Europe/Moscow')->toIso8601String();

    $this->actingAs($operator)->post(route('crm.messages.store', $contact), [
        'body' => 'Договорились прислать условия', 'direction' => 'out', 'channel' => 'telegram',
        'follow_up' => ['title' => 'Прислать условия', 'due_at' => $due, 'assigned_to_user_id' => $operator->id],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $task = CrmTask::query()->sole();
    expect(CrmMessage::query()->sole()->crm_contact_id)->toBe($contact->id)
        ->and($task->crm_contact_id)->toBe($contact->id)
        ->and($task->assigned_to_user_id)->toBe($operator->id)
        ->and($task->created_by_user_id)->toBe($operator->id)
        ->and($task->status)->toBe('open')
        ->and($task->due_at->toIso8601String())->toBe(Carbon::parse($due)->utc()->toIso8601String());

    $this->get(route('crm.people', ['segment' => 'no_next_step']))
        ->assertInertia(fn (Assert $page) => $page->where('total', 0));
    $task->update(['status' => 'done']);
    $this->get(route('crm.people', ['segment' => 'no_next_step']))
        ->assertInertia(fn (Assert $page) => $page->where('total', 1)->where('rows.0.next.kind', 'plan'));
});

test('invalid follow up saves neither the message nor the task', function (string $field, mixed $value) {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();
    $follow = ['title' => 'Позвонить', 'due_at' => now()->addDay()->toIso8601String(), 'assigned_to_user_id' => $operator->id];
    $follow[$field] = $value;

    $this->actingAs($operator)->post(route('crm.messages.store', $contact), [
        'body' => 'Запись разговора', 'direction' => 'out', 'channel' => 'call', 'follow_up' => $follow,
    ])->assertSessionHasErrors('follow_up.'.$field);
    expect(CrmMessage::query()->count())->toBe(0)->and(CrmTask::query()->count())->toBe(0);
})->with([
    ['title', ''], ['due_at', '2000-01-01T00:00:00Z'], ['assigned_to_user_id', 999999],
]);

test('reply segment follows the last said message including equal timestamps and backfilled history', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();
    $time = now()->subDay();
    CrmMessage::factory()->create(['crm_contact_id' => $contact->id, 'direction' => 'out', 'sent_at' => $time]);
    CrmMessage::factory()->create(['crm_contact_id' => $contact->id, 'direction' => 'in', 'sent_at' => $time]);
    CrmMessage::factory()->create(['crm_contact_id' => $contact->id, 'direction' => 'out', 'sent_at' => now()->subWeek()]);
    $lost = CrmContact::factory()->create(['status' => 'lost']);
    CrmMessage::factory()->create(['crm_contact_id' => $lost->id, 'direction' => 'in']);

    $this->actingAs($operator)->get(route('crm.people', ['segment' => 'needs_reply']))
        ->assertInertia(fn (Assert $page) => $page->where('total', 1)->where('rows.0.id', $contact->id)->where('rows.0.next.kind', 'reply'));

    $this->post(route('crm.messages.store', $contact), ['body' => 'Ответили', 'direction' => 'out', 'channel' => 'telegram'])
        ->assertSessionHasNoErrors();
    $this->get(route('crm.people', ['segment' => 'needs_reply']))
        ->assertInertia(fn (Assert $page) => $page->where('total', 0));
});

test('first contact requires no recorded messages and existing tasks show the earliest deadline', function () {
    $operator = User::factory()->crmAdmin()->create();
    $fresh = CrmContact::factory()->create(['type' => 'lead', 'status' => 'new']);
    $planned = CrmContact::factory()->create(['type' => 'lead', 'status' => 'new']);
    $earliest = CrmTask::factory()->create(['crm_contact_id' => $planned->id, 'due_at' => now()->subDay(), 'priority' => 'normal']);
    CrmTask::factory()->create(['crm_contact_id' => $planned->id, 'due_at' => now()->addDays(2), 'priority' => 'high']);
    $contacted = CrmContact::factory()->create(['type' => 'lead', 'status' => 'new']);
    CrmMessage::factory()->create(['crm_contact_id' => $contacted->id]);

    $this->actingAs($operator)->get(route('crm.people', ['segment' => 'first_contact']))
        ->assertInertia(function (Assert $page) use ($fresh, $planned, $earliest) {
            $page->where('total', 2)->where('rows', function ($rows) use ($fresh, $planned, $earliest) {
                $rows = collect($rows)->keyBy('id');

                return $rows[$fresh->id]['next']['kind'] === 'first'
                    && $rows[$planned->id]['next']['kind'] === 'overdue'
                    && $rows[$planned->id]['next']['task']['id'] === $earliest->id;
            });
        });
});
