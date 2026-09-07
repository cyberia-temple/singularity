<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreCrmTaskRequest;
use App\Http\Requests\UpdateCrmTaskRequest;
use App\Models\CrmContact;
use App\Models\CrmTask;
use App\Models\CrmTaskComment;
use App\Models\User;
use App\Services\Console\ConsoleFeed;
use App\Services\Console\TaskLine;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Inertia\Inertia;
use Inertia\Response;

/**
 * "Задачи" — three columns and one line to type into.
 *
 * The filters are gone. A task list has exactly three states worth separating
 * — late, now, later — and the fourth thing that matters is not a state at
 * all: a task nobody owns. Unowned work never gets picked up by itself, so it
 * stands above the columns as its own band instead of being sorted into them
 * with an empty assignee column.
 */
class CrmTaskController extends Controller
{
    public function index(Request $request): Response
    {
        $tasks = CrmTask::query()
            ->active()
            ->with(['assignee:id,name', 'contact:id,name,telegram', 'comments.user:id,name'])
            ->byDueDate()
            ->get();

        $done = CrmTask::query()
            ->where('status', 'done')
            ->where('completed_at', '>=', now()->subDays(7))
            ->get(['id', 'external_id', 'created_at', 'completed_at']);

        $closed = CrmTask::query()
            ->where('status', 'done')
            ->with(['assignee:id,name', 'contact:id,name,telegram', 'comments.user:id,name'])
            ->orderByDesc('completed_at')
            ->orderByDesc('id')
            ->get()
            ->map(fn (CrmTask $task) => $this->closedRow($task, $request->user()?->id))
            ->all();

        return Inertia::render('crm/Tasks', [
            'columns' => $this->columns($tasks, $request->user()?->id),
            'closed' => $closed,
            'unowned' => $tasks
                ->filter(fn (CrmTask $task) => $task->assigned_to_user_id === null)
                ->map(fn (CrmTask $task) => $this->row($task, $request->user()?->id))
                ->values()
                ->all(),
            'stats' => [
                'open' => $tasks->count(),
                'overdue' => $tasks->filter(fn (CrmTask $task) => $task->isOverdue())->count(),
                'unowned' => $tasks->filter(fn (CrmTask $task) => $task->assigned_to_user_id === null)->count(),
                'closed_7d' => $done->count(),
                // How long a task lives, which is the only number that says
                // whether the board is a plan or a graveyard.
                'median_days' => $this->medianDays($done),
            ],
            'options' => [
                'priorities' => CrmTask::PRIORITIES,
                'assignees' => User::crmOperators()
                    ->get(['id', 'name'])
                    ->map(fn (User $user) => ['id' => $user->id, 'name' => $user->name])
                    ->all(),
            ],
        ]);
    }

    /**
     * Create a task, from a form or from one typed line.
     *
     * Reached standalone (POST /crm/tasks) and nested under a contact
     * (POST /crm/{contact}/tasks), which binds $contact.
     */
    public function store(StoreCrmTaskRequest $request, ?CrmContact $contact = null): RedirectResponse
    {
        $data = $request->validated();

        // One typed line beats four fields: `@who !when #whom` is parsed out
        // of the title, and anything that matches nothing stays in the title.
        $parsed = TaskLine::parse($data['title']);

        CrmTask::create([
            ...$data,
            'title' => $parsed['title'],
            'assigned_to_user_id' => $data['assigned_to_user_id'] ?? $parsed['assigned_to_user_id'],
            'due_at' => $data['due_at'] ?? $parsed['due_at'],
            'crm_contact_id' => $contact?->id ?? $parsed['crm_contact_id'],
            'created_by_user_id' => $request->user()?->id,
        ]);

        ConsoleFeed::forget();

        return back()->with('success', 'Task created');
    }

    /**
     * One task as a workspace: its editable brief, ownership and conversation.
     */
    public function show(Request $request, CrmTask $task): Response
    {
        $task->load([
            'assignee:id,name',
            'creator:id,name',
            'contact:id,name,telegram,x_handle',
            'comments.user:id,name',
        ]);

        return Inertia::render('crm/Task', [
            'task' => [
                ...$this->row($task, $request->user()?->id),
                'created_at' => $task->created_at?->toIso8601String(),
                'updated_at' => $task->updated_at?->toIso8601String(),
                'completed_at' => $task->completed_at?->toIso8601String(),
                'creator' => $task->creator?->name,
                'external_id' => $task->external_id,
            ],
            'options' => [
                'statuses' => CrmTask::STATUSES,
                'priorities' => CrmTask::PRIORITIES,
                'assignees' => User::crmOperators()
                    ->get(['id', 'name'])
                    ->map(fn (User $user) => ['id' => $user->id, 'name' => $user->name])
                    ->all(),
            ],
        ]);
    }

