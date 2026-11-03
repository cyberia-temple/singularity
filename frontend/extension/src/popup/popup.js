/**
 * The popup: 348 pixels of the design system, and every decision in the wallet
 * that needs a person.
 *
 * It renders from one state object fetched from the service worker and holds
 * nothing of its own — no key, no phrase, no cached balance. Closing it loses
 * nothing, which is what lets a signature prompt live in its own window while
 * the toolbar popup stays disposable.
 *
 * Rendered as strings with every value escaped on the way in. The popup shows
 * text it did not write — a site's host name, a token's symbol, a message a
 * page asked to have signed — and a request that can draw its own UI here
 * would be a request that can fake this one.
 */
import { POPUP } from '../shared/protocol.js';
import { SITE_URL, chainById } from '../shared/chains.js';
import { renderInto } from '../shared/dom.js';
import { permissionPattern } from '../shared/origins.js';
import { formatFiat, formatUnits, initials, parseUnits, shortAddress, toDecimal } from '../shared/format.js';
import { describeSignature, describeTypedData } from '../shared/tx.js';
import { RELAY_MODES } from '../background/relay.js';
import { trackExtensionOpen } from '../shared/analytics.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const isApprovalWindow = params.get('view') === 'request';

if (isApprovalWindow) {
    document.body.classList.add('cw-window');
}

/** How long a hold-to-sign has to be held. Long enough not to be a slip. */
const HOLD_MS = 900;

let state = null;
let money = null;
let activeOrigin = null;
let activeTabId = null;
let view = 'home';
let notice = '';
let draft = { to: '', amount: '', password: '', host: '', port: '' };
let chosenAccounts = new Set();
let sent = null;

const ask = (type, payload = {}) => chrome.runtime.sendMessage({ type, payload });

const esc = (value) =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (character) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );

/* ----------------------------------------------------------------- pieces --- */

const head = () => {
    const account = state.accounts.find((entry) => entry.active) ?? state.accounts[0];
    const chain = chainById(state.chainId);

    return `
        <div class="cw-head">
            <div class="cw-mark${state.locked ? ' is-locked' : ''}"></div>
            <button class="cw-who" data-go="accounts" ${state.locked ? 'disabled' : ''}>
                <div class="cw-who-name">${esc(account?.name ?? 'Cyberia Wallet')}</div>
                <div class="cw-who-addr">${esc(account ? shortAddress(account.address) : 'LOCKED')}</div>
            </button>
            <button class="cw-chip" data-go="chains" ${state.locked ? 'disabled' : ''}>${esc(chain?.id ?? '')}</button>
        </div>`;
};

const foot = () => {
    const relay = state.relay ?? { mode: 'direct' };
    // Gecko routes the wallet's own requests as soon as a relay is picked;
    // Chromium routes nothing until the browser-wide switch is on.
    const direct =
        relay.mode === 'direct' || (state.relayScope !== 'wallet' && !relay.routeBrowser);
    const label = direct
        ? 'DIRECT · NO RELAY'
        : `${RELAY_MODES[relay.mode]?.label ?? 'RELAY'} · ${relay.mode === 'tor' ? '3 HOPS' : '1 HOP'}`;

    return `
        <div class="cw-foot">
            <button class="cw-foot-pill${direct ? ' is-direct' : ''}" data-go="relay">
                <span class="cw-dot${direct ? ' is-warn' : ' is-ok'}"></span>${esc(label)}
            </button>
            <span class="cw-foot-note">KEYS ON DEVICE</span>
        </div>`;
};

const back = (target = 'home') => `<button class="cw-back" data-go="${target}">← BACK</button>`;

const rows = (items) => `<div class="cw-rows">${items.join('')}</div>`;

const factRow = (key, value) =>
    `<div class="cw-row is-tight"><span class="cw-key">${esc(key)}</span><span class="cw-val">${esc(value)}</span></div>`;

const noticeLine = () => (notice ? `<div class="cw-error">${esc(notice)}</div>` : '');

const holdButton = (action, label, disabled = false) => `
    <button class="cw-hold" data-hold="${action}" ${disabled ? 'disabled' : ''}
        aria-label="${esc(label)} — press and hold, or hold Space" aria-describedby="cw-hold-status">
        <span class="cw-hold-fill"></span>
        <span class="cw-hold-label">${esc(label)}</span>
    </button>
    <span id="cw-hold-status" class="cw-sr" aria-live="polite"></span>`;

/** "Request 2 of 3" — the queue is visible, so nothing is signed out of order unseen. */
const queueLine = () =>
    state.requests.length > 1
        ? `<div class="cw-label" style="margin-bottom:8px">REQUEST 1 OF ${state.requests.length}</div>`
        : '';

/** Reject is focused when a request opens, and Esc means it too. Enter never signs. */
const rejectButton = (style = 'margin-top:8px') =>
    `<button class="cw-btn" style="${style}" data-resolve="reject" data-autofocus-reject>REJECT</button>`;

