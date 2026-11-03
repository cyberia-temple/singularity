/**
 * Small pieces shared by the console's recording screens
 * (`pages/crm/Replays.vue`, `Replay.vue`, `Heatmap.vue`).
 */

/** A recording's length as m:ss, or h:mm:ss past an hour. */
export function length(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

export type ReplayEvent = {
    type: number;
    timestamp: number;
    data: Record<string, unknown>;
};

const FULL_SNAPSHOT = 2;
const META = 4;

/**
 * The two events that draw one page as it stood: the full snapshot taken at
 * `at` and the meta event in front of it (which carries the width and height
 * the page was drawn at). Null when the chunk holds no snapshot.
 */
export function pageSnapshot(
    events: ReplayEvent[],
    at: number,
): [ReplayEvent, ReplayEvent] | null {
    const index = events.findIndex(
        (event) => event.type === FULL_SNAPSHOT && event.timestamp === at,
    );
    const snapshot =
        index >= 0
            ? index
            : events.findIndex((event) => event.type === FULL_SNAPSHOT);

    if (snapshot < 0) {
        return null;
    }

    const meta = events
        .slice(0, snapshot)
        .reverse()
        .find((event) => event.type === META);

    if (!meta) {
        return null;
    }

    const full = events[snapshot];

    // One instant, so the replayer applies both before it draws anything.
    return [{ ...meta, timestamp: full.timestamp }, full];
}
