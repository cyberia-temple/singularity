<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits } from '@/lib/wallet';
import {
    ROOT_ZONE,
    awaitDomainTx,
    domainTxUrl,
    fetchOwnedDomains,
    quoteRegistration,
    readDomain,
    readZones,
    recordChanges,
    siteKindOf,
    siteProblem,
    siteRecords,
    splitDomain,
    validLabel,
    zoneTokenNaming,
} from '@/lib/wallet/domains';
import type {
    DomainState,
    RegistrationQuote,
    SiteForm,
    SiteKind,
    ZoneInfo,
} from '@/lib/wallet/domains';
import { shortAddress } from '@/lib/wallet/format';
import { pinPage } from '@/lib/wallet/ipfs';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Domains: names you own as NFTs, and what each one opens.
 *
 * Three questions on one screen, in the order somebody arrives with them: is
 * this name free and what does it cost, which names do I hold, and what does
 * mine point at. The fourth — where zones come from — is answered under the
 * list, because the answer is "from the launchpad" and it is a sentence, not
 * a form: a token named `.moon` with the ticker `DOTMOON` opens `.moon`.
 *
 * What a name costs is read from the chain at the moment it is asked, and the
 * unit is said with it: `.cyber` is paid in CYBER, a token's zone in that
 * token, burned. A token zone usually needs an approval first, and both
 * signatures sit under the one hold, which says so.
 *
 * Editing is by intent rather than by record: "a link", "an IPFS page", "a
 * server", "another name" — each writes its own key and clears the others,
 * since a domain that answers with two of them answers with whichever the
 * resolver checks first. The raw records stay one fold down for anything the
 * form has no word for (TXT, MX, sub-names).
 */

const props = defineProps<{
    wallet: MultiWallet;
    ipfs: { enabled: boolean; maxBytes: number };
    /** A name to ask about on arrival (from the browser). */
    initial?: string | null;
}>();

const emit = defineEmits<{
    browse: [name: string];
    launchpad: [];
    swap: [contract: string];
}>();

const { t } = useLocale(walletMessages);

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === 'cyberia',
        ) ?? null,
);
const canSign = computed(() => account.value?.capabilities.send ?? false);

const zones = ref<ZoneInfo[]>([]);
const mine = ref<{ name: string; label: string; zone: string }[]>([]);
const loading = ref(true);
const failure = ref<string | null>(null);

/* ------------------------------------------------------------ register --- */

const label = ref('');
const zone = ref(ROOT_ZONE);
const quote = ref<RegistrationQuote | null>(null);
const taken = ref<DomainState | null>(null);
const checking = ref(false);
const searchError = ref<string | null>(null);
const registering = ref(false);
const registered = ref<{ name: string; hash: string } | null>(null);

const amount = (value: bigint, decimals: number): string =>
    formatUnits(value, decimals, 6);

/** Not enough of what the name is paid in — a different balance from gas. */
const short = computed(
    () => quote.value !== null && quote.value.balance < quote.value.fee,
);

const errorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);

    return /^(domain|chain)[A-Z]/.test(message) ? t(message) : message;
};

/** Typing `lain.moon` into the name field picks the zone as well. */
watch(label, (value) => {
    const split = splitDomain(
        value,
        zones.value.map((entry) => entry.zone),
    );

    if (split && !split.sub) {
        zone.value = split.zone;
        label.value = split.label;
    }
});

watch([label, zone], () => {
    quote.value = null;
    taken.value = null;
    searchError.value = null;
});