/* ------------------------------------------------------------------ views --- */

const setupView = () => `
    <div class="cw-body cw-center">
        <div class="cw-mark" style="margin-bottom:18px"></div>
        <h1 class="cw-title">One key. Every EVM chain. Your custody.</h1>
        <div class="cw-sub">NO ACCOUNT · NO EMAIL · NO RECOVERY SERVICE</div>
        <button class="cw-btn is-primary" data-do="onboard">SET UP WALLET</button>
        <div class="cw-note" style="text-align:left">
            The phrase is generated on this device, encrypted with your password and never
            sent anywhere. You can import the phrase you already use on cyberia.church.
        </div>
    </div>`;

const lockedView = () => {
    const waiting = state.requests.length;

    return `
        <div class="cw-body cw-center">
            <div class="cw-lock-glyph">▢</div>
            <div class="cw-label" style="margin-bottom:10px">VAULT LOCKED</div>
            <h1 class="cw-title">Enter your password</h1>
            <div class="cw-sub">AUTO-LOCKED AFTER ${esc(state.autoLockMinutes)} MIN${waiting ? ' · SITE REQUEST WAITING' : ''}</div>
            <input class="cw-input" type="password" data-field="password" placeholder="••••••••" value="${esc(draft.password)}" autofocus />
            <button class="cw-btn is-primary" style="margin-top:8px" data-do="unlock">UNLOCK</button>
            ${noticeLine()}
            ${
                waiting
                    ? `<div class="cw-note" style="text-align:left">${esc(
                          hostOf(state.requests[0].origin),
                      )} is waiting. It stays queued — unlocking does not approve it.</div>`
                    : ''
            }
        </div>`;
};

const hostOf = (origin) => {
    try {
        return new URL(origin).host;
    } catch {
        return origin ?? '';
    }
};

const totals = () => {
    const chain = chainById(state.chainId);

    if (!money || money.locked) {
        return { fiat: '—', native: '—', partial: true };
    }

    const native = money.balance === null ? null : toDecimal(money.balance, chain.decimals);
    const priced = native !== null && money.nativePrice !== null ? native * money.nativePrice : null;
    const tokenValue = money.tokens.reduce(
        (sum, token) =>
            token.price === null ? sum : sum + toDecimal(token.balance, token.decimals) * token.price,
        0,
    );

    const unpriced =
        money.nativePrice === null || money.tokens.some((token) => token.price === null);

    return {
        fiat: priced === null && tokenValue === 0 ? '—' : formatFiat((priced ?? 0) + tokenValue),
        native:
            money.balance === null
                ? 'unavailable'
                : `${formatUnits(money.balance, chain.decimals)} ${chain.symbol}`,
        partial: unpriced,
    };
};

const homeView = () => {
    const chain = chainById(state.chainId);
    const sum = totals();
    const connected = state.grants.find((grant) => grant.origin === activeOrigin);

    const tokenRows = [
        `<div class="cw-row">
            <span class="cw-coin">${esc(initials(chain.symbol))}</span>
            <span class="cw-grow">
                <span class="cw-sym">${esc(chain.symbol)}</span>
                <span class="cw-name">${esc(chain.name)} · native</span>
            </span>
            <span class="cw-amount">
                <span class="cw-amount-main">${esc(sum.native)}</span>
                <span class="cw-amount-sub">${esc(
                    money?.nativePrice && money?.balance !== null
                        ? formatFiat(toDecimal(money.balance, chain.decimals) * money.nativePrice)
                        : '—',
                )}</span>
            </span>
        </div>`,
        ...(money?.tokens ?? []).map(
            (token) => `
            <div class="cw-row">
                <span class="cw-coin is-token">${esc(initials(token.symbol))}</span>
                <span class="cw-grow">
                    <span class="cw-sym">${esc(token.symbol)}</span>
                    <span class="cw-name">${esc(token.name)}</span>
                </span>
                <span class="cw-amount">
                    <span class="cw-amount-main">${esc(formatUnits(token.balance, token.decimals))}</span>
                    <span class="cw-amount-sub">${esc(
                        token.price === null
                            ? '—'
                            : formatFiat(toDecimal(token.balance, token.decimals) * token.price),
                    )}</span>
                </span>
            </div>`,
        ),
    ];

    return `
        <div class="cw-body">
            <div class="cw-label">TOTAL VALUE</div>
            <div class="cw-total">${esc(sum.fiat)}</div>
            <div class="cw-total-sub">${esc(sum.native)}${sum.partial ? ' · PARTIAL, SOME PRICES UNREAD' : ''}</div>

            <div class="cw-actions">
                <button class="cw-tile" data-go="send"><span class="cw-tile-glyph">↑</span><span class="cw-tile-label">SEND</span></button>
                <button class="cw-tile" data-go="receive"><span class="cw-tile-glyph">↓</span><span class="cw-tile-label">RECEIVE</span></button>
                <button class="cw-tile" data-site="/bridge"><span class="cw-tile-glyph">⇄</span><span class="cw-tile-label">BRIDGE</span></button>
                <button class="cw-tile" data-site="/staking"><span class="cw-tile-glyph">◇</span><span class="cw-tile-label">EARN</span></button>
            </div>

            ${
                state.networkGranted
                    ? ''
                    : `<div class="cw-note is-warn" style="margin-top:16px">
                            This browser has not let the wallet reach the chains yet, so every
                            balance here is unread.
                            <button class="cw-link" style="display:block;margin-top:9px;color:var(--cw-accent)" data-do="grant-network">ALLOW RPC ACCESS</button>
                       </div>`
            }

            <div class="cw-label cw-section">TOKENS</div>
            ${rows(tokenRows)}
            ${money?.tokensNote ? `<div class="cw-note">${esc(money.tokensNote)}</div>` : ''}
            ${money?.balanceError ? `<div class="cw-note is-warn">${esc(money.balanceError)}</div>` : ''}

            <div class="cw-row" style="margin-top:14px;border:1px solid var(--cw-line-2)">
                <span class="cw-dot${connected ? ' is-ok' : ''}"></span>
                <span class="cw-grow cw-key">${esc(
                    connected ? 'CONNECTED TO THIS SITE' : activeOrigin ? 'NOT CONNECTED HERE' : 'NO SITE IN THIS TAB',
                )}</span>
                ${
                    connected
                        ? '<button class="cw-link" data-do="revoke-active">DISCONNECT</button>'
                        : permissionPattern(activeOrigin ?? '')
                          ? '<button class="cw-link" data-do="connect-active">CONNECT</button>'
                          : `<button class="cw-link is-quiet" data-go="sites">${esc(state.grants.length)} SITES</button>`
                }
            </div>
            ${noticeLine()}
        </div>`;
};

