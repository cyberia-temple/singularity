<?php

use App\Models\CrmContact;
use App\Models\CrmTask;
use App\Models\CrmTaskComment;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

/** A second allow-listed operator, so assignment has somewhere to go. */
function secondOperator(): User
{
    return User::factory()->create([
        'wallet_address' => config('crm.admin_wallets')[1],
    ]);
}

test('guests and non-operators cannot reach tasks', function () {
    $this->get(route('crm.tasks.index'))->assertRedirect(route('login'));

    $stranger = User::factory()->create(['wallet_address' => '0x'.str_repeat('e', 40)]);
    $task = CrmTask::factory()->create();

    $this->actingAs($stranger)->get(route('crm.tasks.index'))->assertNotFound();
    $this->actingAs($stranger)->get(route('crm.tasks.show', $task))->assertNotFound();
    $this->actingAs($stranger)->post(route('crm.tasks.store'), ['title' => 'x'])->assertNotFound();
    $this->actingAs($stranger)->put(route('crm.tasks.update', $task), ['status' => 'done'])->assertNotFound();
    $this->actingAs($stranger)->post(route('crm.tasks.comments.store', $task), ['body' => 'Nope'])->assertNotFound();
    $this->actingAs($stranger)->delete(route('crm.tasks.destroy', $task))->assertNotFound();

    expect($task->fresh()->status)->toBe('open');
});

test('an operator can open a task workspace with its people and activity', function () {
    $this->withoutVite();

    $operator = User::factory()->crmAdmin()->create(['name' => 'Lain']);
    $creator = secondOperator();
    $contact = CrmContact::factory()->create(['name' => 'Alice']);
    $task = CrmTask::factory()->assignedTo($operator)->create([
        'created_by_user_id' => $creator->id,
        'crm_contact_id' => $contact->id,
        'title' => 'Prepare the report',
        'description' => "First line\nSecond line",
        'priority' => 'high',
    ]);
    CrmTaskComment::factory()->create([
        'crm_task_id' => $task->id,
        'user_id' => $operator->id,
        'body' => 'Started collecting data',
    ]);

    $this->actingAs($operator)
        ->get(route('crm.tasks.show', $task))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Task')
            ->where('task.title', 'Prepare the report')
            ->where('task.description', "First line\nSecond line")
            ->where('task.priority', 'high')
            ->where('task.assignee', 'Lain')
            ->where('task.creator', $creator->name)
            ->where('task.contact.name', 'Alice')
            ->where('task.comments.0.body', 'Started collecting data')
            ->has('options.statuses', 4)
            ->has('options.priorities', 3)
        );
});

test('the board sorts tasks into late, now and later, and lifts out the unowned', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['name' => 'Alice']);

    CrmTask::factory()->assignedTo($operator)->create([
        'crm_contact_id' => $contact->id,
        'title' => 'Call Alice back',
        'due_at' => now()->addHours(3),
    ]);
    CrmTask::factory()->standalone()->overdue()->create(['title' => 'Rotate relayer key']);
    CrmTask::factory()->standalone()->create([
        'title' => 'Write the release post',
        'due_at' => now()->addWeek(),
    ]);
    CrmTask::factory()->standalone()->done()->create();

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Tasks')
            ->has('columns.overdue', 1)
            ->where('columns.overdue.0.title', 'Rotate relayer key')
            ->has('columns.soon', 1)
            ->where('columns.soon.0.contact.name', 'Alice')
            ->where('columns.soon.0.is_mine', true)
            ->has('columns.later', 1)
            ->has('closed', 1)
            // Work nobody owns is a state, not a row with an empty column.
            ->has('unowned', 2)
            ->where('stats.open', 3)
            ->where('stats.overdue', 1)
            ->where('stats.unowned', 2)
            ->where('options.assignees.0.id', $operator->id)
        );
});

test('tasks in a column are ordered by priority before their due date', function () {
    $operator = User::factory()->crmAdmin()->create();

    CrmTask::factory()->assignedTo($operator)->standalone()->create([
        'title' => 'Low first by date',
        'priority' => 'low',
        'due_at' => now()->addDays(5),
    ]);
    CrmTask::factory()->assignedTo($operator)->standalone()->create([
        'title' => 'Normal second',
        'priority' => 'normal',
        'due_at' => now()->addDays(6),
    ]);
    CrmTask::factory()->assignedTo($operator)->standalone()->create([
        'title' => 'High first',
        'priority' => 'high',
        'due_at' => now()->addWeek(),
    ]);

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertInertia(fn (Assert $page) => $page
            ->where('columns.later.0.title', 'High first')
            ->where('columns.later.1.title', 'Normal second')
            ->where('columns.later.2.title', 'Low first by date')
        );
});

