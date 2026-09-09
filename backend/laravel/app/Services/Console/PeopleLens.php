<?php

namespace App\Services\Console;

use App\Models\BridgeRequest;
use App\Models\CrmContact;
use App\Models\CrmNote;
use App\Models\CrmSync;
use App\Models\CrmTask;
use App\Services\WalletPriceService;
use App\Support\CrmContactUrl;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * "Люди" — the same contacts, read as what happened to them.
 *
 * Two things changed against the old table. The filters became segments: a
 * filter is a question re-asked by hand every time ("type: whale" plus
 * "status: customer"), a segment is that question saved with its rule visible,
 * and the same saved question is what a report is made of. And the middle of
 * the row stopped being database columns — it says what happened to the
 * person (withdrew 40% in three days, silent for 34 days, replied and is
 * waiting on us), because that is what decides whether anyone writes to them
 * today.
 *
 * Everything here is derived from records this app already holds: notes,
 * tasks and the bridge ledger. Nothing is invented for the sake of a fuller
 * row — a contact with no history says so.
 */
class PeopleLens
{
    /** How many rows one screen of the lens carries. */
    private const ROWS = 40;

    /** Weeks in the little activity bar on each row. */
    private const WEEKS = 12;

    public function __construct(private WalletPriceService $prices) {}

    /**
     * The segments, each with its rule and its count.
     *
     * The rule travels with the segment on purpose: an operator who cannot
     * see "customer with nothing on record for 30 days" cannot tell whether
     * an empty segment means good news or a broken definition.
     *
     * @return array<int, array<string, mixed>>
     */
    public function segments(): array
    {
        $segments = [];

        foreach (array_keys(self::definitions()) as $key) {
            $segments[] = [
                'key' => $key,
                'count' => $this->query($key)->count(),
                'tone' => self::definitions()[$key]['tone'],
            ];
        }

        return $segments;
    }

    /**
     * The segment definitions: one query apiece, named.
     *
     * @return array<string, array{tone: string, apply: callable(Builder<CrmContact>): void}>
     */
    private static function definitions(): array
    {
        $silence = (int) config('crm.console.silence_days', 30);

        return [
            'all' => [
                'tone' => 'plain',
                'apply' => function (Builder $query): void {},
            ],
            'first_contact' => [
                'tone' => 'plain',
                'apply' => fn (Builder $query) => $query
                    ->where('type', 'lead')->where('status', 'new')->whereDoesntHave('messages'),
            ],
            'needs_reply' => [
                'tone' => 'warning',
                'apply' => fn (Builder $query) => $query->where('status', '!=', 'lost')
                    ->whereHas('latestMessage', fn ($messages) => $messages->where('direction', 'in')),
            ],
            'no_next_step' => [
                'tone' => 'warning',
                'apply' => fn (Builder $query) => $query->where('status', '!=', 'lost')
                    ->whereHas('messages')->whereDoesntHave('tasks', fn ($tasks) => $tasks->active()),
            ],
            'partners' => [
                'tone' => 'accent',
                'apply' => fn (Builder $query) => $query->where('type', 'partner'),
            ],
            'whales' => [
                'tone' => 'money',
                'apply' => fn (Builder $query) => $query->where('type', 'whale'),
            ],
            'new_whales' => [
                'tone' => 'money',
                'apply' => fn (Builder $query) => $query
                    ->where('type', 'whale')
                    ->where('created_at', '>=', now()->subDays(30)),
            ],
            'awaiting' => [
                'tone' => 'accent',
                'apply' => fn (Builder $query) => $query->whereHas(
                    'tasks',
                    fn ($tasks) => $tasks->active(),
                ),
            ],
            // The one that reads as a report line: a customer with nothing on
            // record for a month. Bridge activity counts as a record even
            // though it is not ours, because a person who is still moving
            // money has not gone quiet — they have gone quiet *with us*.
            'silent_customers' => [
                'tone' => 'warning',
                'apply' => fn (Builder $query) => $query
                    ->where('status', 'customer')
                    ->whereDoesntHave('notes', fn ($notes) => $notes->where('created_at', '>=', now()->subDays($silence)))
                    ->where('updated_at', '<', now()->subDays($silence)),
            ],
            'one_and_done' => [
                'tone' => 'warning',
                'apply' => fn (Builder $query) => $query
                    ->whereIn('status', ['qualified', 'customer'])
                    ->whereDoesntHave('notes')
                    ->where('created_at', '<', now()->subDays($silence)),
            ],
            'cold_leads' => [
                'tone' => 'plain',
                'apply' => fn (Builder $query) => $query
                    ->where('type', 'lead')
                    ->where('status', 'new')
                    ->whereDoesntHave('notes'),
            ],
            // People who held and stopped. They are not deleted and they are
            // not "lost" either — the balance left, the person did not, and a
            // holder who sold once is the readiest audience there is.
            'sold' => [
                'tone' => 'warning',
                'apply' => fn (Builder $query) => $query->where('status', 'sold'),
            ],
            'solana_only' => [
                'tone' => 'plain',
                'apply' => fn (Builder $query) => $query
                    ->whereNotNull('solana_address')
                    ->whereNull('evm_address'),
            ],
        ];
    }