const receiveView = () => {
    const account = state.accounts.find((entry) => entry.active) ?? state.accounts[0];
    const chain = chainById(state.chainId);

    return `
        <div class="cw-body">
            ${back()}
            <div class="cw-label">RECEIVE ON ${esc(chain.name.toUpperCase())}</div>
            <div class="cw-addr">${esc(account.address)}</div>
            <button class="cw-btn" style="margin-top:8px" data-do="copy" data-value="${esc(account.address)}">⧉ COPY ADDRESS</button>
            <div class="cw-note">
                Only assets on ${esc(chain.name)} (chain ${esc(chain.id)}) arrive here. The same address
                works for every EVM network in this wallet — the network is what differs, not the address.
            </div>
            ${noticeLine()}
        </div>`;
};

/**
 * What the send screen makes of what has been typed so far.
 *
 * Shared by the render and by the repaint that runs on each keystroke, so the
 * button can never disagree with the form it belongs to.
 */
const sendState = () => {
    const chain = chainById(state.chainId);
    const amount = parseUnits(draft.amount, chain.decimals);
    // A balance that could not be read is unknown, not zero — saying "more than
    // you hold" when the RPC is down accuses the user of something untrue.
    const known = money && money.balance !== null && money.balance !== undefined;
    const balance = known ? BigInt(money.balance) : null;
    const overdrawn = known && amount !== null && amount > balance;

    return {
        chain,
        amount,
        known,
        balance,
        overdrawn,
        ready: known && Boolean(draft.to) && amount !== null && amount > 0n && !overdrawn,
        label: !known
            ? 'BALANCE UNREADABLE — RPC UNREACHABLE'
            : overdrawn
              ? 'MORE THAN YOU HOLD'
              : 'HOLD TO SIGN',
    };
};

const sendView = () => {
    const { chain, known, balance, overdrawn, ready, label } = sendState();

    return `
        <div class="cw-body">
            ${back()}
            <div class="cw-label">SEND ${esc(chain.symbol)}</div>
            <div class="cw-field">
                <label class="cw-field-label">TO ADDRESS</label>
                <input class="cw-input" data-field="to" placeholder="0x…" value="${esc(draft.to)}" />
            </div>
            <div class="cw-field">
                <label class="cw-field-label">AMOUNT · BALANCE ${esc(known ? formatUnits(balance, chain.decimals) : 'UNREAD')}</label>
                <input class="cw-input${overdrawn ? ' is-bad' : ''}" data-field="amount" placeholder="0.0000" value="${esc(draft.amount)}" />
            </div>
            <div class="cw-note">
                The network fee is read from the chain when you sign, and the wallet signs for no
                more than it quotes. Fees are paid in ${esc(chain.symbol)}.
            </div>
            ${holdButton('send', label, !ready)}
            ${noticeLine()}
        </div>`;
};

const sentView = () => `
    <div class="cw-body">
        ${back()}
        <div class="cw-label is-accent">BROADCAST</div>
        <div class="cw-headline is-ok">SENT</div>
        <div class="cw-addr">${esc(sent.hash)}</div>
        <button class="cw-btn" style="margin-top:8px" data-open="${esc(sent.explorer)}">OPEN IN EXPLORER</button>
    </div>`;

