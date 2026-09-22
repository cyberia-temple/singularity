<script setup lang="ts">
import { computed } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { nativeShell } from '@/lib/native';
import {
    CYBERIA_DAPPS,
    dappBridgeMode,
    hasInjectedProvider,
} from '@/lib/wallet/dapps';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The Wired: what is on this chain, and how a page here gets to talk to a
 * wallet at all.
 *
 * This screen deliberately does not embed anything. A page in a browser tab
 * cannot script a cross-origin frame, so it cannot hand another site a
 * provider; and this vault lives in this origin's storage, so a frame that
 * could reach it could read the keys. Both walls are the browser's, not this
 * app's, and the honest response is a directory plus the name of the build
 * that *can* mediate — which is Cyberia's extension, per origin, with a human
 * in front of every signature.
 *
 * The other half is that several of these are already in the wallet: swapping,
 * farming, the launchpad, the DAO and the bridge have their own screens here,
 * signed by this key without a page in the middle. Those rows say so, because
 * the shortest way to use a dapp safely is not to need one.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    swap: [];
    earn: [];
    launchpad: [];
    dao: [];
    bridge: [];
}>();

const { t } = useLocale(walletMessages);

const mode = computed(() =>
    dappBridgeMode(nativeShell(), hasInjectedProvider()),
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
</script>

<template>
    <div class="cw-stack">
        <h2 class="cw-title" style="margin: 18px 0 8px">
            {{ t('browseTitle') }}
        </h2>
        <p class="cw-prose" style="max-width: 62ch">{{ t('browseBody') }}</p>

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
                v-if="mode !== 'extension'"
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
                <a
                    :href="row.path"
                    style="
                        display: flex;
                        flex: 1;
                        min-width: 0;
                        align-items: flex-start;
                        gap: 12px;
                        color: inherit;
                        text-decoration: none;
                    "
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
                            }}<template v-if="!row.signs">
                                · {{ t('browseReadOnly') }}</template
                            ></span
                        >
                    </span>
                </a>

                <!--
                  The shortest way to use a dapp safely is not to need one:
                  where the wallet already does this itself, that is a control
                  of its own, and the row behind it still goes to the page.
                -->
                <button
                    v-if="row.internal"
                    type="button"
                    class="cw-ghost"
                    style="flex: none"
                    @click="openInternal(row.internal)"
                >
                    {{ t('browseOpenHere') }}
                </button>
            </div>
        </div>

        <p class="cw-prose" style="margin-top: 18px; max-width: 62ch">
            {{ t('browseLeavingNote') }}
        </p>
    </div>
</template>