    /**
     * How old the base is, as the last recorded import.
     *
     * The question a filled screen never answers on its own is how much of it
     * is still true. `crm_contacts.last_synced_at` cannot answer it — it is
     * stamped per contact by the half-hourly balance refresh, so its maximum
     * says a balance was read, not that the base was rebuilt.
     *
     * `partial` is the load-bearing half: the holder scan is one call to a
     * public RPC that answers a rate-limit with an empty result, and a date
     * over a run that read nothing is exactly the lie this reports instead.
     *
     * @return array<string, mixed>|null
     */
    public function lastSync(): ?array
    {
        $run = CrmSync::query()->latest('id')->first();

        if ($run === null) {
            return null;
        }

        return [
            'at' => ($run->finished_at ?? $run->started_at)->toIso8601String(),
            'trigger' => $run->trigger,
            'added' => $run->added,
            'sold' => $run->sold,
            'running' => $run->finished_at === null,
            'partial' => ! $run->isComplete(),
        ];
    }

    public static function has(string $key): bool
    {
        return array_key_exists($key, self::definitions());
    }

    /** @return Builder<CrmContact> */
    private function query(string $segment): Builder
    {
        $query = CrmContact::query();
        $apply = self::definitions()[$segment]['apply'] ?? null;

        if ($apply !== null) {
            $apply($query);
        }

        return $query;
    }

    /** How the list may be ordered, and what each order is for. */
    public const SORTS = ['signal', 'added', 'name', 'money'];