const accountsView = () => `
    <div class="cw-body">
        ${back()}
        <div class="cw-label">ACCOUNTS · ONE PHRASE</div>
        ${rows(
            state.accounts.map(
                (account) => `
            <button class="cw-row${account.active ? ' is-active' : ''}" data-pick-account="${esc(account.index)}">
                <span class="cw-grow">
                    <span class="cw-sym">${esc(account.name)}</span>
                    <span class="cw-name">${esc(account.path)}</span>
                </span>
                <span class="cw-pick-addr">${esc(shortAddress(account.address))}</span>
            </button>`,
            ),
        )}
        <button class="cw-btn" style="margin-top:10px" data-do="add-account">DERIVE NEXT ACCOUNT</button>

        <div class="cw-label cw-section">AUTO-LOCK</div>
        <div class="cw-modes">
            ${[5, 15, 60]
                .map(
                    (minutes) => `
                <button class="cw-mode${state.autoLockMinutes === minutes ? ' is-on' : ''}" data-lock-minutes="${minutes}">
                    <span class="cw-mode-label">${minutes} MIN</span>
                    <span class="cw-mode-sub">${minutes === 5 ? 'strict' : minutes === 15 ? 'default' : 'relaxed'}</span>
                </button>`,
                )
                .join('')}
            <button class="cw-mode" data-do="lock"><span class="cw-mode-label">LOCK NOW</span><span class="cw-mode-sub">drop the key</span></button>
        </div>

        <div class="cw-note is-bad">
            Removing this wallet erases the encrypted vault from this browser. Without your
            phrase written down, the accounts are gone with it.
            <button class="cw-link" style="display:block;margin-top:9px" data-do="forget">REMOVE THIS WALLET</button>
        </div>
        ${noticeLine()}
    </div>`;

const chainsView = () => `
    <div class="cw-body">
        ${back()}
        <div class="cw-label">NETWORK</div>
        ${rows(
            state.chains.map(
                (chain) => `
            <button class="cw-row${chain.id === state.chainId ? ' is-active' : ''}" data-pick-chain="${esc(chain.id)}">
                <span class="cw-coin" style="border-color:${esc(chain.color)};color:${esc(chain.color)}">${esc(chain.tag)}</span>
                <span class="cw-grow">
                    <span class="cw-sym">${esc(chain.name)}</span>
                    <span class="cw-name">chain ${esc(chain.id)} · ${esc(chain.symbol)}</span>
                </span>
            </button>`,
            ),
        )}
        <div class="cw-note">
            The same accounts on every network here. Adding a network is done in the wallet on
            the site — a page cannot add one, because that would let it choose which endpoint
            sees your addresses.
        </div>
    </div>`;

const sitesView = () => `
    <div class="cw-body">
        ${back()}
        <div class="cw-label">CONNECTED SITES · ${esc(state.grants.length)}</div>
        ${
            state.grants.length === 0
                ? '<div class="cw-note">No site has been granted an account. The provider is not injected anywhere.</div>'
                : rows(
                      state.grants.map(
                          (grant) => `
                <div class="cw-row">
                    <span class="cw-grow">
                        <span class="cw-sym">${esc(hostOf(grant.origin))}</span>
                        <span class="cw-name">${esc(grant.accounts.map((address) => shortAddress(address)).join(' · '))}</span>
                    </span>
                    <button class="cw-link" data-revoke="${esc(grant.origin)}">REVOKE</button>
                </div>`,
                      ),
                  )
        }
        <div class="cw-note">
            A revoked site loses the provider on its next page load, and any request it left
            waiting is rejected now.
        </div>
        ${noticeLine()}
    </div>`;

