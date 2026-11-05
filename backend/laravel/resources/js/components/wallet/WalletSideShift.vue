<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
    coins as coinsRoute,
    pair as pairRoute,
    create as createRoute,
} from '@/actions/App/Http/Controllers/Api/WalletSideShiftController';
import { useLocale } from '@/composables/useLocale';
import { walletMessages } from '@/lib/walletMessages';

type Coin = {
    coin: string;
    name: string;
    networks: string[];
    fixedOnly?: boolean | string[];
    depositOffline?: boolean | string[];
    settleOffline?: boolean | string[];
    networksWithMemo?: string[];
};
type Shift = {
    id: string;
    depositAddress: string;
    depositMemo?: string;
    depositMin: string;
    depositMax: string;
    expiresAt: string;
    settleAddress: string;
    depositCoin: string;
    depositNetwork: string;
    settleCoin: string;
    settleNetwork: string;
};
const emit = defineEmits<{ back: [] }>();
const { locale } = useLocale(walletMessages);
const ru = computed(() => locale.value === 'ru');
const text = (en: string, russian: string) => (ru.value ? russian : en);
const coins = ref<Coin[]>([]);
const deposit = ref('ETH');
const settle = ref('BTC');
const depositNetwork = ref('ethereum');
const settleNetwork = ref('bitcoin');
const amount = ref('');
const settleAddress = ref('');
const refundAddress = ref('');
const settleMemo = ref('');
const refundMemo = ref('');
const pair = ref<{ min: string; max: string; rate: string } | null>(null);
const shift = ref<Shift | null>(null);
const loading = ref(false);
const error = ref('');
const coin = (id: string) => coins.value.find((c) => c.coin === id);
const offline = (value: boolean | string[] | undefined, network: string) =>
    value === true || (Array.isArray(value) && value.includes(network));
const usable = (c: Coin, kind: 'deposit' | 'settle') =>
    c.networks.filter(
        (n) =>
            !offline(c.fixedOnly, n) &&
            !offline(
                kind === 'deposit' ? c.depositOffline : c.settleOffline,
                n,
            ),
    );