    /**
     * The rows of one segment, in the order that was asked for.
     *
     * A segment is a saved question and stays one; `type`, `status` and the
     * search are the narrowing an operator does inside it, and `sort` is the
     * one thing the lens could not say before: **when somebody was written
     * down**. Everything on this screen is stamped by the half-hourly balance
     * refresh, so "newest first" by `updated_at` is really "in sync order",
     * and a lead entered by hand yesterday sank under two hundred whales
     * whose balances were re-read this morning. That is the whole reason a
     * person could be on the books and impossible to find.
     *
     * @return array<string, mixed>
     */
    public function rows(
        string $segment,
        ?string $search = null,
        int $limit = self::ROWS,
        ?string $type = null,
        ?string $status = null,
        string $sort = 'signal',
    ): array {
        $limit = max(self::ROWS, min($limit, 400));
        $sort = in_array($sort, self::SORTS, true) ? $sort : 'signal';

        $narrow = fn (Builder $query): Builder => $query
            ->when($search, fn ($q) => $q->search($search))
            ->when($type, fn ($q) => $q->where('type', $type))
            ->when($status, fn ($q) => $q->where('status', $status));

        $total = $narrow($this->query($segment))->count();
        $contacts = $this->candidates($segment, $narrow, $limit, $sort);

        if ($contacts->isEmpty()) {
            return ['rows' => [], 'total' => $total, 'shown' => 0, 'limit' => $limit, 'more' => false];
        }

        $notes = $this->latestNotes($contacts);
        $tasks = $this->openTasks($contacts);
        $transfers = $this->transfers($contacts);
        $price = $this->prices->quotes()['prices']['cyberia'] ?? null;
        $contacts->loadMissing(['contactLinks', 'latestMessage']);

        $rows = $contacts->map(function (CrmContact $contact) use ($notes, $tasks, $transfers, $price): array {
            $signal = $this->signal($contact, $notes, $tasks, $transfers);
            $cyber = (float) ($contact->cyber_balance ?? 0);
            $sol = (float) ($contact->cyber_sol_balance ?? 0);

            // Where a message to this person would go. Telegram first because
            // that is where a conversation already exists; X second because a
            // person found on X is reachable nowhere else. Both may be
            // missing, and a numeric Telegram id (all the sync knows about
            // somebody without a username) is not an address — an action that
            // opens a dead page is worse than no action.
            $writeWays = CrmContactUrl::ways($contact);

            return [
                'id' => $contact->id,
                'name' => $contact->displayName(),
                'handle' => $contact->displayHandle(),
                'type' => $contact->type,
                'status' => $contact->status,
                'bought_usd' => $contact->bought_usd,
                'sold_usd' => $contact->sold_usd,
                'usd' => $price === null ? null : round(($cyber + $sol) * $price),
                // When this record was written down, which is the one fact
                // about a person the lens could not show and the one an
                // operator uses to find somebody they entered yesterday.
                'added' => $contact->created_at?->toIso8601String(),
                'signal' => $signal,
                'next' => $this->nextStep($contact, $tasks->get($contact->id)),
                'spark' => $transfers['weekly'][$contact->id] ?? array_fill(0, self::WEEKS, 0),
                'write' => $writeWays[0]['url'] ?? null,
                'write_ways' => $writeWays,
                'action' => $writeWays !== [] ? 'write' : 'dossier',
            ];
        })
            ->pipe(fn (Collection $rows) => $this->ordered($rows, $sort))
            ->values()
            ->take($limit)
            ->all();

        return [
            'rows' => $rows,
            'total' => $total,
            'shown' => count($rows),
            'limit' => $limit,
            'more' => $total > count($rows),
        ];
    }

    /**
     * The contacts one screen might show, before the row is built.
     *
     * Three of the four orders are SQL and take exactly one screen. The
     * fourth — the default — is computed from notes, tasks and transfers
     * after the rows are read, so it deliberately reads more than a screen:
     * taking forty by `updated_at` and reordering *those* would rank the
     * fortieth row's signal above the forty-first's without having seen it.
     *
     * The second read is what keeps a new person findable. `updated_at` on
     * this table is mostly the balance refresh talking, so the recently
     * *written down* are pulled in explicitly rather than left to compete
     * with two hundred rows the sync touched this morning.
     *
     * @param  callable(Builder<CrmContact>): Builder  $narrow
     * @return Collection<int, CrmContact>
     */
    private function candidates(string $segment, callable $narrow, int $limit, string $sort): Collection
    {
        $base = fn (): Builder => $narrow($this->query($segment));

        return match ($sort) {
            'name' => $base()->orderBy('name')->limit($limit)->get(),
            'added' => $base()->orderByDesc('created_at')->limit($limit)->get(),
            'money' => $base()
                ->orderByRaw('(coalesce(cyber_balance, 0) + coalesce(cyber_sol_balance, 0)) desc')
                ->limit($limit)
                ->get(),
            default => $base()
                ->orderByDesc('updated_at')
                ->limit($limit * 2)
                ->get()
                ->concat($base()->orderByDesc('created_at')->limit($limit)->get())
                ->unique('id'),
        };
    }

