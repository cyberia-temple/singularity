<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import AddressField from '@/components/wallet/AddressField.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { fetchProfile } from '@/lib/wallet/social';
import type { WalletProfile } from '@/lib/wallet/social';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The public face of an address — by default, this wallet's own.
 *
 * Which is a subtle thing to get right: the wallet holds a key, and Cyberia
 * holds accounts. The two only meet if someone linked this address to an
 * account on the site. So an unclaimed address is a first-class answer here,
 * not an error, and the screen says what claiming would do rather than
 * pretending there is a profile behind every key.
 *
 * The nickname is the one part of this that is verifiable from where the wallet
 * is standing: it lives in the CyberiaProfile contract on chain 49406. It is
 * marked as such, because everything else on the screen is a server's word.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Whose profile to show. Defaults to the active account's EVM address. */
    address?: string | null;
}>();

const emit = defineEmits<{
    back: [];
}>();

const { t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

const profile = ref<WalletProfile | null>(null);
const loading = ref(false);
const failure = ref(false);

/** This vault's EVM address, which is the identity the site would know it by. */
const own = computed(
    () =>
        props.wallet.accounts.value.find((account) => account.family === 'evm')
            ?.address ?? null,
);

const address = computed(() => props.address ?? own.value);

const isOwn = computed(
    () =>
        address.value !== null &&
        own.value !== null &&
        address.value.toLowerCase() === own.value.toLowerCase(),
);

const earned = computed(
    () => profile.value?.achievements.filter((entry) => entry.earned) ?? [],
);

const load = async (): Promise<void> => {
    const target = address.value;

    if (target === null) {
        return;
    }

    loading.value = true;
    failure.value = false;

    try {
        profile.value = await fetchProfile(target);
    } catch {
        failure.value = true;
        profile.value = null;
    } finally {
        loading.value = false;
    }
};

watch(address, load, { immediate: true });
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('feed') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ isOwn ? t('profileYours') : t('profileTitle') }}
        </h2>

        <p v-if="address === null" class="cw-prose">
            {{ t('profileNoAddress') }}
        </p>

        <template v-else>
            <AddressField
                :address="address"
                :label="t('profileAddress')"
                :copied="clipboard.copied.value === address"
                :copy-label="t('copyAddress')"
                :copied-label="t('copiedClears')"
                :expand-label="t('expandAddress')"
                @copy="clipboard.copy(address)"
            />

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 18px"
            >
                <span style="flex: 1">{{ t('profileUnreadable') }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>

            <p
                v-else-if="loading"
                class="cw-label"
                style="margin-top: 18px; color: var(--cw-faint)"
            >
                {{ t('profileLoading') }}
            </p>

            <template v-else-if="profile">
                <!--
                  Nobody on the site has claimed this address. That is a real
                  answer for a wallet whose key never met an account, so it is
                  rendered as one rather than as a failure.
                -->
                <template v-if="!profile.claimed">
                    <p class="cw-prose" style="margin-top: 18px">
                        {{
                            isOwn
                                ? t('profileUnclaimedYours')
                                : t('profileUnclaimed')
                        }}
                    </p>
                    <a
                        v-if="isOwn"
                        class="cw-btn cw-btn-secondary"
                        style="margin-top: 18px; text-decoration: none"
                        href="/profile"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t('profileClaim') }}
                        <ExternalLink :size="14" aria-hidden="true" />
                    </a>
                </template>

                <template v-else>
                    <div
                        style="
                            display: flex;
                            align-items: center;
                            gap: 14px;
                            margin-top: 18px;
                        "
                    >
                        <img
                            v-if="profile.avatar"
                            :src="profile.avatar"
                            alt=""
                            style="
                                width: 48px;
                                height: 48px;
                                flex: none;
                                border: 1px solid var(--cw-hairline);
                                object-fit: cover;
                            "
                        />
                        <div style="flex: 1; min-width: 0">
                            <div
                                style="
                                    font: 500 20px/1.2 var(--cw-sans);
                                    color: var(--cw-text);
                                "
                            >
                                {{ profile.name }}
                            </div>
                            <!--
                              An on-chain nickname is the only part of this
                              screen the wallet could verify itself, so it is
                              the only part that gets to say where it is from.
                            -->
                            <div
                                v-if="profile.onchainNickname"
                                class="cw-label"
                                style="margin-top: 5px; color: var(--cw-accent)"
                            >
                                {{ t('profileOnchainName') }}
                            </div>
                        </div>
                    </div>

                    <div
                        v-if="profile.stats"
                        style="
                            display: grid;
                            grid-template-columns: repeat(3, 1fr);
                            gap: 1px;
                            margin-top: 18px;
                            border: 1px solid var(--cw-line);
                            background: var(--cw-line);
                        "
                    >
                        <div
                            style="background: var(--cw-surface); padding: 14px"
                        >
                            <div class="cw-label">{{ t('profilePosts') }}</div>
                            <div class="cw-num" style="margin-top: 8px">
                                {{ profile.stats.posts }}
                            </div>
                        </div>
                        <div
                            style="background: var(--cw-surface); padding: 14px"
                        >
                            <div class="cw-label">
                                {{ t('profileProposals') }}
                            </div>
                            <div class="cw-num" style="margin-top: 8px">
                                {{ profile.stats.proposals }}
                            </div>
                        </div>
                        <div
                            style="background: var(--cw-surface); padding: 14px"
                        >
                            <div class="cw-label">{{ t('profileVotes') }}</div>
                            <div class="cw-num" style="margin-top: 8px">
                                {{ profile.stats.votes }}
                            </div>
                        </div>
                    </div>

                    <div class="cw-label" style="margin-top: 22px">
                        {{
                            t('profileAchievements', {
                                earned: earned.length,
                                total: profile.achievements.length,
                            })
                        }}
                    </div>
                    <div
                        style="
                            display: flex;
                            flex-wrap: wrap;
                            gap: 6px;
                            margin-top: 10px;
                        "
                    >
                        <span
                            v-for="badge in profile.achievements"
                            :key="badge.id"
                            class="cw-label"
                            :title="badge.description"
                            :style="{
                                border: `1px ${badge.earned ? 'solid' : 'dashed'} var(--cw-hairline)`,
                                padding: '7px 9px',
                                color: badge.earned
                                    ? 'var(--cw-accent)'
                                    : 'var(--cw-faint)',
                            }"
                            >{{ badge.title }}</span
                        >
                    </div>

                    <a
                        v-if="profile.profileUrl"
                        class="cw-btn cw-btn-secondary"
                        style="margin-top: 22px; text-decoration: none"
                        :href="profile.profileUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t('profileOpen') }}
                        <ExternalLink :size="14" aria-hidden="true" />
                    </a>
                </template>
            </template>
        </template>
    </div>
</template>
