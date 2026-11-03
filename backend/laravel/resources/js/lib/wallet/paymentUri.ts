/**
 * What a scanned QR code says, for the two places a camera feeds: the send
 * form's recipient and "open a chat with this address".
 *
 * Wallets put an address in a QR code three ways: bare (`0xabc…`), as an
 * EIP-681 payment link (`ethereum:0xabc…@8453?value=…`, the `pay-` prefix
 * included), or as a scheme of the chain (`bitcoin:bc1…?amount=…`,
 * `solana:…`). Only the address is taken: an amount inside a code is somebody
 * else's choice of what to sign, and the form is where the person makes that
 * choice themselves. A code that names a contract call (`ethereum:<token>/
 * transfer?address=<recipient>`) is refused outright: the address in front of
 * the call is the token contract, and taking it as the recipient would send
 * the money to the contract.
 */

export interface ScannedPayment {
    /** The address, as the code carried it (EVM addresses lower-cased). */
    address: string;
    family: 'evm' | 'bitcoin' | 'litecoin' | 'solana' | 'monero';
    /** EIP-681's `@chainId`, when the code named one. */
    chainId: number | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parsePaymentUri(raw: string): ScannedPayment | null {
    const text = raw.trim();

    if (EVM.test(text)) {
        return { address: text.toLowerCase(), family: 'evm', chainId: null };
    }

    const plain = bareAddress(text);

    if (plain !== null) {
        return plain;
    }

    const scheme = /^([a-z]+):(?:\/\/)?(.+)$/i.exec(text);

    if (scheme === null) {
        return null;
    }

    const name = scheme[1].toLowerCase();
    const body = scheme[2].split('?')[0];

    if (name === 'ethereum') {
        // EIP-681: ethereum:[pay-]<address>[@<chainId>] — and no /<function>.
        const match = /^(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?$/.exec(body);

        return match === null
            ? null
            : {
                  address: match[1].toLowerCase(),
                  family: 'evm',
                  chainId: match[2] === undefined ? null : Number(match[2]),
              };
    }

    if (name === 'bitcoin' && /^(bc1|[13])[0-9a-zA-Z]{20,90}$/.test(body)) {
        return { address: body, family: 'bitcoin', chainId: null };
    }

    if (name === 'litecoin' && /^(ltc1|[LM3])[0-9a-zA-Z]{20,90}$/.test(body)) {
        return { address: body, family: 'litecoin', chainId: null };
    }

    if (name === 'solana' && BASE58.test(body)) {
        return { address: body, family: 'solana', chainId: null };
    }

    if (name === 'monero' && /^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(body)) {
        return { address: body, family: 'monero', chainId: null };
    }

    return null;
}

/**
 * A bare address of the other chains, as the wallet's own Receive screen draws
 * it. Which chain it belongs to is a guess from its shape (a short base58
 * string can be read several ways); the send form then checks it against the
 * network it is on, exactly as it checks a typed address.
 */
function bareAddress(text: string): ScannedPayment | null {
    const of = (family: ScannedPayment['family']): ScannedPayment => ({
        address: text,
        family,
        chainId: null,
    });

    if (/^bc1[0-9a-z]{20,90}$/i.test(text)) {
        return of('bitcoin');
    }

    if (/^ltc1[0-9a-z]{20,90}$/i.test(text)) {
        return of('litecoin');
    }

    if (/^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(text)) {
        return of('monero');
    }

    if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(text)) {
        return of('bitcoin');
    }

    if (/^[LM][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(text)) {
        return of('litecoin');
    }

    return BASE58.test(text) ? of('solana') : null;
}