const relayView = () => {
    const relay = state.relay;
    const mode = RELAY_MODES[relay.mode] ?? RELAY_MODES.direct;
    // On Gecko a chosen relay is already carrying the wallet's own traffic; on
    // Chromium nothing moves until the browser-wide switch is on.
    const walletScope = state.relayScope === 'wallet';
    const routed = relay.mode !== 'direct' && (walletScope || relay.routeBrowser);

    return `
        <div class="cw-body">
            ${back()}
            <div class="cw-label">RELAY</div>
            <div class="cw-panel" style="border-color:${routed ? 'rgb(91 214 160 / 30%)' : 'rgb(232 180 74 / 34%)'}">
                <div style="display:flex;align-items:center;gap:8px">
                    <span class="cw-dot${routed ? ' is-ok' : ' is-warn'}"></span>
                    <span class="cw-label${routed ? '' : ' is-warn'}">${esc(
                        routed
                            ? `${mode.label} · ${walletScope && !relay.routeBrowser ? 'WALLET TRAFFIC' : 'WHOLE BROWSER'}`
                            : 'NO RELAY',
                    )}</span>
                </div>
                <div style="font:400 10px/1.5 var(--cw-sans);color:var(--cw-soft);margin-top:9px">
                    ${
                        routed
                            ? 'Every request fails rather than falling back to your own line if the daemon stops answering.'
                            : 'Every endpoint you query sees your IP next to your addresses. Balance polling alone is enough to link them.'
                    }
                </div>
            </div>

            <div class="cw-modes">
                ${Object.entries(RELAY_MODES)
                    .map(
                        ([key, entry]) => `
                    <button class="cw-mode${relay.mode === key ? ' is-on' : ''}" data-relay-mode="${esc(key)}">
                        <span class="cw-mode-label">${esc(entry.label)}</span>
                        <span class="cw-mode-sub">${esc(entry.sub)}</span>
                    </button>`,
                    )
                    .join('')}
            </div>

            ${
                relay.mode === 'socks5'
                    ? `<div class="cw-field">
                            <label class="cw-field-label">SOCKS5 DAEMON</label>
                            <div style="display:flex;gap:6px">
                                <input class="cw-input" data-field="host" value="${esc(draft.host || relay.host)}" placeholder="127.0.0.1" />
                                <input class="cw-input" style="width:96px" data-field="port" value="${esc(draft.port || relay.port)}" placeholder="1080" />
                            </div>
                       </div>`
                    : ''
            }

            ${rows([
                ...(walletScope
                    ? [
                          `<div class="cw-row is-tight">
                            <span class="cw-grow" style="font:400 10px/1.35 var(--cw-sans);color:var(--cw-muted)">RPC, token and price requests</span>
                            <span class="cw-key" style="flex:none;color:var(--cw-accent)">ALWAYS ROUTED</span>
                        </div>`,
                      ]
                    : []),
                `<div class="cw-row is-tight">
                    <span class="cw-grow" style="font:400 10px/1.35 var(--cw-sans);color:var(--cw-body)">${esc(
                        walletScope
                            ? 'Route every other tab through it too'
                            : 'Route this browser through the relay',
                    )}</span>
                    <button class="cw-toggle${relay.routeBrowser ? ' is-on' : ''}" data-relay-toggle="routeBrowser"></button>
                </div>`,
                `<div class="cw-row is-tight">
                    <span class="cw-grow" style="font:400 10px/1.35 var(--cw-sans);color:var(--cw-body)">Block WebRTC from leaking around it</span>
                    <button class="cw-toggle${relay.blockWebrtc ? ' is-on' : ''}" data-relay-toggle="blockWebrtc"></button>
                </div>`,
            ])}

            <div class="cw-note${walletScope ? '' : ' is-warn'}">
                ${
                    walletScope
                        ? 'Firefox lets the wallet answer for each request, so only its own traffic goes through the relay and the rest of the browser is untouched. Localhost always stays direct.'
                        : 'Chromium gives an extension one proxy setting for the whole browser, not a private route for its own requests. Turning this on routes every tab — the wallet cannot honestly offer less, so it says so instead.'
                }
            </div>

            <button class="cw-btn" style="margin-top:12px" data-do="rotate">NEW CIRCUIT · #${esc(4820 + (relay.circuit ?? 0))}</button>
            ${noticeLine()}
        </div>`;
};

/* --------------------------------------------------------------- requests --- */

const connectRequest = (request) => {
    const host = hostOf(request.origin);

    return `
        <div class="cw-body">
            <div class="cw-label is-accent">CONNECTION REQUEST</div>
            <div class="cw-site">
                <span class="cw-site-mark">${esc(initials(host))}</span>
                <span class="cw-grow">
                    <span class="cw-site-host">${esc(host)}</span>
                    <span class="cw-site-meta">${esc(request.origin.startsWith('https:') ? 'TLS' : 'NO TLS — PLAIN HTTP')}</span>
                </span>
            </div>

            <div class="cw-label cw-section">THE SITE ASKS TO</div>
            ${rows([
                '<div class="cw-ask"><span class="cw-ask-yes">✓</span><span class="cw-ask-text">See your address and token balances</span></div>',
                '<div class="cw-ask"><span class="cw-ask-yes">✓</span><span class="cw-ask-text">Ask you to sign — each time, with a preview</span></div>',
                '<div class="cw-ask"><span class="cw-ask-no">✕</span><span class="cw-ask-text is-muted">Move funds on its own · never granted</span></div>',
            ])}

            <div class="cw-panel">
                <div class="cw-field-label">EXPOSE ONE ACCOUNT</div>
                ${state.accounts
                    .map(
                        (account) => `
                    <button class="cw-pick" data-toggle-account="${esc(account.address)}">
                        <span class="cw-box${chosenAccounts.has(account.address) ? ' is-on' : ''}"></span>
                        <span class="cw-pick-name">${esc(account.name)}</span>
                        <span class="cw-pick-addr">${esc(shortAddress(account.address))}</span>
                    </button>`,
                    )
                    .join('')}
            </div>

            <div class="cw-pair">
                <button class="cw-btn" data-resolve="reject" data-autofocus-reject>REJECT</button>
                <button class="cw-btn is-primary" data-resolve="approve" ${chosenAccounts.size === 0 ? 'disabled' : ''}>CONNECT</button>
            </div>
            ${noticeLine()}
        </div>`;
};