    public function update(UpdateCrmTaskRequest $request, CrmTask $task): RedirectResponse
    {
        $task->update($request->validated());

        ConsoleFeed::forget();

        return back()->with('success', 'Task updated');
    }

    /**
     * Take an unowned task.
     *
     * One button, because that is the whole interaction: the band exists to
     * be emptied, and choosing an assignee from a dropdown to put your own
     * name in it is a form standing in the way of a decision already made.
     */
    public function claim(Request $request, CrmTask $task): RedirectResponse
    {
        $task->update(['assigned_to_user_id' => $request->user()?->id]);

        ConsoleFeed::forget();

        return back()->with('success', 'Task claimed');
    }

    public function destroy(CrmTask $task): RedirectResponse
    {
        $task->delete();

        ConsoleFeed::forget();

        return to_route('crm.tasks.index')->with('success', 'Task deleted');
    }

    /**
     * Late, now, later.
     *
     * A task with no due date is "later" rather than a fourth column: undated
     * work is not a category, it is work somebody has not decided about yet.
     *
     * @param  Collection<int, CrmTask>  $tasks
     * @return array<string, array<int, array<string, mixed>>>
     */
    private function columns(Collection $tasks, ?int $currentUserId): array
    {
        $tomorrow = CarbonImmutable::now()->addDay()->endOfDay();

        $columns = ['overdue' => [], 'soon' => [], 'later' => []];

        foreach ($tasks as $task) {
            $column = match (true) {
                $task->isOverdue() => 'overdue',
                $task->due_at !== null && $task->due_at->lessThanOrEqualTo($tomorrow) => 'soon',
                default => 'later',
            };

            $columns[$column][] = $this->row($task, $currentUserId);
        }

        return $columns;
    }

    /** @return array<string, mixed> */
    private function row(CrmTask $task, ?int $currentUserId): array
    {
        return [
            'id' => $task->id,
            'title' => $task->title,
            'description' => $task->description,
            'status' => $task->status,
            'priority' => $task->priority,
            'due_at' => $task->due_at?->toIso8601String(),
            'overdue' => $task->isOverdue(),
            'overdue_days' => $task->isOverdue()
                ? (int) $task->due_at->diffInDays(now())
                : null,
            'assignee' => $task->assignee?->name,
            'assignee_id' => $task->assigned_to_user_id,
            'is_mine' => $task->assigned_to_user_id === $currentUserId,
            'comments' => $this->comments($task, $currentUserId),
            'contact' => $task->contact === null ? null : [
                'id' => $task->contact->id,
                'name' => $task->contact->displayName(),
            ],
        ];
    }

    /** @return array<string, mixed> */
    private function closedRow(CrmTask $task, ?int $currentUserId): array
    {
        return [
            'id' => $task->id,
            'title' => $task->title,
            'description' => $task->description,
            'completed_at' => $task->completed_at?->toIso8601String(),
            'assignee' => $task->assignee?->name,
            'comments' => $this->comments($task, $currentUserId),
            'contact' => $task->contact === null ? null : [
                'id' => $task->contact->id,
                'name' => $task->contact->displayName(),
            ],
        ];
    }

    /** @return array<int, array<string, mixed>> */
    private function comments(CrmTask $task, ?int $currentUserId): array
    {
        return $task->comments->map(fn (CrmTaskComment $comment) => [
            'id' => $comment->id,
            'body' => $comment->body,
            'author' => $comment->user->name,
            'is_mine' => $comment->user_id === $currentUserId,
            'created_at' => $comment->created_at->toIso8601String(),
        ])->all();
    }

    /** @param Collection<int, CrmTask> $done */
    private function medianDays(Collection $done): ?float
    {
        $lives = $done
            // Records LainOS filed are skipped: they arrive already finished,
            // so their life is however long the daemon's outbox held them,
            // and a dozen of those a day would drag this number to zero and
            // stop it saying anything about the work people actually do.
            ->filter(fn (CrmTask $task) => $task->external_id === null)
            ->filter(fn (CrmTask $task) => $task->completed_at !== null && $task->created_at !== null)
            ->map(fn (CrmTask $task) => (float) $task->created_at->diffInDays($task->completed_at, true))
            ->sort()
            ->values();

        if ($lives->isEmpty()) {
            return null;
        }

        $middle = (int) floor($lives->count() / 2);

        return round($lives->count() % 2 === 0
            ? ($lives[$middle - 1] + $lives[$middle]) / 2
            : $lives[$middle], 1);
    }
}
