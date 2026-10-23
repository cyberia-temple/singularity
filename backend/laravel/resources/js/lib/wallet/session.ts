/**
 * The wallet's one way of becoming somebody.
 *
 * Everything else here is keyed by an address and needs no account, which is
 * the whole design: the seed is generated in the browser and this server never
 * learns whose it is. Two surfaces are the exception — the daily ledger, whose
 * subject is a *person* and not a key, and writing in the feed, which needs an
 * author — and both get there the same way: the wallet signs the site's own
 * login challenge, and the answer becomes an ordinary session cookie.
 *
 * Nothing about custody changes. What the server learns is an address that
 * proved it can sign, which is the same thing the login page learns from
 * MetaMask.
 */

export const csrfToken = (): string => {
    if (typeof document === 'undefined') {
        return '';
    }

    const match = document.cookie.match(/XSRF-TOKEN=([^;]+)/);

    return match ? decodeURIComponent(match[1]) : '';
};

/**
 * A call that carries this browser's session, and reports what came back.
 *
 * The message in a failure is the server's own where there is one: these
 * endpoints answer a refusal in words a person can act on ("you are posting
 * too fast"), and replacing that with a status code would throw away the only
 * part of the answer that helps.
 */
export const sessionCall = async <T>(
    url: string,
    init: RequestInit = {},
    fallback = 'Cyberia is unreachable right now.',
): Promise<T> => {
    const method = (init.method ?? 'GET').toUpperCase();

    const response = await fetch(url, {
        credentials: 'same-origin',
        ...init,
        method,
        headers: {
            Accept: 'application/json',
            ...(method === 'GET'
                ? {}
                : {
                      'Content-Type': 'application/json',
                      'X-XSRF-TOKEN': csrfToken(),
                  }),
            ...(init.headers as Record<string, string> | undefined),
        },
    });

    const data = (await response.json().catch(() => ({}))) as {
        message?: string;
    } & Record<string, unknown>;

    if (!response.ok) {
        const failure = new Error(data.message ?? fallback) as Error & {
            status: number;
            reason?: string;
        };
        failure.status = response.status;

        // A machine-readable refusal next to the sentence, where the endpoint
        // sends one, so a screen can say it in the reader's language.
        if (typeof data.reason === 'string') {
            failure.reason = data.reason;
        }

        throw failure;
    }

    return data as T;
};

/**
 * Sign in with the wallet: nonce, signature, session.
 *
 * The message is the site's login challenge word for word — the wallet is not
 * inventing an authentication scheme of its own, it is answering the one that
 * already exists, which is why the same signature works for a person who signs
 * in here and one who signs in with MetaMask on the login page.
 */
export const signInWithWallet = async (
    address: string,
    sign: (message: string) => Promise<string>,
): Promise<void> => {
    const { nonce } = await sessionCall<{ nonce: string }>(
        '/api/wallet/nonce',
        {
            method: 'POST',
            body: JSON.stringify({ wallet_address: address }),
        },
    );

    const signature = await sign(
        `Sign this message to authenticate with your wallet. Nonce: ${nonce}`,
    );

    const { token } = await sessionCall<{ token: string }>(
        '/api/wallet/verify',
        {
            method: 'POST',
            body: JSON.stringify({ wallet_address: address, signature }),
        },
    );

    /*
     * The token becomes a cookie session. `redirect: 'manual'` because this
     * endpoint answers with a redirect to wherever the user came from, and
     * following it would download a whole page nobody is going to look at —
     * the cookie is already set by the time the redirect is written.
     */
    const response = await fetch('/login/web3', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-XSRF-TOKEN': csrfToken(),
        },
        body: JSON.stringify({ token }),
    });

    // An opaque redirect is the success case here; only a real error status is
    // a failure, and `type === 'opaqueredirect'` reports `ok: false`.
    if (!response.ok && response.type !== 'opaqueredirect') {
        throw new Error('Signing in with this wallet failed.');
    }
};
