/**
 * The app's side of the page counter (Umami on this host, see
 * `App\Support\WebStats`). Page views count themselves; what only the app
 * knows is which product events happened, so each one is mirrored as a named
 * event and the dashboard's funnels and goals can be built from the wallet's
 * own milestones. The properties are the ones the analytics allowlist
 * already let through. With no counter on the page this does nothing.
 */
type Umami = {
    track(
        event: string,
        data?: Record<string, string | number | boolean>,
    ): unknown;
};

declare global {
    interface Window {
        umami?: Umami;
    }
}

export const statsEvent = (
    name: string,
    data: Record<string, string | number | boolean> = {},
): void => {
    try {
        if (typeof window === 'undefined') {
            return;
        }

        window.umami?.track(
            name,
            Object.keys(data).length > 0 ? data : undefined,
        );
    } catch {
        /* The counter is never the reason something failed. */
    }
};
