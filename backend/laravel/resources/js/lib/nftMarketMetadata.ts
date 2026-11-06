/** Public gateways are independent; a failed gateway must not hide the NFT. */
export function nftMetadataUrls(uri: string, gateway: string): string[] {
    if (!uri.startsWith('ipfs://')) return [uri];
    const path = uri.slice(7).replace(/^ipfs\//, '');
    return [
        ...new Set([
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