const check = async (): Promise<void> => {
    const name = label.value.trim().toLowerCase();

    if (!validLabel(name)) {
        searchError.value = t('domainBadLabel');

        return;
    }

    label.value = name;
    checking.value = true;
    searchError.value = null;
    registered.value = null;

    try {
        quote.value = await quoteRegistration(
            name,
            zone.value,
            account.value?.address ??
                '0x0000000000000000000000000000000000000001',
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : '';

        if (message === 'domainTaken') {
            taken.value = await readDomain(name, zone.value).catch(() => null);
        } else {
            searchError.value = errorText(error);
        }
    } finally {
        checking.value = false;
    }
};

const register = async (): Promise<void> => {
    if (!quote.value) {
        return;
    }

    registering.value = true;
    searchError.value = null;

    try {
        const hash = await props.wallet.domains.register(quote.value);
        const name = `${quote.value.label}.${quote.value.zone}`;

        if (!(await awaitDomainTx(hash))) {
            throw new Error('domainTxFailed');
        }

        registered.value = { name, hash };
        quote.value = null;
        void load();
        void props.wallet.refreshBalances();
    } catch (error) {
        searchError.value = errorText(error);
    } finally {
        registering.value = false;
    }
};

/* -------------------------------------------------------------- manage --- */

const open = ref<DomainState | null>(null);
const site = reactive<SiteForm>({
    kind: 'none',
    url: '',
    ipfs: '',
    alias: '',
    ipv4: '',
    ipv6: '',
});
const raw = ref<{ key: string; value: string }[]>([]);
const advanced = ref(false);
const saving = ref(false);
const saved = ref<string | null>(null);
const manageError = ref<string | null>(null);
const uploading = ref(false);

const SITE_KINDS: SiteKind[] = ['none', 'url', 'ipfs', 'host', 'alias'];
const SITE_KEYS = new Set(['url', 'ipfs', 'CNAME', 'A', 'AAAA']);

const isMine = computed(
    () =>
        open.value?.owner !== null &&
        open.value?.owner?.toLowerCase() ===
            account.value?.address.toLowerCase(),
);

const fill = (state: DomainState): void => {
    const r = state.records;

    site.kind = siteKindOf(r);
    site.url = r.url ?? '';
    site.ipfs = r.ipfs ?? '';
    site.alias = r.CNAME ?? '';
    site.ipv4 = r.A ?? '';
    site.ipv6 = r.AAAA ?? '';
    raw.value = Object.entries(r)
        .filter(([key]) => !SITE_KEYS.has(key))
        .map(([key, value]) => ({ key, value }));
};

const manage = async (name: string, zoneName: string): Promise<void> => {
    manageError.value = null;
    saved.value = null;
    advanced.value = false;

    try {
        open.value = await readDomain(name, zoneName);
        fill(open.value);
    } catch (error) {
        failure.value = errorText(error);
    }
};

/** Everything the form would leave on chain, site keys and raw ones together. */
const desired = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};

    for (const row of raw.value) {
        const key = row.key.trim();

        if (key !== '' && !SITE_KEYS.has(key)) {
            out[key] = row.value;
        }
    }

    // A raw key that was removed from the list is deleted on chain.
    for (const key of Object.keys(open.value?.records ?? {})) {
        if (!SITE_KEYS.has(key) && !(key in out)) {
            out[key] = '';
        }
    }

    return { ...out, ...siteRecords(site) };
});

const changes = computed(() =>
    open.value ? recordChanges(open.value.records, desired.value) : null,
);

const siteError = computed(() => {
    const key = siteProblem(site);

    return key ? t(key) : null;
});

const uploadPage = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];

    if (!file) {
        return;
    }

    uploading.value = true;
    manageError.value = null;

    try {
        const pinned = await pinPage(await file.text());

        site.ipfs = pinned.cid;
    } catch (error) {
        manageError.value = errorText(error);
    } finally {
        uploading.value = false;
    }
};

const save = async (): Promise<void> => {
    if (!open.value || !changes.value || changes.value.keys.length === 0) {
        return;
    }

    saving.value = true;
    manageError.value = null;
    saved.value = null;

    try {
        const hash = await props.wallet.domains.setRecords(
            open.value.label,
            open.value.zone,
            changes.value.keys,
            changes.value.values,
        );

        if (!(await awaitDomainTx(hash))) {
            throw new Error('domainTxFailed');
        }

        saved.value = hash;
        open.value = await readDomain(open.value.label, open.value.zone);
        fill(open.value);
    } catch (error) {
        manageError.value = errorText(error);
    } finally {
        saving.value = false;
    }
};

/* ---------------------------------------------------------- open a zone --- */

/**
 * A token launched somewhere other than this wallet's launch screen — the
 * site's /launchpad, another wallet — has not had its zone opened by anyone.
 * Opening it is permissionless and free beyond gas, so it is one field here.
 */
const zoneToken = ref('');
const openingZone = ref(false);
const zoneMessage = ref<{ ok: boolean; text: string } | null>(null);