const signRequest = (request) => {
    const preview = request.payload.preview;
    const host = hostOf(request.origin);

    return `
        <div class="cw-body">
            ${queueLine()}
            <div class="cw-label is-warn">${esc(preview.title ?? 'SIGNATURE REQUEST')} · ${esc(host)}</div>
            ${preview.consequence ? `<div class="cw-consequence">${esc(preview.consequence)}</div>` : ''}
            <div class="cw-panel">
                <div class="cw-field-label">${esc(preview.subject)}</div>
                <div class="cw-headline">${esc(preview.headline)}</div>
                <div class="cw-rule"></div>
                <div class="cw-field-label">NETWORK FEE · UP TO</div>
                <div class="cw-headline" style="font-size:16px">${esc(
                    formatUnits(preview.fee, chainById(preview.chainId).decimals, 6),
                )} <span class="cw-unit">${esc(preview.symbol)}</span></div>
            </div>

            ${rows([
                ...preview.rows.map((row) => factRow(row.key, row.value)),
                factRow('NETWORK', `${preview.chainName} · ${preview.chainId}`),
                factRow('FROM', shortAddress(preview.from, 8, 6)),
                factRow('NONCE', String(preview.nonce)),
                // Said every time, because silence would read as "checked".
                factRow('SIMULATION', 'Not available in this wallet'),
            ])}

            ${preview.warning ? `<div class="cw-note is-warn">${esc(preview.warning)}</div>` : ''}
            ${holdButton('approve', 'HOLD TO SIGN')}
            ${rejectButton()}
            ${noticeLine()}
        </div>`;
};

const messageRequest = (request) => {
    const typed = request.type === 'signTypedData';
    const host = hostOf(request.origin);
    const described = typed
        ? describeTypedData(request.payload.typed, state.chainId)
        : describeSignature(request.payload.text, request.origin);
    const body = typed ? JSON.stringify(request.payload.typed?.message ?? {}, null, 2) : described.body;

    return `
        <div class="cw-body">
            ${queueLine()}
            <div class="cw-label is-warn">${esc(described.title)} · ${esc(host)}</div>
            <div class="cw-consequence">${esc(described.consequence)}</div>
            ${typed ? rows(described.rows.map((row) => factRow(row.key, row.value))) : ''}
            ${described.warning ? `<div class="cw-note is-warn">${esc(described.warning)}</div>` : ''}
            <div class="cw-panel">
                <div class="cw-field-label">${typed ? 'FULL MESSAGE' : 'TEXT'}</div>
                <div class="cw-message">${esc(body)}</div>
            </div>
            ${rows([factRow('SIGNING AS', shortAddress(request.payload.address, 8, 6))])}
            ${holdButton('approve', 'HOLD TO SIGN')}
            ${rejectButton()}
            ${noticeLine()}
        </div>`;
};

const requestView = () => {
    const request = state.requests[0];

    if (request.type === 'connect') {
        return connectRequest(request);
    }

    return request.type === 'sendTransaction' ? signRequest(request) : messageRequest(request);
};

/* ----------------------------------------------------------------- render --- */

const currentView = () => {
    if (!state.ready) {
        return 'setup';
    }

    if (state.locked) {
        return 'locked';
    }

    if (state.requests.length > 0 && (isApprovalWindow || view === 'home' || view === 'request')) {
        return 'request';
    }

    return view;
};

const render = () => {
    if (!state) {
        renderInto(app, '<div class="cw-body cw-center"><div class="cw-sub">READING VAULT…</div></div>');
        return;
    }

    const bodies = {
        setup: setupView,
        locked: lockedView,
        request: requestView,
        home: homeView,
        receive: receiveView,
        send: sendView,
        sent: sentView,
        accounts: accountsView,
        chains: chainsView,
        sites: sitesView,
        relay: relayView,
    };

    const active = currentView();
    renderInto(app, `${head()}${(bodies[active] ?? homeView)()}${foot()}`);

    const focus = app.querySelector('[autofocus]') ?? (active === 'request' ? app.querySelector('[data-autofocus-reject]') : null);
    focus?.focus();
    wireHold();
};

const refresh = async () => {
    state = await ask(POPUP.state);

    if (state.requests.length > 0 && chosenAccounts.size === 0) {
        const active = state.accounts.find((entry) => entry.active);

        if (active) {
            chosenAccounts = new Set([active.address]);
        }
    }

    render();

    if (!state.locked && state.requests.length === 0) {
        money = await ask(POPUP.quote);
        render();
    }
};

/* ------------------------------------------------------------ interaction --- */

const setNotice = (message) => {
    notice = message ?? '';
    render();
};

const go = (target) => {
    notice = '';
    view = target;
    render();
};

