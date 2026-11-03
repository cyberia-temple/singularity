const ENDPOINT = 'https://cyberia.church/api/extension/analytics';

// Send only an installation identifier and the fact that the wallet was opened.
// Firefox exposes optional analytics consent through its permissions API.
export async function trackExtensionOpen() {
    try {
        if (typeof chrome.runtime.getBrowserInfo === 'function') {
            const permissions = await chrome.permissions.getAll();
            if (!permissions.data_collection?.includes('technicalAndInteraction')) return;
        }

        const stored = await chrome.storage.local.get('analyticsClientId');
        const clientId = stored.analyticsClientId || crypto.randomUUID();
        if (!stored.analyticsClientId) await chrome.storage.local.set({ analyticsClientId: clientId });

        await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({ client_id: clientId }),
        });
    } catch {
        // Analytics must never interfere with the wallet.
    }
}
