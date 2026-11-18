/** Public gateways are independent; a failed gateway must not hide the NFT. */
export function nftMetadataUrls(uri: string, gateway: string): string[] {
    if (!uri.startsWith('ipfs://')) return [uri];
    const path = uri.slice(7).replace(/^ipfs\//, '');
    // This site's own node first, for a bare CID: it has every token it
    // pinned and answers at once, where public gateways rate-limit (nginx
    // serves /ipfs/<cid> from the local Kubo store only).
    const own = /^[A-Za-z0-9]{46,100}$/.test(path) ? ['/ipfs/'] : [];

    return [
        ...new Set([
            ...own,
            gateway,
            'https://gateway.pinata.cloud/ipfs/',
            'https://ipfs.io/ipfs/',
        ]),
    ].map((base) => `${base.replace(/\/+$/, '')}/${path}`);
}

export function nftExternalUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:'
            ? url.href
            : null;
    } catch {
        return null;
    }
}