    /**
     * Put the built rows in the asked-for order.
     *
     * `signal` is the lens's own answer — what happened most recently — and
     * the other three are the ordinary questions a list has to answer for
     * somebody who knows what they are looking for. Money sorts unpriced
     * rows last rather than as zero: a balance nobody could read is not a
     * balance of nothing.
     *
     * @param  Collection<int, array<string, mixed>>  $rows
     * @return Collection<int, array<string, mixed>>
     */
    private function ordered(Collection $rows, string $sort): Collection
    {
        return match ($sort) {
            'name' => $rows->sortBy(fn (array $row) => mb_strtolower((string) $row['name'])),
            'added' => $rows->sortByDesc(fn (array $row) => (string) ($row['added'] ?? '')),
            'money' => $rows->sortByDesc(fn (array $row) => $row['usd'] ?? -1),
            default => $rows->sortByDesc(fn (array $row) => $row['signal']['at'] ?? ''),
        };
    }

    /** @return array<string, mixed> */
    private function nextStep(CrmContact $contact, ?CrmTask $task): array
    {
        $last = $contact->latestMessage;
        $kind = match (true) {
            $contact->status === 'lost' => 'closed',
            $task?->isOverdue() === true => 'overdue',
            $last?->direction === 'in' => 'reply',
            $task !== null => 'planned',
            $last !== null => 'plan',
            $contact->status === 'new' => 'first',
            default => 'plan',
        };

        return [
            'kind' => $kind,
            'last_at' => $last?->sent_at?->toIso8601String(),
            'direction' => $last?->direction,
            'task' => $task === null ? null : [
                'id' => $task->id,
                'title' => $task->title,
                'due_at' => $task->due_at?->toIso8601String(),
                'assignee' => $task->assignee?->name,
            ],
        ];
    }

    /**
     * What happened to this person, most recent first.
     *
     * Silence is a signal too, and the only one that has to be derived rather
     * than read: nothing happening is invisible in every table ever written,
     * and it is exactly what a customer looks like just before they leave.
     *
     * @param  Collection<int, CrmNote>  $notes
     * @param  Collection<int, CrmTask>  $tasks
     * @param  array{last: array<int, array<string, mixed>>, weekly: array<int, array<int, float>>}  $transfers
     * @return array<string, mixed>
     */
    private function signal(CrmContact $contact, Collection $notes, Collection $tasks, array $transfers): array
    {
        $last = $contact->latestMessage;
        $candidates = $last === null ? [] : [[
            'key' => $last->direction === 'in' ? 'people.lastIn' : 'people.lastOut',
            'at' => $last->sent_at?->toIso8601String(),
            'params' => [],
            'tone' => $last->direction === 'in' ? 'warning' : 'plain',
        ]];

        $note = $notes->get($contact->id);

        if ($note !== null) {
            $candidates[] = [
                'key' => 'signal.note',
                'at' => CarbonImmutable::parse($note->created_at)->toIso8601String(),
                'params' => ['body' => mb_substr((string) $note->body, 0, 90)],
                'tone' => 'accent',
            ];
        }

        $task = $tasks->get($contact->id);

        if ($task !== null) {
            $candidates[] = [
                'key' => $task->isOverdue() ? 'signal.taskOverdue' : 'signal.taskOpen',
                'at' => CarbonImmutable::parse($task->updated_at)->toIso8601String(),
                'params' => ['task' => $task->title, 'due' => $task->due_at?->format('d.m') ?? ''],
                'tone' => $task->isOverdue() ? 'critical' : 'accent',
            ];
        }

        $transfer = $transfers['last'][$contact->id] ?? null;

        if ($transfer !== null) {
            $candidates[] = [
                'key' => $transfer['outbound'] ? 'signal.moneyOut' : 'signal.moneyIn',
                'at' => $transfer['at'],
                'params' => [
                    'amount' => $transfer['amount'],
                    'token' => $transfer['token'],
                    'direction' => $transfer['direction'],
                ],
                'tone' => $transfer['outbound'] ? 'warning' : 'money',
            ];
        }

        if ($contact->created_at !== null) {
            $candidates[] = [
                'key' => $contact->type === 'whale' ? 'signal.becameWhale' : 'signal.appeared',
                'at' => CarbonImmutable::parse($contact->created_at)->toIso8601String(),
                'params' => ['source' => $contact->source],
                'tone' => $contact->type === 'whale' ? 'money' : 'plain',
            ];
        }

        usort($candidates, fn (array $a, array $b) => strcmp((string) $b['at'], (string) $a['at']));

        $freshest = $candidates[0] ?? [
            'key' => 'signal.nothing',
            'at' => null,
            'params' => [],
            'tone' => 'plain',
        ];

        $silence = (int) config('crm.console.silence_days', 30);
        $days = $freshest['at'] === null
            ? null
            : (int) CarbonImmutable::parse($freshest['at'])->diffInDays(CarbonImmutable::now());

        // Past the silence threshold the freshest thing on record stops being
        // the headline: "withdrew 40% three months ago" is a worse summary of
        // this person than "silent for 94 days".
        if ($days !== null && $days >= $silence) {
            return [
                'key' => 'signal.silent',
                'at' => $freshest['at'],
                'params' => ['days' => $days, 'was' => $freshest['key']],
                'tone' => 'warning',
            ];
        }

        return $freshest;
    }

