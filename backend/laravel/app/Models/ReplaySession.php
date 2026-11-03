<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use InvalidArgumentException;

/**
 * One recorded tab: counters here, rrweb's events in gzip chunks on the
 * private disk (`replay/<id>/<seq>.json.gz`). See the replay migration.
 */
class ReplaySession extends Model
{
    protected $keyType = 'string';

    public $incrementing = false;

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
            'started_ms' => 'integer',
            'duration_ms' => 'integer',
            'viewport_width' => 'integer',
            'viewport_height' => 'integer',
            'pages' => 'integer',
            'clicks' => 'integer',
            'rage_clicks' => 'integer',
            'dead_clicks' => 'integer',
            'errors' => 'integer',
            'chunks' => 'integer',
            'bytes' => 'integer',
        ];
    }

    public static function directory(string $id): string
    {
        // The id becomes a path, and a path is what gets deleted.
        if (! Str::isUuid($id)) {
            throw new InvalidArgumentException('A replay session id is a UUID.');
        }

        return 'replay/'.$id;
    }

    public static function chunkPath(string $id, int $seq): string
    {
        return self::directory($id).'/'.$seq.'.json.gz';
    }

    /**
     * The whole recording as one JSON array, chunk after chunk in the order
     * they were sent — or one chunk. Spliced as text rather than decoded: a
     * session is tens of megabytes of mouse moves, and PHP arrays of them
     * would be ten times that.
     */
    public function eventsJson(?int $onlySeq = null): string
    {
        $disk = Storage::disk('local');
        $parts = collect($disk->files(self::directory($this->id)))
            ->map(fn (string $file) => (int) basename($file, '.json.gz'))
            ->when($onlySeq !== null, fn ($seqs) => $seqs->filter(fn (int $seq) => $seq === $onlySeq))
            ->sort()
            ->map(fn (int $seq) => trim((string) gzdecode((string) $disk->get(self::chunkPath($this->id, $seq)))))
            ->map(fn (string $chunk) => substr($chunk, 1, -1))
            ->filter(fn (string $inner) => trim($inner) !== '');

        return '['.$parts->implode(',').']';
    }

    /** Forget the recording: its files and every row that points at them. */
    public function forget(): void
    {
        Storage::disk('local')->deleteDirectory(self::directory($this->id));

        foreach (['replay_pages', 'replay_clicks', 'replay_errors'] as $table) {
            DB::table($table)->where('session_id', $this->id)->delete();
        }

        $this->delete();
    }
}
