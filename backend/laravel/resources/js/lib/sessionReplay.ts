/**
 * The app's side of session recording.
 *
 * The recorder itself is `resources/js/replay/recorder.ts`, loaded as its own
 * script by `resources/views/partials/session-replay.blade.php` only when the
 * server decided this visit may be recorded — never for an operator, a store
 * build, the desktop shell or a browser saying Do Not Track. When it decided
 * not to there is no `window.cyberiaReplay` and every function here does
 * nothing. The recorder follows navigation and pauses on its own; what only
 * the app knows is which product events happened, so a recording can be
 * found by "the swap failed" rather than by guessing.
 */
type CyberiaReplay = {
    recording(): boolean;
    stop(): void;
    event(name: string): void;
};

declare global {
    interface Window {
        cyberiaReplay?: CyberiaReplay;
    }
}

const replay = (): CyberiaReplay | undefined =>
    typeof window === 'undefined' ? undefined : window.cyberiaReplay;

/** A product event, by name only: its properties stay with our own tables. */
export const replayEvent = (name: string): void => {
    replay()?.event(name);
};

/**
 * Wallet → Security's switch, which covers recordings too. Turning it off
 * stops this page and forgets the session; turning it back on takes effect
 * from the next page load, because a recording resumed halfway through a
 * page has nothing to draw it on.
 */
export const setReplayEnabled = (on: boolean): void => {
    if (!on) {
        replay()?.stop();
    }
};

/** The refusal given on the recorder's own notice. */
export const onReplayRefused = (handler: () => void): void => {
    if (typeof window !== 'undefined') {
        window.addEventListener('cyberia:replay-refused', handler);
    }
};