    /**
     * @param  Collection<int, CrmContact>  $contacts
     * @return Collection<int, CrmNote>
     */
    private function latestNotes(Collection $contacts): Collection
    {
        return CrmNote::query()
            ->whereIn('crm_contact_id', $contacts->pluck('id'))
            ->orderByDesc('created_at')
            ->get()
            ->keyBy('crm_contact_id');
    }

    /**
     * @param  Collection<int, CrmContact>  $contacts
     * @return Collection<int, CrmTask>
     */
    private function openTasks(Collection $contacts): Collection
    {
        return CrmTask::query()
            ->active()
            ->whereIn('crm_contact_id', $contacts->pluck('id'))
            ->with('assignee:id,name')
            ->orderByRaw('due_at is null')->orderBy('due_at')->orderBy('id')
            ->get()
            ->unique('crm_contact_id')
            ->keyBy('crm_contact_id');
    }

    /**
     * The bridge ledger, folded onto the contacts by address.
     *
     * One query for the newest transfers and one for the weekly counts, so a
     * screen of forty people costs two reads rather than eighty.
     *
     * @param  Collection<int, CrmContact>  $contacts
     * @return array{last: array<int, array<string, mixed>>, weekly: array<int, array<int, float>>}
     */
    private function transfers(Collection $contacts): array
    {
        $owner = [];

        foreach ($contacts as $contact) {
            foreach (array_filter([$contact->evm_address, $contact->solana_address]) as $address) {
                $owner[mb_strtolower($address)] = $contact->id;
            }
        }

        if ($owner === []) {
            return ['last' => [], 'weekly' => []];
        }

        $addresses = array_keys($owner);

        $requests = BridgeRequest::query()
            ->where(fn ($query) => $query
                ->whereIn('sender_address', $addresses)
                ->orWhereIn('recipient_address', $addresses))
            ->where('created_at', '>=', now()->subWeeks(self::WEEKS))
            ->orderByDesc('created_at')
            ->limit(500)
            ->get(['sender_address', 'recipient_address', 'token', 'amount', 'direction', 'created_at']);

        $last = [];
        $weekly = [];
        $start = CarbonImmutable::now()->startOfWeek()->subWeeks(self::WEEKS - 1);

        foreach ($requests as $request) {
            $sender = $owner[mb_strtolower((string) $request->sender_address)] ?? null;
            $recipient = $owner[mb_strtolower((string) $request->recipient_address)] ?? null;
            $contactId = $sender ?? $recipient;

            if ($contactId === null) {
                continue;
            }

            $at = CarbonImmutable::parse($request->created_at);

            $last[$contactId] ??= [
                'at' => $at->toIso8601String(),
                'amount' => rtrim(rtrim(number_format((float) $request->amount, 4, '.', ' '), '0'), '.'),
                'token' => (string) $request->token,
                'direction' => (string) $request->direction,
                'outbound' => $sender !== null,
            ];

            $week = (int) floor($start->diffInWeeks($at));

            if ($week >= 0 && $week < self::WEEKS) {
                $weekly[$contactId] ??= array_fill(0, self::WEEKS, 0.0);
                $weekly[$contactId][$week]++;
            }
        }

        return ['last' => $last, 'weekly' => $weekly];
    }
}
