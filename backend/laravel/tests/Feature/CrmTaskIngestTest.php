<?php

use App\Models\CrmTask;
use App\Models\User;
use Inertia\Testing\AssertableInertia;

/**
 * The daemon's door onto the board.
 *
 * What is being pinned here is not "a row appears": it is that a token nobody
 * set refuses everything, that a retried delivery writes one line and not two,
 * and that a record of something already finished is dated when it happened
 * rather than when the outbox got through.
 */
beforeEach(function () {
    config()->set('crm.ingest.token', 'test-ingest-token');
});

test('the ingest does not exist without a token, or with the wrong one', function () {
    config()->set('crm.ingest.token', '');

    $this->postJson('/api/crm/tasks', ['id' => 'lainos:x:1', 'title' => 'Nope'])
        ->assertNotFound();

    config()->set('crm.ingest.token', 'test-ingest-token');

    $this->postJson('/api/crm/tasks', ['id' => 'lainos:x:1', 'title' => 'Nope'], [
        'X-Crm-Token' => 'guessed',
    ])->assertNotFound();

    $this->postJson('/api/crm/tasks', ['id' => 'lainos:x:1', 'title' => 'Nope'])
        ->assertNotFound();

    expect(CrmTask::query()->count())->toBe(0);
});

test('a record needing a human lands open and unowned', function () {
    $this->postJson('/api/crm/tasks', [
        'id' => 'lainos:alert:7',
        'title' => 'CYBER на 0xfA41 упал ниже 5',
        'detail' => 'watch w3',
        'priority' => 'high',
    ], ['X-Crm-Token' => 'test-ingest-token'])
        ->assertCreated()
        ->assertJson(['ok' => true, 'created' => true]);

    $task = CrmTask::query()->sole();

    expect($task->external_id)->toBe('lainos:alert:7')
        ->and($task->status)->toBe('open')
        ->and($task->priority)->toBe('high')
        ->and($task->description)->toBe('watch w3')
        ->and($task->assigned_to_user_id)->toBeNull()
        ->and($task->created_by_user_id)->toBeNull()
        ->and($task->completed_at)->toBeNull();
});

test('a record of something finished is dated when it happened', function () {
    $happened = now()->subHours(6);

    $this->postJson('/api/crm/tasks', [
        'id' => 'lainos:trade:0xabc',
        'title' => 'продала MINE, +0.4 CYBER',
        'status' => 'done',
        'at' => $happened->toIso8601String(),
    ], ['X-Crm-Token' => 'test-ingest-token'])->assertCreated();

    $task = CrmTask::query()->sole();

    expect($task->status)->toBe('done')
        ->and($task->completed_at->diffInMinutes($happened, true))->toBeLessThan(1);
});

test('a retried delivery writes one line, not two', function () {
    $payload = ['id' => 'lainos:wish:51', 'title' => 'wish51 собран', 'status' => 'done'];

    $this->postJson('/api/crm/tasks', $payload, ['X-Crm-Token' => 'test-ingest-token'])
        ->assertCreated()
        ->assertJson(['created' => true]);

    $this->postJson('/api/crm/tasks', [...$payload, 'title' => 'другой текст'], [
        'X-Crm-Token' => 'test-ingest-token',
    ])->assertOk()->assertJson(['created' => false]);

    expect(CrmTask::query()->count())->toBe(1)
        ->and(CrmTask::query()->sole()->title)->toBe('wish51 собран');
});

test('the ingest cannot assign an operator or reach a contact', function () {
    $this->postJson('/api/crm/tasks', [
        'id' => 'lainos:x:9',
        'title' => 'Take a look',
        'assigned_to_user_id' => 1,
        'crm_contact_id' => 1,
        'due_at' => now()->addDay()->toIso8601String(),
    ], ['X-Crm-Token' => 'test-ingest-token'])->assertCreated();

    $task = CrmTask::query()->sole();

    expect($task->assigned_to_user_id)->toBeNull()
        ->and($task->crm_contact_id)->toBeNull()
        ->and($task->due_at)->toBeNull();
});

test('a clock ahead of ours cannot date a record into the future', function () {
    $this->postJson('/api/crm/tasks', [
        'id' => 'lainos:trade:0xdef',
        'title' => 'куплено',
        'status' => 'done',
        'at' => now()->addYear()->toIso8601String(),
    ], ['X-Crm-Token' => 'test-ingest-token'])->assertCreated();

    expect(CrmTask::query()->sole()->completed_at->isFuture())->toBeFalse();
});

test('records filed by the daemon stay out of how long a task lives', function () {
    $operator = User::factory()->crmAdmin()->create();

    // One real task that took four days.
    CrmTask::factory()->create([
        'status' => 'done',
        'created_at' => now()->subDays(4),
        'completed_at' => now()->subMinutes(5),
    ]);

    // And ten machine records, each finished the moment it was filed.
    for ($i = 0; $i < 10; $i++) {
        CrmTask::factory()->create([
            'external_id' => "lainos:trade:{$i}",
            'status' => 'done',
            'completed_at' => now()->subMinutes(10),
        ]);
    }

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->where('stats.median_days', 4)
            ->where('stats.closed_7d', 11));
});
