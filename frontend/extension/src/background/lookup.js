/**
 * What the wallet does with text that is not a request from a page: an
 * address, a transaction hash, a block number or a `.cyber` name the person
 * selected on any site (context menu) or typed after `cy` in the address bar
 * (omnibox). Every answer is a link to open — nothing here signs, reads a
 * balance or sends the text anywhere but the page it opens.
 */

const EXPLORER = 'https://explorer.cyberia.church';
const SITE = 'https://cyberia.church';

/** @returns {{ kind: 'address'|'tx'|'block'|'domain'|'search', value: string }} */
export function classify(raw) {
    const text = String(raw ?? '').trim();

    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
        return { kind: 'address', value: text };
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(text)) {
        return { kind: 'tx', value: text.toLowerCase() };
    }
    if (/^#?\d{1,12}$/.test(text)) {
        return { kind: 'block', value: text.replace('#', '') };
    }
    if (/^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/i.test(text) && text.toLowerCase().endsWith('.cyber')) {
        return { kind: 'domain', value: text.toLowerCase() };
    }

    return { kind: 'search', value: text.slice(0, 200) };
}

/** Where a classified selection opens. Search is the explorer's own. */
export function lookupUrl({ kind, value }) {
    switch (kind) {
        case 'address':
            return `${EXPLORER}/address/${value}`;
        case 'tx':
            return `${EXPLORER}/tx/${value}`;
        case 'block':
            return `${EXPLORER}/block/${value}`;
        case 'domain':
            return `${SITE}/wallet?section=domains&name=${encodeURIComponent(value)}`;
        default:
            return `${EXPLORER}/search-results?q=${encodeURIComponent(value)}`;
    }
}

const LABEL = {
    address: 'Address on the Cyberia explorer',
    tx: 'Transaction on the Cyberia explorer',
    block: 'Block on the Cyberia explorer',
    domain: '.cyber domain in the wallet',
    search: 'Search the Cyberia explorer',
};

/** What the omnibox suggests for what was typed so far. */
export function suggestion(text) {
    const classified = classify(text);
    const escape = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

    return {
        content: lookupUrl(classified),
        description: `${LABEL[classified.kind]}: <match>${escape(classified.value)}</match>`,
    };
}

/** A typed or chosen omnibox entry → the URL to open (only ours). */
export function omniboxTarget(input) {
    const text = String(input ?? '').trim();

    if (text.startsWith(`${EXPLORER}/`) || text.startsWith(`${SITE}/`)) {
        return text;
    }

    return lookupUrl(classify(text));
}
