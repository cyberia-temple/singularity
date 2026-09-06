<script setup lang="ts">
import { formatEther, parseEther } from 'ethers';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useLocale } from '@/composables/useLocale';
import { arenaCatalogueGame } from '@/lib/arenaCatalogue';
import { arenaMessages } from '@/lib/arenaMessages';
import {
    arenaAction,
    arenaErrorCode,
    arenaGameLists,
    arenaHasOpponent,
    arenaMatchPath,
    arenaShareUrl,
    arenaSecondsRemaining,
    arenaTransactionUrl,
    formatArenaCountdown,
    parseArenaGameId,
    readArenaGame,
    readRecentArenaGames,
} from '@/lib/wallet';
import type { ArenaGame, ArenaMove } from '@/lib/wallet';

const props = defineProps<{
    wallet: MultiWallet;
    config: {
        enabled: boolean;
        contractAddress: string;
        rpcUrl: string;
        explorerUrl: string;
    };
}>();
const emit = defineEmits<{ back: [] }>();
const { t } = useLocale(arenaMessages);
const product = arenaCatalogueGame('rps')!;

const query = new URLSearchParams(window.location.search);
const linkedGameId = parseArenaGameId(query.get('game'));
const selectedGame = ref(linkedGameId !== null);
const tab = ref<'about' | 'play' | 'community'>('about');
const feedback = ref('');
const savedFeedback = ref<string[]>(
    JSON.parse(localStorage.getItem('cyberia-arena-feedback') ?? '[]'),
);
const saveFeedback = (): void => {
    const value = feedback.value.trim();
    if (!value) return;
    savedFeedback.value.unshift(value);
    localStorage.setItem(
        'cyberia-arena-feedback',
        JSON.stringify(savedFeedback.value.slice(0, 20)),
    );
    feedback.value = '';
};
const gameId = ref(linkedGameId?.toString() ?? '');
const stake = ref('0.01');
const move = ref<ArenaMove>(1);
const game = ref<ArenaGame | null>(null);
const message = ref('');
const lastTransactionHash = ref('');
const transactionUrl = computed(() =>
    arenaTransactionUrl(props.config.explorerUrl, lastTransactionHash.value),
);
const loading = ref(false);
const catalogueLoading = ref(false);
const catalogueError = ref('');
const recentGames = ref<ArenaGame[]>([]);
const nowSeconds = ref(Date.now() / 1000);
const account = computed(
    () =>
        props.wallet.accounts.value.find((row) => row.family === 'evm')
            ?.address ?? '',
);
const me = computed(() => account.value.toLowerCase());
const lists = computed(() => arenaGameLists(recentGames.value, account.value));
const isPlayer = computed(
    () =>
        game.value &&
        [game.value.playerOne, game.value.playerTwo].some(
            (a) => a.toLowerCase() === me.value,
        ),
);
const committed = computed(
    () =>
        game.value &&
        (game.value.playerOne.toLowerCase() === me.value
            ? game.value.playerOneCommitted
            : game.value.playerTwoCommitted),
);
const revealed = computed(
    () =>
        game.value &&
        (game.value.playerOne.toLowerCase() === me.value
            ? game.value.playerOneMove
            : game.value.playerTwoMove) !== 0,
);
const expired = computed(
    () => !!game.value && nowSeconds.value > game.value.deadline,
);
const countdown = computed(() =>
    game.value
        ? formatArenaCountdown(
              arenaSecondsRemaining(game.value.deadline, nowSeconds.value),
          )
        : '',
);
const states = computed(() => [
    '—',
    t('state1'),
    t('state2'),
    t('state3'),
    t('state4'),
    t('state5'),
]);
const moves = computed<{ id: ArenaMove; glyph: string; name: string }[]>(() => [
    { id: 1, glyph: '◆', name: t('rock') },
    { id: 2, glyph: '▰', name: t('paper') },
    { id: 3, glyph: '✂', name: t('scissors') },
]);