const resolveRequest = async (approved) => {
    const request = state.requests[0];
    const result = await ask(POPUP.resolveRequest, {
        id: request.id,
        approved,
        accounts: [...chosenAccounts],
    });

    if (!result?.ok) {
        setNotice(result?.error ?? 'The wallet could not complete that');
        return;
    }

    chosenAccounts = new Set();
    notice = '';
    state = await ask(POPUP.state);

    if (isApprovalWindow && state.requests.length === 0) {
        window.close();
        return;
    }

    view = 'home';
    render();
};

const doSend = async () => {
    const chain = chainById(state.chainId);
    const amount = parseUnits(draft.amount, chain.decimals);

    if (amount === null) {
        setNotice('That amount is not a number this chain can hold');
        return;
    }

    const result = await ask(POPUP.send, {
        to: draft.to.trim(),
        amount: amount.toString(),
        chainId: chain.id,
    });

    if (!result?.ok) {
        setNotice(result?.error ?? 'The transaction was not broadcast');
        return;
    }

    sent = result;
    draft = { ...draft, to: '', amount: '' };
    go('sent');
};

/** Hold-to-sign: a press that has to be held is a press that was meant. */
const wireHold = () => {
    const button = app.querySelector('[data-hold]');

    if (!button) {
        return;
    }

    const fill = button.querySelector('.cw-hold-fill');
    let started = 0;
    let frame = 0;

    const stop = () => {
        cancelAnimationFrame(frame);
        started = 0;
        fill.style.width = '0';
    };

    const tick = () => {
        const held = Date.now() - started;
        fill.style.width = `${Math.min(100, (held / HOLD_MS) * 100)}%`;

        if (held >= HOLD_MS) {
            stop();
            const action = button.dataset.hold;

            if (action === 'approve') {
                resolveRequest(true);
            } else if (action === 'send') {
                doSend();
            }

            return;
        }

        frame = requestAnimationFrame(tick);
    };

    const status = app.querySelector('#cw-hold-status');
    const start = () => {
        // Checked here rather than at wiring time: the form repaints this
        // button as it is typed into, and a listener attached once must still
        // respect a button that is disabled right now.
        if (button.disabled || started !== 0) {
            return;
        }

        started = Date.now();
        frame = requestAnimationFrame(tick);

        if (status) {
            status.textContent = 'Holding — release to cancel';
        }
    };
    const release = () => {
        stop();

        if (status) {
            status.textContent = '';
        }
    };

    button.addEventListener('pointerdown', start);

    for (const event of ['pointerup', 'pointerleave', 'pointercancel']) {
        button.addEventListener(event, release);
    }

    // The same hold by keyboard: Space or Enter held down, key repeat ignored,
    // released early = nothing signed. A tap of Enter therefore never signs.
    button.addEventListener('keydown', (event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault();
            start();
        } else if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
        }
    });
    button.addEventListener('keyup', (event) => {
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            release();
        }
    });
    button.addEventListener('blur', release);
};

/**
 * The send screen's button, brought up to date with what has been typed.
 *
 * Nothing here touches an input. Re-rendering a screen from a keystroke puts
 * the text back into a fresh element with the caret at the start, and the
 * password then arrives backwards — so the form is left alone and only the
 * controls that read it are repainted.
 */
const paintSend = () => {
    const button = app.querySelector('[data-hold="send"]');

    if (!button) {
        return;
    }

    const { overdrawn, ready, label } = sendState();

    button.disabled = !ready;
    button.querySelector('.cw-hold-label').textContent = label;

    const amount = app.querySelector('[data-field="amount"]');

    if (amount) {
        amount.className = `cw-input${overdrawn ? ' is-bad' : ''}`;
    }
};

app.addEventListener('input', (event) => {
    const field = event.target.dataset?.field;

    if (!field) {
        return;
    }

    draft = { ...draft, [field]: event.target.value };

    if (field === 'to' || field === 'amount') {
        paintSend();
    }
});

// Esc on a request rejects it, wherever focus is.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state && currentView() === 'request') {
        event.preventDefault();
        resolveRequest(false);
    }
});