test('operators can comment on tasks and comments appear with their authors', function () {
    $operator = User::factory()->crmAdmin()->create(['name' => 'Lain']);
    $task = CrmTask::factory()->assignedTo($operator)->standalone()->create();

    $this->actingAs($operator)
        ->post(route('crm.tasks.comments.store', $task), [
            'body' => "Первая строка\nВторая строка",
        ])
        ->assertRedirect()
        ->assertSessionHas('success');

    $comment = CrmTaskComment::query()->sole();

    expect($comment->user_id)->toBe($operator->id)
        ->and($comment->body)->toBe("Первая строка\nВторая строка");

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertInertia(fn (Assert $page) => $page
            ->has('columns.later.0.comments', 1)
            ->where('columns.later.0.comments.0.author', 'Lain')
            ->where('columns.later.0.comments.0.is_mine', true)
            ->where('columns.later.0.comments.0.body', "Первая строка\nВторая строка")
        );
});

test('task comments are validated and cascade when the task is deleted', function () {
    $operator = User::factory()->crmAdmin()->create();
    $task = CrmTask::factory()->standalone()->create();

    $this->actingAs($operator)
        ->post(route('crm.tasks.comments.store', $task), ['body' => ''])
        ->assertSessionHasErrors('body');

    $comment = CrmTaskComment::factory()->create([
        'crm_task_id' => $task->id,
        'user_id' => $operator->id,
    ]);

    $task->delete();

    $this->assertDatabaseMissing('crm_task_comments', ['id' => $comment->id]);
});

test('an unowned task is taken with one button', function () {
    $operator = User::factory()->crmAdmin()->create();
    $task = CrmTask::factory()->standalone()->create();

    $this->actingAs($operator)
        ->post(route('crm.tasks.claim', $task))
        ->assertRedirect();

    expect($task->refresh()->assigned_to_user_id)->toBe($operator->id);
});

test('one typed line becomes a task with its assignee, date and person', function () {
    $operator = User::factory()->crmAdmin()->create(['name' => 'lain']);
    $contact = CrmContact::factory()->create(['name' => 'Nakamoto Ghost']);

    $this->actingAs($operator)
        ->post(route('crm.tasks.store'), [
            'title' => 'написать киту про лимиты моста @lain !завтра #Nakamoto',
        ])
        ->assertRedirect();

    $task = CrmTask::query()->latest('id')->first();

    expect($task->title)->toBe('написать киту про лимиты моста')
        ->and($task->assigned_to_user_id)->toBe($operator->id)
        ->and($task->crm_contact_id)->toBe($contact->id)
        ->and($task->due_at)->not->toBeNull();
});

test('a token that matches nothing stays in the title rather than being thrown away', function () {
    $operator = User::factory()->crmAdmin()->create(['name' => 'lain']);

    $this->actingAs($operator)
        ->post(route('crm.tasks.store'), ['title' => 'проверить #несуществующего @никого'])
        ->assertRedirect();

    expect(CrmTask::query()->latest('id')->first()->title)
        ->toBe('проверить #несуществующего @никого');
});

test('a task is created and assigned to an operator', function () {
    $operator = User::factory()->crmAdmin()->create();
    $other = secondOperator();

    $this->actingAs($operator)
        ->post(route('crm.tasks.store'), [
            'title' => 'Draft the whale outreach',
            'description' => 'Top 20 holders',
            'assigned_to_user_id' => $other->id,
            'priority' => 'high',
            'due_at' => '2026-08-01',
        ])
        ->assertRedirect()
        ->assertSessionHas('success');

    $task = CrmTask::sole();

    expect($task->title)->toBe('Draft the whale outreach')
        ->and($task->assigned_to_user_id)->toBe($other->id)
        ->and($task->created_by_user_id)->toBe($operator->id)
        ->and($task->crm_contact_id)->toBeNull()
        ->and($task->priority)->toBe('high')
        ->and($task->status)->toBe('open')
        ->and($task->due_at->toDateString())->toBe('2026-08-01');
});

test('a task created from a contact page is linked to that contact', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();

    $this->actingAs($operator)
        ->post(route('crm.tasks.storeForContact', $contact), [
            'title' => 'Send bridge instructions',
            'assigned_to_user_id' => $operator->id,
        ])
        ->assertRedirect();

    expect(CrmTask::sole()->crm_contact_id)->toBe($contact->id);
});

test('tasks can be reassigned and unassigned', function () {
    $operator = User::factory()->crmAdmin()->create();
    $other = secondOperator();
    $task = CrmTask::factory()->assignedTo($operator)->create();

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), ['assigned_to_user_id' => $other->id])
        ->assertRedirect();

    expect($task->fresh()->assigned_to_user_id)->toBe($other->id);

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), ['assigned_to_user_id' => null])
        ->assertRedirect();

    expect($task->fresh()->assigned_to_user_id)->toBeNull();
});