const refresh = async (): Promise<void> => {
    const parsedGameId = parseArenaGameId(gameId.value);
    if (!props.config.enabled || parsedGameId === null || !account.value)
        return;
    loading.value = true;
    try {
        game.value = await readArenaGame(
            props.config.contractAddress,
            parsedGameId,
            account.value,
            props.config.rpcUrl,
        );
        message.value = '';
    } catch (error) {
        message.value = error instanceof Error ? error.message : t('readError');
    } finally {
        loading.value = false;
    }
};
const refreshCatalogue = async (): Promise<void> => {
    if (!props.config.enabled || !account.value) return;
    catalogueLoading.value = true;
    catalogueError.value = '';
    try {
        recentGames.value = await readRecentArenaGames(
            props.config.contractAddress,
            account.value,
            props.config.rpcUrl,
        );
    } catch {
        catalogueError.value = t('matchesError');
    } finally {
        catalogueLoading.value = false;
    }
};
const openMatch = (match: ArenaGame): void => {
    game.value = match;
    gameId.value = match.id.toString();
    selectedGame.value = true;
    tab.value = 'play';
    history.replaceState({}, '', arenaMatchPath(match.id));
};
const requiredGameId = (): bigint => {
    const parsed = parseArenaGameId(gameId.value);
    if (parsed === null) throw new Error(t('invalidGameId'));
    return parsed;
};
const shareMatch = async (): Promise<void> => {
    const parsed = requiredGameId();
    const url = arenaShareUrl(window.location.origin, parsed);
    if (navigator.share) {
        await navigator.share({ title: t('rps'), url });
        return;
    }
    await navigator.clipboard.writeText(url);
    message.value = t('inviteCopied');
};
const run = async (
    action: () => Promise<unknown>,
    success: string,
): Promise<void> => {
    loading.value = true;
    message.value = '';
    try {
        const result = await action();
        const hash =
            typeof result === 'string'
                ? result
                : typeof result === 'object' &&
                    result !== null &&
                    'hash' in result &&
                    typeof result.hash === 'string'
                  ? result.hash
                  : '';
        if (hash) lastTransactionHash.value = hash;
        message.value = success;
        await refresh();
        await refreshCatalogue();
    } catch (error) {
        message.value = t(`error_${arenaErrorCode(error)}`);
    } finally {
        loading.value = false;
    }
};
const create = () =>
    run(async () => {
        const result = await props.wallet.arenaCreate(
            props.config.contractAddress,
            parseEther(stake.value),
        );
        if (result.gameId) {
            gameId.value = result.gameId.toString();
            history.replaceState({}, '', arenaMatchPath(result.gameId));
        }
        return result;
    }, t('created'));
const join = () =>
    run(
        () =>
            props.wallet.arenaJoin(
                props.config.contractAddress,
                requiredGameId(),
                game.value!.stake,
            ),
        t('joined'),
    );
const commit = () =>
    run(
        () =>
            props.wallet.arenaCommit(
                props.config.contractAddress,
                requiredGameId(),
                account.value,
                move.value,
            ),
        t('sealed'),
    );
const reveal = () =>
    run(
        () =>
            props.wallet.arenaReveal(
                props.config.contractAddress,
                requiredGameId(),
                account.value,
            ),
        t('revealed'),
    );
const settle = (method: 'resolveGame' | 'cancelExpiredGame' | 'claimPayout') =>
    run(
        () =>
            props.wallet.arenaSettle(
                props.config.contractAddress,
                requiredGameId(),
                method,
            ),
        method === 'claimPayout' ? t('claimed') : t('settled'),
    );
