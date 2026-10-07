<script setup lang="ts">
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { nativeShell } from '@/lib/native';
import {
    CYBERIA_DAPPS,
    dappBridgeMode,
    hasInjectedProvider,
    isTouchOnly,
} from '@/lib/wallet/dapps';
import {
    DNS_API,
    ROOT_ZONE,
    fetchServedZones,
    parseAddress,
    readZones,
    resolveName,
} from '@/lib/wallet/domains';
import type { ResolvedName } from '@/lib/wallet/domains';
import { shortAddress } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The Wired: a browser that knows Cyberia's names, and a directory of what is
 * on this chain.
 *
 * The address bar takes a web address, an `ipfs://` link, or a domain in any
 * zone CyberiaDomains has — `.cyber` and every zone a launchpad token opened —
 * which no operating system resolves. The zones are the DNS server's list
 * (`/api/zones`, so a zone appears here the minute its token opens it), and a
 * name is resolved through the same server's JSON view, which is the answer
 * its DNS and its HTTP gateway act on too: a `url` or a `CNAME` is shown, an
 * IPFS page is shown through a public gateway, a name that points at another
 * name is followed.
 *
 * What it shows is a frame, and the frame is *only* a frame. It is sandboxed,
 * and anything served from this origin loses `allow-same-origin`, because the
 * vault lives in this origin's storage and a page that shared it could read
 * the keys. A page in a frame cannot be handed a provider either — a browser
 * tab cannot script a cross-origin frame — so signing for a page is still the
 * extension's job, per origin, with a human in front of every signature. Two
 * things a frame cannot show are said instead of drawn blank: a plain-HTTP
 * server (an https page may not frame `http://`), and a site that refuses to
 * be framed at all, which no page can detect — hence "open in a new tab" is
 * always beside the address.
 *
 * The other half is that several of these are already in the wallet: swapping,
 * farming, the launchpad, the DAO and the bridge have their own screens here,
 * signed by this key without a page in the middle. Those rows say so, because
 * the shortest way to use a dapp safely is not to need one.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** A name or address to open on arrival (from the domains screen). */
    initial?: string | null;
}>();

const emit = defineEmits<{
    swap: [];
    earn: [];
    launchpad: [];
    dao: [];
    bridge: [];
    domains: [name: string | null];
}>();

const { t } = useLocale(walletMessages);

const mode = computed(() =>
    dappBridgeMode(nativeShell(), hasInjectedProvider(), isTouchOnly()),
);

/** Which in-wallet screen a row opens, when the wallet has one of its own. */
const INTERNAL: Record<
    string,
    'swap' | 'earn' | 'launchpad' | 'dao' | 'bridge'
> = {
    swap: 'swap',
    farm: 'earn',
    launchpad: 'launchpad',
    dao: 'dao',
    bridge: 'bridge',
};

const rows = computed(() =>
    CYBERIA_DAPPS.map((dapp) => ({
        ...dapp,
        label: t(`dapp${dapp.key.charAt(0).toUpperCase()}${dapp.key.slice(1)}`),
        note: t(
            `dapp${dapp.key.charAt(0).toUpperCase()}${dapp.key.slice(1)}Note`,
        ),
        internal: INTERNAL[dapp.key] ?? null,
    })),
);

const openInternal = (
    target: 'swap' | 'earn' | 'launchpad' | 'dao' | 'bridge',
): void => {
    // One emit per destination rather than a dynamic one: the typed emit list
    // is what keeps a row from opening a screen the page does not have.
    if (target === 'swap') {
        emit('swap');
    } else if (target === 'earn') {
        emit('earn');
    } else if (target === 'launchpad') {
        emit('launchpad');
    } else if (target === 'dao') {
        emit('dao');
    } else {
        emit('bridge');
    }
};

/** Whether this wallet has a key that could sign for a page at all. */
const watching = computed(
    () => props.wallet.activeAccount.value?.kind === 'watch',
);

/* ------------------------------------------------------------- browser --- */

type View =
    | { kind: 'frame'; src: string; sameOrigin: boolean }
    | { kind: 'free'; name: string }
    | { kind: 'noSite'; name: string }
    | { kind: 'host'; name: string; url: string }
    | { kind: 'http'; url: string }
    | { kind: 'invalid' }
    | { kind: 'error'; message: string };

const zones = ref<string[]>([ROOT_ZONE]);
const address = ref('');
const view = ref<View | null>(null);
/** The domain behind what is on screen, when it was reached by name. */
const domain = ref<ResolvedName | null>(null);
const loading = ref(false);
const trail = ref<string[]>([]);
const position = ref(-1);
/** Bumped to remount the frame: the only reload a cross-origin frame has. */
const frameKey = ref(0);

