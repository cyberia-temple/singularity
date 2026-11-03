/**
 * What a scanned QR code says, for the two places a camera feeds: the send
 * form's recipient and "open a chat with this address".
 *
 * Wallets put an address in a QR code three ways: bare (`0xabc…`), as an
 * EIP-681 payment link (`ethereum:0xabc…@8453?value=…`, the `pay-` prefix
 * included), or as a scheme of the chain (`bitcoin:bc1…?amount=…`,
 * `solana:…`). Only the address is taken: an amount or a contract call inside
 * a code is somebody else's choice of what to sign, and the form is where the
 * person makes that choice themselves.
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

    const scheme = /^([a-z]+):(?:\/\/)?(.+)$/i.exec(text);

    if (scheme === null) {
        return null;
    }

    const name = scheme[1].toLowerCase();
    const body = scheme[2].split('?')[0];

    if (name === 'ethereum') {
        // EIP-681: ethereum:[pay-]<address>[@<chainId>][/<function>]
        const match = /^(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/.*)?$/.exec(
            body,
        );

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