const openZone = async (): Promise<void> => {
    const token = zoneToken.value.trim();

    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
        zoneMessage.value = { ok: false, text: t('domainsZoneBadToken') };

        return;
    }

    openingZone.value = true;
    zoneMessage.value = null;

    try {
        const hash = await props.wallet.domains.openZone(token);

        if (!(await awaitDomainTx(hash))) {
            throw new Error('domainTxFailed');
        }

        zoneToken.value = '';
        await load();
        zoneMessage.value = { ok: true, text: t('domainsZoneOpened') };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        zoneMessage.value = {
            ok: false,
            text: /not a launchpad token/.test(message)
                ? t('domainsZoneNotLaunched')
                : /not a zone token/.test(message)
                  ? t('domainsZoneNotZone')
                  : /zone (exists|taken)/.test(message)
                    ? t('domainsZoneTaken')
                    : errorText(error),
        };
    } finally {
        openingZone.value = false;
    }
};

/* ---------------------------------------------------------------- load --- */

const load = async (): Promise<void> => {
    loading.value = true;
    failure.value = null;

    try {
        const [zoneList, owned] = await Promise.all([
            readZones(),
            account.value
                ? fetchOwnedDomains(account.value.address)
                : Promise.resolve([]),
        ]);

        zones.value = zoneList;
        mine.value = owned;
    } catch (error) {
        failure.value = errorText(error);
    } finally {
        loading.value = false;
    }
};

onMounted(async () => {
    await load();

    // `/wallet?section=domains&name=lain.moon` — the DNS gateway's "free,
    // register it" link — arrives with the name already asked.
    const wanted =
        props.initial ??
        (typeof window === 'undefined'
            ? null
            : new URL(window.location.href).searchParams.get('name'));
    const split = wanted
        ? splitDomain(
              wanted,
              zones.value.map((entry) => entry.zone),
          )
        : null;

    if (split) {
        zone.value = split.zone;
        label.value = split.label;
        await check();
    }
});

watch(
    () => account.value?.address,
    () => {
        open.value = null;
        void load();
    },
);
</script>