const myAddress = computed(
    () =>
        props.wallet.accounts.value
            .find((entry) => entry.chain === 'cyberia')
            ?.address.toLowerCase() ?? null,
);
const mineOnScreen = computed(
    () =>
        !!domain.value?.owner &&
        domain.value.owner.toLowerCase() === myAddress.value,
);

/** Where "open in a new tab" goes for what is on screen. */
const outside = computed(() => {
    const current = view.value;

    if (!current) {
        return null;
    }

    if (current.kind === 'frame') {
        return current.src;
    }

    if (current.kind === 'host' || current.kind === 'http') {
        return current.url;
    }

    return null;
});

const frameFor = (src: string): View => {
    let sameOrigin = false;

    try {
        sameOrigin =
            typeof window !== 'undefined' &&
            new URL(src).origin === window.location.origin;
    } catch {
        return { kind: 'invalid' };
    }

    // An https page may not frame plain http (mixed content, blocked
    // silently): say so instead of drawing a white rectangle.
    if (
        typeof window !== 'undefined' &&
        window.location.protocol === 'https:' &&
        src.startsWith('http:')
    ) {
        return { kind: 'http', url: src };
    }

    return { kind: 'frame', src, sameOrigin };
};

/** Resolve a name, following names that point at names, to a view. */
const visitName = async (name: string, path: string): Promise<View> => {
    let current = name;

    for (let hop = 0; hop < 4; hop++) {
        const info = await resolveName(current);

        domain.value = info;

        if (info.zone === null) {
            return frameFor(`https://${current}${path}`);
        }

        if (!info.registered) {
            return { kind: 'free', name: current };
        }

        const target = info.target ?? { kind: 'none' as const };

        if (target.kind === 'name') {
            current = target.name;
            continue;
        }

        if (target.kind === 'url' || target.kind === 'cname') {
            const base = target.url.replace(/\/$/, '');

            return frameFor(
                path && path !== '/' && target.kind === 'cname'
                    ? `${base}${path}`
                    : target.url,
            );
        }

        if (target.kind === 'ipfs') {
            return frameFor(`${target.url.replace(/\/$/, '')}${path || '/'}`);
        }

        if (target.kind === 'host') {
            return {
                kind: 'host',
                name: current,
                url: `http://${current}${path || '/'}`,
            };
        }

        return { kind: 'noSite', name: current };
    }

    return { kind: 'error', message: t('browserLoop') };
};

