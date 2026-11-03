<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Session recordings
    |--------------------------------------------------------------------------
    |
    | rrweb in the browser, this server at the other end: replays, click heat
    | maps, rage and dead clicks and JavaScript errors, read in the console at
    | /crm/replays. Nothing goes to a third party — that is the whole reason
    | this exists instead of a hosted tool.
    |
    | Off means no page carries the recorder and the ingest answers 404, which
    | the recorder takes as "stop".
    |
    */

    'enabled' => (bool) env('REPLAY_ENABLED', true),

    /*
    | Which sites may send recordings, by host (a leading "www." is ignored).
    | The browser names the page's origin itself, so a recording claiming to
    | come from somewhere else is refused rather than filed under it.
    | This app's own host is always accepted.
    */

    'sites' => array_values(array_filter(array_map('trim', explode(',', (string) env(
        'REPLAY_SITES',
        'cyberia.church,lain-os.com,chaos.fm',
    ))))),

    /*
    | Paths on which nothing is recorded, by prefix: two-factor secrets,
    | recovery codes and the console's contacts live there. Paused rather than
    | masked, because a dialog teleported to <body> escapes any masked root.
    */

    'paused_paths' => ['/crm', '/settings', '/teams', '/admin'],

    /*
    | How long a recording is kept. `replay:prune` deletes the rest daily —
    | the files and every row that points at them.
    */

    'keep_days' => (int) env('REPLAY_KEEP_DAYS', 30),

    /*
    | Size caps. A chunk is what one request carries (about ten seconds, or
    | the first snapshot of a page); a session that outgrows its cap is told
    | to stop rather than left to fill the disk.
    */

    'max_chunk_bytes' => 2 * 1024 * 1024,

    'max_unpacked_bytes' => 12 * 1024 * 1024,

    'max_session_bytes' => (int) env('REPLAY_MAX_SESSION_MB', 40) * 1024 * 1024,

];