test('a task can be edited with a multiline description, due date and assignee', function () {
    $operator = User::factory()->crmAdmin()->create();
    $other = secondOperator();
    $task = CrmTask::factory()->standalone()->create();

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), [
            'title' => 'Обновлённая задача',
            'description' => "Первая строка\nВторая строка",
            'priority' => 'high',
            'due_at' => '2026-09-15',
            'assigned_to_user_id' => $other->id,
        ])
        ->assertRedirect()
        ->assertSessionHas('success');

    $task->refresh();

    expect($task->title)->toBe('Обновлённая задача')
        ->and($task->description)->toBe("Первая строка\nВторая строка")
        ->and($task->priority)->toBe('high')
        ->and($task->due_at->toDateString())->toBe('2026-09-15')
        ->and($task->assigned_to_user_id)->toBe($other->id);
});

test('a user outside the crm allow list cannot be assigned a task', function () {
    $operator = User::factory()->crmAdmin()->create();
    $stranger = User::factory()->create(['wallet_address' => '0x'.str_repeat('d', 40)]);

    $this->actingAs($operator)
        ->post(route('crm.tasks.store'), [
            'title' => 'Nope',
            'assigned_to_user_id' => $stranger->id,
        ])
        ->assertSessionHasErrors('assigned_to_user_id');

    $task = CrmTask::factory()->create();

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), ['assigned_to_user_id' => $stranger->id])
        ->assertSessionHasErrors('assigned_to_user_id');

    expect(CrmTask::count())->toBe(1)
        ->and($task->fresh()->assigned_to_user_id)->toBeNull();
});

test('completing a task stamps completed_at and reopening clears it', function () {
    $operator = User::factory()->crmAdmin()->create();
    $task = CrmTask::factory()->assignedTo($operator)->create();

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), ['status' => 'done'])
        ->assertRedirect();

    expect($task->fresh()->completed_at)->not->toBeNull();

    $this->actingAs($operator)
        ->put(route('crm.tasks.update', $task), ['status' => 'open'])
        ->assertRedirect();

    expect($task->fresh()->completed_at)->toBeNull();
});

test('a closed task leaves the board and lands in the week is numbers', function () {
    $operator = User::factory()->crmAdmin()->create();
    $other = secondOperator();

    CrmTask::factory()->standalone()->assignedTo($operator)->overdue()->create();
    CrmTask::factory()->standalone()->assignedTo($other)->create();
    CrmTask::factory()->standalone()->create();
    CrmTask::factory()->standalone()->done()->create(['completed_at' => now()->subDay()]);

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertInertia(fn (Assert $page) => $page
            ->where('stats.open', 3)
            ->where('stats.closed_7d', 1)
        );
});

test('the completed task journal is ordered from newest to oldest', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create(['name' => 'Alice']);

    CrmTask::factory()->assignedTo($operator)->done()->create([
        'title' => 'Older task',
        'completed_at' => now()->subDays(3),
    ]);
    CrmTask::factory()->done()->create([
        'crm_contact_id' => $contact->id,
        'title' => 'Newest task',
        'completed_at' => now()->subHour(),
    ]);

    $this->actingAs($operator)
        ->get(route('crm.tasks.index'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->has('closed', 2)
            ->where('closed.0.title', 'Newest task')
            ->where('closed.0.contact.name', 'Alice')
            ->where('closed.1.title', 'Older task')
            ->where('closed.1.assignee', $operator->name)
        );
});

test('tasks are deleted and contact deletion takes its tasks with it', function () {
    $operator = User::factory()->crmAdmin()->create();
    $task = CrmTask::factory()->standalone()->create();

    $this->actingAs($operator)
        ->delete(route('crm.tasks.destroy', $task))
        ->assertRedirect();

    $this->assertDatabaseMissing('crm_tasks', ['id' => $task->id]);

    // Contacts soft-delete, so their tasks survive the CRM delete button and
    // only cascade when the row is force-deleted.
    $contact = CrmContact::factory()->create();
    $attached = CrmTask::factory()->create(['crm_contact_id' => $contact->id]);

    $contact->delete();
    $this->assertDatabaseHas('crm_tasks', ['id' => $attached->id]);

    $contact->forceDelete();
    $this->assertDatabaseMissing('crm_tasks', ['id' => $attached->id]);
});

test('the contact page carries its tasks and the assignee options', function () {
    $operator = User::factory()->crmAdmin()->create();
    $contact = CrmContact::factory()->create();
    CrmTask::factory()->assignedTo($operator)->create([
        'crm_contact_id' => $contact->id,
        'title' => 'Follow up',
    ]);

    $this->actingAs($operator)
        ->get(route('crm.show', $contact))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Person')
            ->has('tasks', 1)
            ->where('tasks.0.title', 'Follow up')
            ->where('tasks.0.assignee', $operator->name)
            ->has('options.assignees', 1)
        );
});