const sourceCoins = computed(() =>
    coins.value.filter((c) => usable(c, 'deposit').length),
);
const destinationCoins = computed(() =>
    coins.value.filter((c) => usable(c, 'settle').length),
);
const sourceNetworks = computed(() =>
    coin(deposit.value) ? usable(coin(deposit.value)!, 'deposit') : [],
);
const destinationNetworks = computed(() =>
    coin(settle.value) ? usable(coin(settle.value)!, 'settle') : [],
);
watch(sourceNetworks, (list) => {
    if (!list.includes(depositNetwork.value)) {
        depositNetwork.value = list[0] ?? '';
    }
});
watch(destinationNetworks, (list) => {
    if (!list.includes(settleNetwork.value)) {
        settleNetwork.value = list[0] ?? '';
    }
});
let pairGeneration = 0;
watch([deposit, settle, depositNetwork, settleNetwork, amount], () => {
    pairGeneration++;
    pair.value = null;
    error.value = '';
});
const payload = () => ({
    depositCoin: deposit.value,
    depositNetwork: depositNetwork.value,
    settleCoin: settle.value,
    settleNetwork: settleNetwork.value,
});
const read = async (response: Response) => {
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error ?? 'SideShift error');
    }

    return body;
};
onMounted(async () => {
    try {
        coins.value = await read(await fetch(coinsRoute.url()));
    } catch (e) {
        error.value = e instanceof Error ? e.message : 'SideShift error';
    }
});
const getPair = async () => {
    loading.value = true;
    error.value = '';
    pair.value = null;

    const generation = ++pairGeneration;

    try {
        const params = new URLSearchParams({
            ...payload(),
            ...(amount.value ? { amount: amount.value } : {}),
        });
        const result = await read(await fetch(`${pairRoute.url()}?${params}`));

        if (generation === pairGeneration) {
            pair.value = result;
        }
    } catch (e) {
        error.value = e instanceof Error ? e.message : 'SideShift error';
    } finally {
        loading.value = false;
    }
};
const create = async () => {
    if (!pair.value || loading.value) {
        return;
    }

    loading.value = true;
    error.value = '';

    try {
        shift.value = await read(
            await fetch(createRoute.url(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    ...payload(),
                    settleAddress: settleAddress.value.trim(),
                    refundAddress: refundAddress.value.trim(),
                    ...(settleMemo.value
                        ? { settleMemo: settleMemo.value }
                        : {}),
                    ...(refundMemo.value
                        ? { refundMemo: refundMemo.value }
                        : {}),
                }),
            }),
        );
    } catch (e) {
        error.value = e instanceof Error ? e.message : 'SideShift error';
    } finally {
        loading.value = false;
    }
};
</script>
<template>
    <div class="cw-stack cw-screen" data-replay-block>
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ text('Wallet', 'Кошелёк') }}
        </button>
        <h2 class="cw-title" style="margin: 22px 0 8px">SideShift</h2>
        <p class="cw-prose">
            {{
                text(
                    'Exchange through SideShift. The rate changes until your deposit arrives. The 2% Cyberia commission is included in the rate.',
                    'Обмен через SideShift. Курс меняется до поступления депозита. Комиссия Cyberia 2% включена в курс.',
                )
            }}
        </p>
        <template v-if="!shift">
            <div class="ss-grid">
                <label
                    ><span>{{ text('You send', 'Отдаёте') }}</span
                    ><select v-model="deposit" class="cw-input">
                        <option
                            v-for="c in sourceCoins"
                            :key="c.coin"
                            :value="c.coin"
                        >
                            {{ c.coin }} · {{ c.name }}
                        </option></select
                    ><select v-model="depositNetwork" class="cw-input">
                        <option v-for="n in sourceNetworks" :key="n">
                            {{ n }}
                        </option>
                    </select></label
                >
                <label
                    ><span>{{ text('You receive', 'Получаете') }}</span
                    ><select v-model="settle" class="cw-input">
                        <option
                            v-for="c in destinationCoins"
                            :key="c.coin"
                            :value="c.coin"
                        >
                            {{ c.coin }} · {{ c.name }}
                        </option></select
                    ><select v-model="settleNetwork" class="cw-input">
                        <option v-for="n in destinationNetworks" :key="n">
                            {{ n }}
                        </option>
                    </select></label
                >
            </div>
            <label class="ss-field"
                ><span>{{ text('Amount to send', 'Сумма отправки') }}</span
                ><input
                    v-model="amount"
                    class="cw-input"
                    inputmode="decimal"
                    placeholder="0"
            /></label>
            <button
                class="cw-btn cw-btn-secondary"
                type="button"
                :disabled="
                    loading || !amount || !depositNetwork || !settleNetwork
                "
                @click="getPair"
            >
                {{ text('Get estimate', 'Рассчитать курс') }}
            </button>
            <div v-if="pair" class="cw-card ss-details">
                <p>
                    {{ text('Estimated rate', 'Ориентировочный курс') }}: 1
                    {{ deposit }} ≈ {{ pair.rate }} {{ settle }}
                </p>
                <p>
                    {{ text('Deposit range', 'Допустимая сумма') }}:
                    {{ pair.min }}–{{ pair.max }} {{ deposit }}
                </p>
                <p>
                    {{
                        text(
                            'This rate is not locked.',
                            'Этот курс не фиксируется.',
                        )
                    }}
                </p>
            </div>
            <template v-if="pair">
                <label class="ss-field"
                    ><span
                        >{{ text('Receiving address', 'Адрес получения') }} ·
                        {{ settleNetwork }}</span
                    ><input
                        v-model="settleAddress"
                        class="cw-input"
                        autocomplete="off"
                /></label>
                <label
                    v-if="
                        coin(settle)?.networksWithMemo?.includes(settleNetwork)
                    "
                    class="ss-field"
                    ><span>{{
                        text('Receiving memo / tag', 'Memo / tag получателя')
                    }}</span
                    ><input v-model="settleMemo" class="cw-input"
                /></label>
                <label class="ss-field"
                    ><span
                        >{{ text('Refund address', 'Адрес возврата') }} ·
                        {{ depositNetwork }}</span
                    ><input
                        v-model="refundAddress"
                        class="cw-input"
                        autocomplete="off"
                /></label>
                <label
                    v-if="
                        coin(deposit)?.networksWithMemo?.includes(
                            depositNetwork,
                        )
                    "
                    class="ss-field"
                    ><span>{{
                        text('Refund memo / tag', 'Memo / tag для возврата')
                    }}</span
                    ><input v-model="refundMemo" class="cw-input"
                /></label>
                <p class="cw-prose">
                    {{
                        text(
                            'Check both addresses and networks. SideShift receives the deposit and sends the payout; Cyberia cannot cancel or recover it.',
                            'Проверьте оба адреса и сети. SideShift получает депозит и отправляет выплату; Cyberia не может отменить или вернуть перевод.',
                        )
                    }}
                </p>
                <button
                    type="button"
                    class="cw-btn"
                    :disabled="
                        loading ||
                        !settleAddress.trim() ||
                        !refundAddress.trim()
                    "
                    @click="create"
                >
                    {{
                        text('Create deposit address', 'Создать адрес депозита')
                    }}
                </button>
            </template>
        </template>
        <div v-else class="cw-card ss-details">
            <h3>{{ text('Send the deposit', 'Отправьте депозит') }}</h3>
            <p>
                {{ text('Send only', 'Отправляйте только') }}
                {{ shift.depositCoin }} · {{ shift.depositNetwork }}
            </p>
            <p>
                {{ text('Address', 'Адрес') }}:
                <strong class="ss-address">{{ shift.depositAddress }}</strong>
            </p>
            <p v-if="shift.depositMemo">
                <strong>Memo / tag: {{ shift.depositMemo }}</strong>
            </p>
            <p>
                {{ text('Deposit range', 'Допустимая сумма') }}:
                {{ shift.depositMin }}–{{ shift.depositMax }}
                {{ shift.depositCoin }}
            </p>
            <p>
                {{ text('Expires', 'Действует до') }}:
                {{ new Date(shift.expiresAt).toLocaleString() }}
            </p>
            <p>
                {{ text('Payout address', 'Адрес получения') }}:
                <span class="ss-address">{{ shift.settleAddress }}</span>
            </p>
            <p>
                {{
                    text(
                        'Save the order link before leaving this screen. No transfer has been sent by the wallet.',
                        'Сохраните ссылку на обмен перед выходом. Кошелёк ещё не отправил перевод.',
                    )
                }}
            </p>
            <a
                :href="`https://sideshift.ai/orders/${encodeURIComponent(shift.id)}`"
                target="_blank"
                rel="noopener noreferrer"
                >{{
                    text('Open order on SideShift', 'Открыть обмен в SideShift')
                }}
                ↗</a
            >
        </div>
        <p v-if="error" class="cw-note cw-note-bad">{{ error }}</p>
    </div>
</template>
<style scoped>
.ss-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 20px;
}
.ss-grid label,
.ss-field {
    display: grid;
    gap: 8px;
}
.ss-field {
    margin-top: 14px;
}
.ss-grid span,
.ss-field span {
    color: var(--cw-dim);
    font-size: 13px;
}
.ss-details {
    padding: 16px;
    margin-top: 16px;
    display: grid;
    gap: 8px;
}
.ss-address {
    overflow-wrap: anywhere;
}
@media (max-width: 480px) {
    .ss-grid {
        grid-template-columns: 1fr;
    }
}
</style>