const show = async (entry: string): Promise<void> => {
    const parsed = parseAddress(entry, zones.value);

    address.value = entry;
    domain.value = null;
    loading.value = true;

    try {
        if (parsed.kind === 'invalid') {
            view.value = { kind: 'invalid' };
        } else if (parsed.kind === 'url') {
            view.value = frameFor(parsed.url);
        } else {
            address.value = `${parsed.name}${parsed.path === '/' ? '' : parsed.path}`;
            view.value = await visitName(parsed.name, parsed.path);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        view.value = {
            kind: 'error',
            message:
                message === 'chainUnreadable' ? t('chainUnreadable') : message,
        };
    } finally {
        loading.value = false;
        frameKey.value += 1;
    }
};

const go = async (entry = address.value): Promise<void> => {
    const text = entry.trim();

    if (text === '') {
        return;
    }

    trail.value = [...trail.value.slice(0, position.value + 1), text];
    position.value = trail.value.length - 1;
    await show(text);
};

const step = async (delta: number): Promise<void> => {
    const next = position.value + delta;

    if (next < 0 || next >= trail.value.length) {
        return;
    }

    position.value = next;
    await show(trail.value[next]);
};

const home = (): void => {
    view.value = null;
    domain.value = null;
    address.value = '';
};

/**
 * Frames run with scripts and forms but without this origin: a page served
 * from here keeps its own sandboxed origin, so it cannot reach the vault.
 */
const sandboxFor = (sameOrigin: boolean): string =>
    [
        'allow-scripts',
        'allow-forms',
        'allow-popups',
        'allow-popups-to-escape-sandbox',
        'allow-downloads',
        ...(sameOrigin ? [] : ['allow-same-origin']),
    ].join(' ');

onMounted(async () => {
    try {
        zones.value = await fetchServedZones();
    } catch {
        // The DNS server's list is the honest one (it leaves out zones that
        // collide with real TLDs); the chain's is the fallback.
        zones.value = (await readZones().catch(() => [])).map((z) => z.zone);
    }

    if (zones.value.length === 0) {
        zones.value = [ROOT_ZONE];
    }

    if (props.initial) {
        await go(props.initial);
    }
});
</script>

<template>
    <div class="cw-stack">
        <h2 class="cw-title" style="margin: 18px 0 8px">
            {{ t('browseTitle') }}
        </h2>

        <!-- The address bar: a web address, ipfs://, or a Cyberia domain. -->
        <form
            style="display: flex; gap: 6px; align-items: stretch"
            @submit.prevent="go()"
        >
            <button
                type="button"
                class="cw-ghost"
                :aria-label="t('browserBack')"
                :disabled="position <= 0 || loading"
                @click="step(-1)"
            >
                <ArrowLeft :size="16" aria-hidden="true" />
            </button>
            <button
                type="button"
                class="cw-ghost"
                :aria-label="t('browserForward')"
                :disabled="position >= trail.length - 1 || loading"
                @click="step(1)"
            >
                <ArrowRight :size="16" aria-hidden="true" />
            </button>
            <input
                v-model="address"
                class="cw-input"
                style="flex: 1; min-width: 0; font-family: var(--cw-mono)"
                type="text"
                inputmode="url"
                spellcheck="false"
                autocapitalize="none"
                autocomplete="off"
                :placeholder="
                    t('browserAddress', { zone: zones[1] ?? ROOT_ZONE })
                "
                :aria-label="t('browserAddressLabel')"
            />
            <button
                type="button"
                class="cw-ghost"
                :aria-label="t('browserReload')"
                :disabled="!view || loading"
                @click="show(trail[position] ?? address)"
            >
                <RotateCw :size="16" aria-hidden="true" />
            </button>
        </form>
        <p class="cw-data" style="margin-top: 6px; overflow-wrap: anywhere">
            {{
                t('browserZones', {
                    zones: zones.map((z) => `.${z}`).join(' '),
                })
            }}
        </p>

        <template v-if="view || loading">
            <!-- What the name on screen is, and whose. -->
            <div
                v-if="domain && domain.registered"
                class="cw-row"
                style="margin-top: 10px; gap: 10px; flex-wrap: wrap"
            >
                <span class="cw-data" style="overflow-wrap: anywhere">
                    {{
                        t('browserHeldBy', {
                            name: domain.name,
                            owner: shortAddress(domain.owner ?? ''),
                        })
                    }}
                </span>
                <button
                    v-if="mineOnScreen"
                    type="button"
                    class="cw-back"
                    @click="emit('domains', domain.name)"
                >
                    {{ t('domainsManage') }}
                </button>
            </div>

            <div
                style="
                    display: flex;
                    gap: 8px;
                    margin-top: 10px;
                    flex-wrap: wrap;
                "
            >
                <a
                    v-if="outside"
                    class="cw-ghost"
                    :href="outside"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('browserNewTab') }}
                    <ExternalLink :size="12" aria-hidden="true" />
                </a>
                <button type="button" class="cw-ghost" @click="home">
                    {{ t('browserHome') }}
                </button>
            </div>

            <p
                v-if="loading"
                class="cw-label"
                style="margin-top: 14px; color: var(--cw-faint)"
            >
                {{ t('browserResolving') }}
            </p>

            <template v-else-if="view?.kind === 'frame'">
                <iframe
                    :key="frameKey"
                    :src="view.src"
                    :sandbox="sandboxFor(view.sameOrigin)"
                    referrerpolicy="no-referrer"
                    :title="address"
                    style="
                        display: block;
                        width: 100%;
                        height: min(76vh, 900px);
                        margin-top: 12px;
                        border: 1px solid var(--cw-border-soft);
                        background: #fff;
                    "
                ></iframe>
                <p class="cw-data" style="margin-top: 8px">
                    {{ t('browserBlankHint') }}
                </p>
            </template>

            <div
                v-else-if="view"
                class="cw-card"
                style="margin-top: 14px; padding: 18px"
            >
                <template v-if="view.kind === 'free'">
                    <p class="cw-prose">
                        {{ t('browserFree', { name: view.name }) }}
                    </p>
                    <button
                        type="button"
                        class="cw-btn cw-btn-primary"
                        style="height: 44px; margin-top: 14px"
                        @click="emit('domains', view.name)"
                    >
                        {{ t('browserRegister', { name: view.name }) }}
                    </button>
                </template>
                <p v-else-if="view.kind === 'noSite'" class="cw-prose">
                    {{ t('browserNoSite', { name: view.name }) }}
                </p>
                <p v-else-if="view.kind === 'host'" class="cw-prose">
                    {{
                        t('browserHostOnly', {
                            name: view.name,
                            doh: `${DNS_API}/dns-query`,
                        })
                    }}
                </p>
                <p v-else-if="view.kind === 'http'" class="cw-prose">
                    {{ t('browserHttp') }}
                </p>
                <p v-else-if="view.kind === 'invalid'" class="cw-prose">
                    {{ t('browserInvalid') }}
                </p>
                <p
                    v-else-if="view.kind === 'error'"
                    class="cw-note cw-note-bad"
                >
                    <span>{{ view.message }}</span>
                </p>
            </div>
        </template>

        <template v-else>
            <p class="cw-prose" style="max-width: 62ch; margin-top: 16px">
                {{ t('browseBody') }}
            </p>

            <!--
          What this shell can actually do for a page, said before the list of
          pages. Four answers, and two of them are "not from here".
        -->
            <div class="cw-card" style="margin-top: 20px; padding: 18px">
                <!--
              The state as a sentence and not as a label with a value beside
              it: "СТРАНИЦАМ ЗДЕСЬ ДОСТУПЕН — НИЧЕГО" said in eleven uppercase
              characters what the line under it says in words, and the words
              are the ones somebody can act on.
            -->
                <p class="cw-prose" style="max-width: 62ch">
                    {{
                        t(
                            `browseMode${mode.charAt(0).toUpperCase()}${mode.slice(1)}Body`,
                        )
                    }}
                </p>
                <div
                    v-if="mode === 'browser' || mode === 'desktop'"
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 14px;
                        flex-wrap: wrap;
                    "
                >
                    <a class="cw-ghost" href="/download/extension">{{
                        t('proxyGetExtension')
                    }}</a>
                </div>
            </div>

            <p
                v-if="watching"
                class="cw-note cw-note-warn"
                style="margin-top: 14px"
            >
                <span>{{ t('browseWatchOnly') }}</span>
            </p>

            <div class="cw-label" style="margin: 26px 0 10px">
                {{ t('browseDirectory') }}
            </div>

            <!--
          A row is a link, so the directory stops repeating itself: every entry
          used to carry "ОТКРЫТЬ СТРАНИЦУ" and most of them "ОТКРЫТЬ В
          КОШЕЛЬКЕ" as well — eighteen buttons under nine names, all saying one
          of two things. The row goes to the page; the one exception, where the
          wallet does this itself and no page needs a key at all, stays as a
          control of its own, because it is the safer of the two and has to be
          visible as a choice.
        -->
            <div class="cw-stack" style="gap: 8px">
                <div
                    v-for="row in rows"
                    :key="row.key"
                    class="cw-card"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        padding: 14px 16px;
                    "
                >
                    <component
                        :is="row.internal ? 'button' : 'a'"
                        :type="row.internal ? 'button' : undefined"
                        :href="row.internal ? undefined : row.path"
                        style="
                            display: flex;
                            flex: 1;
                            min-width: 0;
                            align-items: flex-start;
                            gap: 12px;
                            padding: 0;
                            border: 0;
                            background: none;
                            color: inherit;
                            font: inherit;
                            text-align: left;
                            text-decoration: none;
                            cursor: pointer;
                        "
                        @click="row.internal && openInternal(row.internal)"
                    >
                        <span
                            style="
                                display: flex;
                                width: 26px;
                                height: 26px;
                                flex: none;
                                align-items: center;
                                justify-content: center;
                                border: 1px solid var(--cw-border-soft);
                                font: 500 12px/1 var(--cw-mono);
                                color: var(--cw-muted);
                            "
                            >{{ row.tag }}</span
                        >
                        <span style="flex: 1; min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 500 15px/1.2 var(--cw-sans);
                                    color: var(--cw-text);
                                "
                                >{{ row.label }}</span
                            >
                            <span
                                style="
                                    display: block;
                                    margin-top: 4px;
                                    font: 400 13px/1.5 var(--cw-sans);
                                    color: var(--cw-muted);
                                "
                                >{{ row.note
                                }}<template v-if="row.internal">
                                    · {{ t('browseInWallet') }}</template
                                ><template v-else-if="!row.signs">
                                    · {{ t('browseReadOnly') }}</template
                                ></span
                            >
                        </span>
                    </component>

                    <!--
                  The shortest way to use a dapp safely is not to need one:
                  where the wallet already does this itself, the row opens it
                  here — on a phone the page would only ask for a browser
                  wallet it cannot have — and the page is the secondary link.
                -->
                    <a
                        v-if="row.internal"
                        class="cw-ghost"
                        style="flex: none"
                        :href="row.path"
                    >
                        {{ t('browseOpenSite') }}
                    </a>
                </div>
            </div>

            <p class="cw-prose" style="margin-top: 18px; max-width: 62ch">
                {{ t('browseLeavingNote') }}
            </p>

            <p class="cw-prose" style="margin-top: 18px; max-width: 62ch">
                {{ t('browserDnsEverywhere', { doh: `${DNS_API}/dns-query` }) }}
            </p>
            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="emit('domains', null)"
            >
                {{ t('domainsTitle') }} →
            </button>
        </template>
    </div>
</template>