let timer = 0;
let ticks = 0;
const stopPolling = (): void => window.clearInterval(timer);
const startPolling = (): void => {
    stopPolling();
    timer = window.setInterval(() => {
        nowSeconds.value = Date.now() / 1000;
        ticks++;
        if (ticks % 5 === 0) {
            void refresh();
            void refreshCatalogue();
        }
    }, 1000);
};
const onVisibilityChange = (): void => {
    if (document.hidden) {
        stopPolling();
        return;
    }
    nowSeconds.value = Date.now() / 1000;
    void refresh();
    void refreshCatalogue();
    startPolling();
};
onMounted(() => {
    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
    <section>
        <template v-if="!selectedGame">
            <p class="cw-eyebrow">{{ t('eyebrow') }}</p>
            <h1 class="cw-title">{{ t('title') }}</h1>
            <p class="cw-note">{{ t('intro') }}</p>
            <p class="cw-label" style="margin: 26px 0 10px">
                {{ t('featured') }}
            </p>
            <button
                type="button"
                class="arena-feature cw-card"
                @click="selectedGame = true"
            >
                <img :src="product.cover" alt="" />
                <span class="arena-feature-copy">
                    <span class="cw-label" style="color: var(--cw-accent)">{{
                        t('live')
                    }}</span>
                    <strong>{{ t('rps') }}</strong>
                    <span class="cw-note">{{ t('rpsDesc') }}</span>
                    <span class="arena-meta"
                        ><span>{{ t('players') }}</span
                        ><span>{{ t('minutes') }}</span
                        ><span>{{ t('chain') }}</span></span
                    >
                    <span class="cw-btn cw-btn-primary">{{ t('play') }} →</span>
                </span>
            </button>
            <div class="arena-grid">
                <article class="cw-card arena-panel">
                    <span class="cw-label">{{ t('update') }}</span
                    ><strong>v0.1 · COMMIT / REVEAL</strong>
                    <p class="cw-note">{{ t('updateText') }}</p>
                </article>
                <article class="cw-card arena-panel">
                    <span class="cw-label">{{ t('community') }}</span
                    ><strong>{{ t('positive') }}</strong>
                    <p class="cw-note">{{ t('localOnly') }}</p>
                </article>
            </div>
            <section v-if="config.enabled" class="arena-matches">
                <div class="cw-row">
                    <p class="cw-label">{{ t('matches') }}</p>
                    <button
                        class="cw-ghost"
                        type="button"
                        :disabled="catalogueLoading"
                        @click="refreshCatalogue"
                    >
                        {{ t('refreshMatches') }}
                    </button>
                </div>
                <p v-if="catalogueError" class="cw-note">
                    {{ catalogueError }}
                </p>
                <p
                    v-else-if="catalogueLoading && recentGames.length === 0"
                    class="cw-note"
                >
                    {{ t('loadingMatches') }}
                </p>
                <template
                    v-for="group in [
                        ['attention', lists.attention],
                        ['mine', lists.mine],
                        ['openGames', lists.open],
                    ] as const"
                    :key="group[0]"
                >
                    <div v-if="group[1].length" class="arena-match-group">
                        <span class="cw-label">{{ t(group[0]) }}</span>
                        <button
                            v-for="match in group[1]"
                            :key="match.id.toString()"
                            type="button"
                            class="arena-match cw-card"
                            @click="openMatch(match)"
                        >
                            <span
                                ><strong>#{{ match.id }}</strong
                                ><small>{{
                                    t(`action_${arenaAction(match, account)}`)
                                }}</small></span
                            >
                            <span
                                ><strong
                                    >{{
                                        formatEther(match.stake)
                                    }}
                                    CYBER</strong
                                ><small>{{ states[match.state] }}</small></span
                            >
                        </button>
                    </div>
                </template>
                <p
                    v-if="!catalogueLoading && recentGames.length === 0"
                    class="cw-note"
                >
                    {{ t('noMatches') }}
                </p>
            </section>
            <p class="cw-label" style="margin: 26px 0 10px">
                {{ t('allGames') }}
            </p>
            <article class="cw-card arena-coming">
                <span class="cw-label">{{ t('coming') }}</span
                ><strong>{{ t('soonTitle') }}</strong>
                <p class="cw-note">{{ t('soonDesc') }}</p>
            </article>
        </template>

        <template v-else>
            <button class="cw-back" type="button" @click="selectedGame = false">
                ← {{ t('back') }}
            </button>
            <img class="arena-hero" :src="product.cover" alt="" />
            <p class="cw-eyebrow">{{ t('live') }} · {{ t('chain') }}</p>
            <h1 class="cw-title">{{ t('rps') }}</h1>
            <div class="arena-tabs">
                <button
                    v-for="item in ['about', 'play', 'community'] as const"
                    :key="item"
                    type="button"
                    :class="{ active: tab === item }"
                    @click="tab = item"
                >
                    {{ t(`tab${item[0].toUpperCase()}${item.slice(1)}`) }}
                </button>
            </div>

            <template v-if="tab === 'about'"
                ><p class="cw-note">{{ t('rpsDesc') }}</p>
                <article class="cw-card arena-panel" style="margin-top: 12px">
                    <span class="cw-label">{{ t('update') }}</span
                    ><strong>v0.1 · COMMIT / REVEAL</strong>
                    <p class="cw-note">{{ t('updateText') }}</p>
                </article></template
            >
            <template v-else-if="tab === 'community'"
                ><div class="cw-card arena-panel">
                    <span class="cw-label"
                        >{{ t('reviews') }} · {{ t('positive') }}</span
                    ><textarea
                        v-model="feedback"
                        class="cw-input"
                        :placeholder="t('commentPlaceholder')"
                        rows="3"
                    /><button
                        class="cw-btn cw-btn-primary"
                        @click="saveFeedback"
                    >
                        {{ t('publish') }}
                    </button>
                    <p class="cw-note">{{ t('localOnly') }}</p>
                    <p
                        v-for="(item, index) in savedFeedback"
                        :key="index"
                        class="arena-review"
                    >
                        {{ item }}
                    </p>
                </div></template
            >
            <template v-else>
                <div
                    v-if="!config.enabled"
                    class="cw-card"
                    style="margin-top: 20px; padding: 18px"
                >
                    {{ t('unavailable') }}
                </div>
                <template v-else>
                    <div
                        class="cw-card"
                        style="margin-top: 20px; padding: 18px"
                    >
                        <label class="cw-label">{{ t('gameId') }}</label>
                        <div style="display: flex; gap: 8px; margin-top: 8px">
                            <input
                                v-model="gameId"
                                class="cw-input"
                                inputmode="numeric"
                                placeholder="1"
                            /><button
                                class="cw-btn cw-btn-secondary"
                                :disabled="loading"
                                @click="refresh"
                            >
                                {{ t('open') }}
                            </button>
                        </div>
                        <template v-if="game">
                            <div class="cw-row" style="margin-top: 16px">
                                <span>{{ states[game.state] }}</span
                                ><span
                                    >{{ formatEther(game.stake) }} CYBER</span
                                >
                            </div>
                            <p v-if="game.state < 4" class="cw-label">
                                {{ t('deadline') }} · {{ countdown }}
                            </p>
                            <p class="cw-note">
                                P1 {{ game.playerOne }}<br />P2
                                {{
                                    arenaHasOpponent(game)
                                        ? game.playerTwo
                                        : t('waiting')
                                }}
                            </p>
                            <button
                                class="cw-ghost"
                                type="button"
                                @click="shareMatch"
                            >
                                {{ t('invite') }}
                            </button>
                        </template>
                    </div>

                    <div
                        v-if="!game"
                        class="cw-card"
                        style="margin-top: 10px; padding: 18px"
                    >
                        <label class="cw-label">{{ t('stake') }}</label
                        ><input
                            v-model="stake"
                            class="cw-input"
                            style="margin: 8px 0 14px"
                            inputmode="decimal"
                        />
                        <p class="cw-note">
                            {{ t('createHint', { stake }) }}
                        </p>
                        <HoldButton
                            :label="t('create')"
                            :disabled="loading"
                            @complete="create"
                        />
                    </div>

                    <div
                        v-else-if="game.state === 1 && !isPlayer"
                        class="cw-card"
                        style="margin-top: 10px; padding: 18px"
                    >
                        <p class="cw-note">
                            {{
                                t('joinHint', {
                                    stake: formatEther(game.stake),
                                })
                            }}
                        </p>
                        <HoldButton
                            :label="t('join')"
                            :disabled="loading"
                            @complete="join"
                        />
                    </div>

                    <div
                        v-else-if="game.state === 2 && isPlayer"
                        class="cw-card"
                        style="margin-top: 10px; padding: 18px"
                    >
                        <p class="cw-label">{{ t('choose') }}</p>
                        <div
                            style="
                                display: grid;
                                grid-template-columns: repeat(3, 1fr);
                                gap: 8px;
                                margin: 12px 0;
                            "
                        >
                            <button
                                v-for="card in moves"
                                :key="card.id"
                                type="button"
                                class="cw-tile"
                                :style="
                                    move === card.id
                                        ? { borderColor: 'var(--cw-accent)' }
                                        : {}
                                "
                                @click="move = card.id"
                            >
                                <strong style="font-size: 24px">{{
                                    card.glyph
                                }}</strong
                                ><span>{{ card.name }}</span>
                            </button>
                        </div>
                        <p class="cw-note">
                            {{ t('sealHint') }}
                        </p>
                        <HoldButton
                            :label="t('seal')"
                            :disabled="loading || !!committed"
                            @complete="commit"
                        />
                    </div>

                    <div
                        v-else-if="game.state === 3 && isPlayer"
                        class="cw-card"
                        style="margin-top: 10px; padding: 18px"
                    >
                        <p class="cw-note">
                            {{ t('revealHint') }}
                        </p>
                        <HoldButton
                            :label="t('reveal')"
                            :disabled="loading || !!revealed"
                            @complete="reveal"
                        />
                        <button
                            v-if="game.playerOneMove && game.playerTwoMove"
                            class="cw-btn cw-btn-secondary"
                            style="margin-top: 8px; width: 100%"
                            @click="settle('resolveGame')"
                        >
                            {{ t('resolve') }}
                        </button>
                    </div>
                    <button
                        v-if="expired && (game?.state ?? 5) < 4"
                        class="cw-btn cw-btn-secondary"
                        style="margin-top: 10px; width: 100%"
                        @click="settle('cancelExpiredGame')"
                    >
                        {{ t('expire') }}
                    </button>
                    <div
                        v-if="(game?.payout ?? 0n) > 0n"
                        class="cw-card"
                        style="margin-top: 10px; padding: 18px"
                    >
                        <p class="cw-note">
                            {{
                                t('payout', {
                                    amount: formatEther(game?.payout ?? 0n),
                                })
                            }}
                        </p>
                        <HoldButton
                            :label="t('claim')"
                            :disabled="loading"
                            @complete="settle('claimPayout')"
                        />
                    </div>
                </template>
                <p v-if="message" class="cw-note" style="margin-top: 12px">
                    {{ message }}
                </p>
                <a
                    v-if="transactionUrl"
                    class="cw-ghost"
                    :href="transactionUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('viewTransaction') }} ↗
                </a>
            </template>
        </template>
    </section>
</template>

<style scoped>
.arena-feature {
    width: 100%;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(240px, 1.25fr) minmax(260px, 1fr);
    overflow: hidden;
    text-align: left;
    cursor: pointer;
    border-color: var(--cw-border);
}
.arena-feature img,
.arena-hero {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.arena-feature-copy {
    padding: 24px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 13px;
}
.arena-feature-copy strong {
    font: 600 clamp(20px, 3vw, 32px)/1.1 var(--cw-sans);
    color: var(--cw-text);
}
.arena-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font: 500 9px/1 var(--cw-mono);
    color: var(--cw-dim);
}
.arena-meta span {
    border: 1px solid var(--cw-border);
    padding: 7px 9px;
}
.arena-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 10px;
    margin-top: 10px;
}
.arena-matches {
    margin-top: 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.arena-match-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.arena-match {
    width: 100%;
    padding: 12px 14px;
    display: flex;
    justify-content: space-between;
    text-align: left;
    cursor: pointer;
}
.arena-match > span {
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.arena-match > span:last-child {
    text-align: right;
}
.arena-match strong {
    color: var(--cw-text);
    font: 500 12px/1 var(--cw-mono);
}
.arena-match small {
    color: var(--cw-dim);
    font: 400 10px/1.2 var(--cw-sans);
}
.arena-panel,
.arena-coming {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.arena-panel strong,
.arena-coming strong {
    color: var(--cw-text);
}
.arena-coming {
    min-height: 140px;
    justify-content: center;
    background: linear-gradient(120deg, rgba(0, 255, 225, 0.04), transparent);
}
.arena-hero {
    height: 220px;
    margin: 12px 0 20px;
    border: 1px solid var(--cw-border);
}
.arena-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--cw-border);
    margin: 16px 0;
}
.arena-tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 10px 14px;
    background: none;
    color: var(--cw-dim);
    cursor: pointer;
}
.arena-tabs button.active {
    border-color: var(--cw-accent);
    color: var(--cw-text);
}
.arena-review {
    margin: 0;
    padding: 10px 0;
    border-top: 1px solid var(--cw-border-soft);
    color: var(--cw-text);
}
textarea.cw-input {
    resize: vertical;
    margin: 10px 0;
}
@media (max-width: 720px) {
    .arena-feature {
        grid-template-columns: 1fr;
    }
    .arena-feature img {
        height: 190px;
    }
    .arena-grid {
        grid-template-columns: 1fr;
    }
    .arena-hero {
        height: 180px;
    }
}
</style>