<template>
    <div class="cw-stack">
        <!-- ------------------------------------------------------ manage --- -->
        <template v-if="open">
            <button type="button" class="cw-back" @click="open = null">
                ← {{ t('domainsTitle') }}
            </button>

            <h2
                class="cw-title"
                style="margin: 22px 0 6px; overflow-wrap: anywhere"
            >
                {{ open.name }}
            </h2>
            <div class="cw-card" style="margin-top: 8px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('domainsHolder') }}</span>
                    <span class="cw-kv-val">{{
                        open.owner ? shortAddress(open.owner) : '—'
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('domainsSite') }}</span>
                    <span class="cw-kv-val">{{
                        t(`domainSite_${siteKindOf(open.records)}`)
                    }}</span>
                </div>
            </div>

            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 44px; margin-top: 14px"
                @click="emit('browse', open.name)"
            >
                {{ t('domainsOpen') }}
            </button>

            <p
                v-if="!isMine"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('domainsNotYours') }}</span>
            </p>

            <template v-else>
                <div class="cw-label" style="margin: 24px 0 10px">
                    {{ t('domainsWhatOpens') }}
                </div>
                <div class="cw-seg" style="flex-wrap: wrap">
                    <button
                        v-for="kind in SITE_KINDS"
                        :key="kind"
                        type="button"
                        class="cw-seg-item"
                        :aria-pressed="site.kind === kind"
                        @click="site.kind = kind"
                    >
                        {{ t(`domainSite_${kind}`) }}
                    </button>
                </div>
                <p class="cw-prose" style="margin-top: 12px">
                    {{ t(`domainSiteBody_${site.kind}`) }}
                </p>

                <input
                    v-if="site.kind === 'url'"
                    v-model="site.url"
                    class="cw-input"
                    style="margin-top: 12px"
                    type="url"
                    spellcheck="false"
                    placeholder="https://"
                />
                <template v-else-if="site.kind === 'ipfs'">
                    <input
                        v-model="site.ipfs"
                        class="cw-input"
                        style="margin-top: 12px"
                        type="text"
                        spellcheck="false"
                        placeholder="bafy…"
                    />
                    <label
                        class="cw-ghost"
                        style="margin-top: 10px; cursor: pointer"
                        :aria-disabled="!ipfs.enabled || uploading"
                    >
                        {{
                            uploading
                                ? t('domainsUploading')
                                : t('domainsUploadPage')
                        }}
                        <input
                            type="file"
                            accept=".html,.htm,text/html"
                            style="display: none"
                            :disabled="!ipfs.enabled || uploading"
                            @change="uploadPage"
                        />
                    </label>
                    <p
                        v-if="!ipfs.enabled"
                        class="cw-data"
                        style="margin-top: 6px"
                    >
                        {{ t('ipfsOff') }}
                    </p>
                </template>
                <input
                    v-else-if="site.kind === 'alias'"
                    v-model="site.alias"
                    class="cw-input"
                    style="margin-top: 12px"
                    type="text"
                    spellcheck="false"
                    placeholder="example.com"
                />
                <template v-else-if="site.kind === 'host'">
                    <label
                        class="cw-label"
                        style="display: block; margin: 12px 0 6px"
                        >IPv4</label
                    >
                    <input
                        v-model="site.ipv4"
                        class="cw-input"
                        type="text"
                        spellcheck="false"
                        placeholder="203.0.113.7"
                    />
                    <label
                        class="cw-label"
                        style="display: block; margin: 12px 0 6px"
                        >IPv6</label
                    >
                    <input
                        v-model="site.ipv6"
                        class="cw-input"
                        type="text"
                        spellcheck="false"
                        placeholder="2001:db8::7"
                    />
                </template>

                <button
                    type="button"
                    class="cw-ghost"
                    style="margin-top: 20px"
                    @click="advanced = !advanced"
                >
                    {{ advanced ? '▾' : '▸' }} {{ t('domainsAdvanced') }}
                </button>
                <template v-if="advanced">
                    <p class="cw-prose" style="margin-top: 8px">
                        {{ t('domainsAdvancedBody') }}
                    </p>
                    <div
                        v-for="(row, index) in raw"
                        :key="index"
                        style="display: flex; gap: 8px; margin-top: 8px"
                    >
                        <input
                            v-model="row.key"
                            class="cw-input"
                            style="flex: 0 0 34%"
                            type="text"
                            spellcheck="false"
                            :placeholder="t('domainsKey')"
                        />
                        <input
                            v-model="row.value"
                            class="cw-input"
                            style="flex: 1; min-width: 0"
                            type="text"
                            spellcheck="false"
                            :placeholder="t('domainsValue')"
                        />
                        <button
                            type="button"
                            class="cw-ghost"
                            :aria-label="t('domainsRemove')"
                            @click="raw.splice(index, 1)"
                        >
                            ×
                        </button>
                    </div>
                    <button
                        type="button"
                        class="cw-ghost cw-ghost-dashed"
                        style="margin-top: 8px"
                        @click="raw.push({ key: '', value: '' })"
                    >
                        + {{ t('domainsAddRecord') }}
                    </button>
                </template>

                <p
                    v-if="siteError && site.kind !== 'none'"
                    class="cw-note cw-note-warn"
                    style="margin-top: 14px"
                >
                    <span>{{ siteError }}</span>
                </p>
                <p
                    v-if="manageError"
                    class="cw-note cw-note-bad"
                    style="margin-top: 14px"
                >
                    <span>{{ manageError }}</span>
                </p>
                <p v-if="saved" class="cw-note" style="margin-top: 14px">
                    <span style="flex: 1">{{ t('domainsSaved') }}</span>
                    <a
                        class="cw-back"
                        :href="domainTxUrl(saved)"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ t('domainsExplorer') }}
                        <ExternalLink :size="12" aria-hidden="true"
                    /></a>
                </p>

                <p
                    v-if="changes && changes.keys.length > 0"
                    class="cw-data"
                    style="margin-top: 14px; overflow-wrap: anywhere"
                >
                    {{
                        t('domainsWillWrite', { keys: changes.keys.join(', ') })
                    }}
                </p>
                <div style="margin-top: 16px">
                    <HoldButton
                        :label="
                            saving ? t('domainsSaving') : t('domainsSaveHold')
                        "
                        :disabled="
                            saving ||
                            !canSign ||
                            !changes ||
                            changes.keys.length === 0 ||
                            (siteError !== null && site.kind !== 'none')
                        "
                        @complete="save"
                    />
                </div>
            </template>
        </template>

        <!-- -------------------------------------------------------- list --- -->
        <template v-else>
            <h2 class="cw-title" style="margin: 18px 0 8px">
                {{ t('domainsTitle') }}
            </h2>
            <p class="cw-prose" style="max-width: 62ch">
                {{ t('domainsBody') }}
            </p>

            <p
                v-if="!canSign"
                class="cw-note cw-note-warn"
                style="margin-top: 14px"
            >
                <span>{{ t('domainsWatchOnly') }}</span>
            </p>

            <form
                class="cw-card"
                style="margin-top: 18px; padding: 16px"
                @submit.prevent="check"
            >
                <label
                    class="cw-label"
                    style="display: block; margin-bottom: 6px"
                >
                    {{ t('domainsSearch') }}
                </label>
                <div style="display: flex; gap: 8px; align-items: stretch">
                    <input
                        v-model="label"
                        class="cw-input"
                        style="flex: 1; min-width: 0"
                        type="text"
                        spellcheck="false"
                        autocapitalize="none"
                        maxlength="63"
                        :placeholder="t('domainsSearchPlaceholder')"
                    />
                    <select
                        v-model="zone"
                        class="cw-input"
                        style="flex: 0 0 auto; width: auto"
                        :aria-label="t('domainsZone')"
                    >
                        <option
                            v-for="entry in zones"
                            :key="entry.zone"
                            :value="entry.zone"
                        >
                            .{{ entry.zone }}
                        </option>
                    </select>
                </div>
                <button
                    type="submit"
                    class="cw-btn cw-btn-secondary"
                    style="height: 44px; margin-top: 12px; width: 100%"
                    :disabled="checking || label.trim() === ''"
                >
                    {{ checking ? t('domainsChecking') : t('domainsFind') }}
                </button>

                <p
                    v-if="searchError"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>{{ searchError }}</span>
                </p>

                <template v-if="taken">
                    <p class="cw-note cw-note-warn" style="margin-top: 12px">
                        <span style="flex: 1">{{
                            t('domainsTakenBy', {
                                name: taken.name,
                                owner: taken.owner
                                    ? shortAddress(taken.owner)
                                    : '—',
                            })
                        }}</span>
                        <button
                            type="button"
                            class="cw-back"
                            @click="emit('browse', taken.name)"
                        >
                            {{ t('domainsOpen') }}
                        </button>
                    </p>
                </template>

                <template v-if="quote">
                    <div style="margin-top: 14px">
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{
                                t('domainsFree')
                            }}</span>
                            <span class="cw-kv-val"
                                >{{ quote.label }}.{{ quote.zone }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{
                                t('domainsPrice')
                            }}</span>
                            <span class="cw-kv-val">{{
                                t(
                                    quote.token
                                        ? 'domainsPriceBurned'
                                        : 'domainsPriceCyber',
                                    {
                                        amount: amount(
                                            quote.fee,
                                            quote.decimals,
                                        ),
                                        symbol: quote.symbol,
                                    },
                                )
                            }}</span>
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('mintFee') }}</span>
                            <span class="cw-kv-val" style="white-space: nowrap"
                                >≤ {{ amount(quote.gasFee, 18) }} CYBER</span
                            >
                        </div>
                    </div>
                    <p
                        v-if="quote.needsApproval"
                        class="cw-prose"
                        style="margin-top: 10px"
                    >
                        {{
                            t('domainsApproveFirst', {
                                amount: amount(quote.fee, quote.decimals),
                                symbol: quote.symbol,
                            })
                        }}
                    </p>
                    <p
                        v-if="short"
                        class="cw-note cw-note-warn"
                        style="margin-top: 10px"
                    >
                        <span style="flex: 1">{{
                            t('domainsShort', { symbol: quote.symbol })
                        }}</span>
                        <button
                            v-if="quote.token"
                            type="button"
                            class="cw-back"
                            @click="emit('swap', quote.token)"
                        >
                            {{ t('domainsBuyToken', { symbol: quote.symbol }) }}
                        </button>
                    </p>
                    <div style="margin-top: 14px">
                        <HoldButton
                            :label="
                                registering
                                    ? t('domainsRegistering')
                                    : t('domainsRegisterHold', {
                                          name: `${quote.label}.${quote.zone}`,
                                      })
                            "
                            :disabled="registering || !canSign || short"
                            @complete="register"
                        />
                    </div>
                </template>

                <p v-if="registered" class="cw-note" style="margin-top: 12px">
                    <span style="flex: 1">{{
                        t('domainsRegistered', { name: registered.name })
                    }}</span>
                    <a
                        class="cw-back"
                        :href="domainTxUrl(registered.hash)"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ t('domainsExplorer') }}</a
                    >
                </p>
            </form>

            <div class="cw-row" style="margin: 26px 0 10px">
                <span class="cw-label">{{ t('domainsMine') }}</span>
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    mine.length
                }}</span>
            </div>

            <p v-if="failure" class="cw-note cw-note-bad">
                <span style="flex: 1">{{ failure }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>
            <p
                v-else-if="loading"
                class="cw-label"
                style="color: var(--cw-faint)"
            >
                {{ t('domainsLoading') }}
            </p>
            <p v-else-if="mine.length === 0" class="cw-prose">
                {{ t('domainsNone') }}
            </p>
            <div v-else class="cw-stack" style="gap: 8px">
                <button
                    v-for="entry in mine"
                    :key="entry.name"
                    type="button"
                    class="cw-card"
                    style="
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 12px;
                        padding: 14px 16px;
                        color: inherit;
                        font: inherit;
                        text-align: left;
                        cursor: pointer;
                    "
                    @click="manage(entry.label, entry.zone)"
                >
                    <span
                        style="
                            font: 500 15px/1.2 var(--cw-mono);
                            overflow-wrap: anywhere;
                        "
                        >{{ entry.name }}</span
                    >
                    <span class="cw-label">{{ t('domainsManage') }} →</span>
                </button>
            </div>

            <div class="cw-label" style="margin: 26px 0 10px">
                {{ t('domainsZones') }}
            </div>
            <div class="cw-card" style="padding: 6px 16px">
                <div v-for="entry in zones" :key="entry.zone" class="cw-kv">
                    <span class="cw-kv-key" style="font-family: var(--cw-mono)"
                        >.{{ entry.zone }}</span
                    >
                    <span class="cw-kv-val">{{
                        t(
                            entry.token
                                ? 'domainsPriceBurned'
                                : 'domainsPriceCyber',
                            {
                                amount: amount(entry.fee, entry.decimals),
                                symbol: entry.symbol,
                            },
                        )
                    }}</span>
                </div>
            </div>
            <p class="cw-prose" style="margin-top: 12px; max-width: 62ch">
                {{
                    t('domainsZonesBody', {
                        name: zoneTokenNaming('moon').name,
                        symbol: zoneTokenNaming('moon').symbol,
                    })
                }}
            </p>
            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="emit('launchpad')"
            >
                {{ t('domainsOpenLaunchpad') }} →
            </button>

            <form
                class="cw-card"
                style="margin-top: 16px; padding: 16px"
                @submit.prevent="openZone"
            >
                <label
                    class="cw-label"
                    style="display: block; margin-bottom: 6px"
                >
                    {{ t('domainsZoneByToken') }}
                </label>
                <input
                    v-model="zoneToken"
                    class="cw-input"
                    type="text"
                    spellcheck="false"
                    autocapitalize="none"
                    placeholder="0x…"
                />
                <button
                    type="submit"
                    class="cw-btn cw-btn-secondary"
                    style="height: 44px; margin-top: 10px; width: 100%"
                    :disabled="openingZone || !canSign || zoneToken === ''"
                >
                    {{
                        openingZone
                            ? t('domainsZoneOpening')
                            : t('domainsZoneOpen')
                    }}
                </button>
                <p
                    v-if="zoneMessage"
                    class="cw-note"
                    :class="zoneMessage.ok ? '' : 'cw-note-bad'"
                    style="margin-top: 10px"
                >
                    <span>{{ zoneMessage.text }}</span>
                </p>
            </form>
        </template>
    </div>
</template>