app.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-go],[data-do],[data-site],[data-open],[data-pick-account],[data-pick-chain],[data-relay-mode],[data-relay-toggle],[data-toggle-account],[data-resolve],[data-revoke],[data-lock-minutes]');

    if (!target) {
        return;
    }

    const data = target.dataset;

    if (data.go) {
        go(data.go);
        return;
    }

    if (data.site) {
        await chrome.tabs.create({ url: `${SITE_URL}${data.site}` });
        window.close();
        return;
    }

    if (data.open) {
        await chrome.tabs.create({ url: data.open });
        return;
    }

    if (data.resolve) {
        await resolveRequest(data.resolve === 'approve');
        return;
    }

    if (data.toggleAccount) {
        // One account by default, because a site that asked for one reason
        // should not walk away with the whole vault.
        if (chosenAccounts.has(data.toggleAccount)) {
            chosenAccounts.delete(data.toggleAccount);
        } else {
            chosenAccounts.add(data.toggleAccount);
        }

        render();
        return;
    }

    if (data.pickAccount) {
        await ask(POPUP.selectAccount, { index: Number(data.pickAccount) });
        money = null;
        view = 'home';
        await refresh();
        return;
    }

    if (data.pickChain) {
        await ask(POPUP.selectChain, { chainId: Number(data.pickChain) });
        money = null;
        view = 'home';
        await refresh();
        return;
    }

    if (data.lockMinutes) {
        await ask(POPUP.setAutoLock, { minutes: Number(data.lockMinutes) });
        await refresh();
        return;
    }

    if (data.relayMode) {
        await applyRelayChange({ mode: data.relayMode });
        return;
    }

    if (data.relayToggle) {
        await applyRelayChange({ [data.relayToggle]: !state.relay[data.relayToggle] });
        return;
    }

    if (data.revoke) {
        await ask(POPUP.revokeOrigin, { origin: data.revoke });
        await refresh();
        return;
    }

    switch (data.do) {
        case 'onboard':
            await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
            window.close();
            break;

        case 'unlock': {
            const result = await ask(POPUP.unlock, { password: draft.password });
            draft = { ...draft, password: '' };

            if (!result?.ok) {
                setNotice(result?.error ?? 'Wrong password');
                break;
            }

            notice = '';
            await refresh();
            break;
        }

        case 'lock':
            await ask(POPUP.lock);
            await refresh();
            break;

        case 'grant-network': {
            // Firefox treats MV3 host permissions as opt-in, and `request`
            // needs the click we are already inside.
            const granted = await chrome.permissions.request({ origins: state.networkOrigins });

            if (!granted) {
                setNotice('Without it the wallet cannot read a balance');
                break;
            }

            money = null;
            await refresh();
            break;
        }

        case 'add-account':
            await ask(POPUP.addAccount, {});
            await refresh();
            break;

        case 'copy':
            await navigator.clipboard.writeText(data.value);
            setNotice('COPIED');
            break;

        case 'connect-active': {
            // The host permission first and in this click — Gecko refuses a
            // `permissions.request` that comes after any other await. Without
            // it the provider cannot be placed on the page at all.
            let allowed = false;

            try {
                allowed = await chrome.permissions.request({ origins: [permissionPattern(activeOrigin)] });
            } catch {
                allowed = false;
            }

            if (!allowed) {
                setNotice('Without access to this site the wallet cannot appear on it');
                break;
            }

            const result = await ask(POPUP.connectOrigin, { origin: activeOrigin });

            if (!result?.ok) {
                setNotice(result?.error ?? 'The site could not be connected');
                break;
            }

            // The provider is registered for the site's next load; reloading
            // is what makes it appear in the page that is open now.
            if (activeTabId !== null) {
                await chrome.tabs.reload(activeTabId);
            }

            await refresh();
            break;
        }

        case 'revoke-active':
            await ask(POPUP.revokeOrigin, { origin: activeOrigin });
            await refresh();
            break;

        case 'rotate': {
            const result = await ask(POPUP.rotateCircuit, {});
            setNotice(result?.ok ? '' : 'The relay is not applied, so there is no circuit to rotate');
            break;
        }

        case 'forget':
            if (window.confirm('Erase the encrypted vault from this browser?')) {
                await ask(POPUP.forget, {});
                view = 'home';
                await refresh();
            }

            break;

        default:
            break;
    }
});

/**
 * Applying a relay needs permissions the manifest only asks for optionally, and
 * `permissions.request` needs a user gesture — which is why it happens here, in
 * the click, rather than in the service worker.
 */
const applyRelayChange = async (change) => {
    const relay = { ...state.relay, ...change, host: draft.host || state.relay.host, port: draft.port || state.relay.port };
    const needed = [];

    // On Gecko a picked relay routes the wallet at once, so the permission is
    // needed as soon as there is somewhere to route to.
    if (relay.mode !== 'direct' && (state.relayScope === 'wallet' || relay.routeBrowser)) {
        needed.push('proxy');
    }

    if (relay.blockWebrtc) {
        needed.push('privacy');
    }

    if (needed.length > 0 && !(await chrome.permissions.contains({ permissions: needed }))) {
        const granted = await chrome.permissions.request({ permissions: needed });

        if (!granted) {
            setNotice('Without that permission the wallet cannot change how traffic is routed');
            return;
        }
    }

    const result = await ask(POPUP.setRelay, { relay });

    if (!result?.ok && result?.reason !== 'permission') {
        setNotice(result?.message ?? 'The relay could not be applied');
    }

    await refresh();
};

/** Which site the toolbar was clicked on — `activeTab`, nothing broader. */
const readActiveTab = async () => {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        activeOrigin = tab?.url ? new URL(tab.url).origin : null;
        activeTabId = tab?.id ?? null;
    } catch {
        activeOrigin = null;
        activeTabId = null;
    }
};

if (!isApprovalWindow) void trackExtensionOpen();
await readActiveTab();
await refresh();
