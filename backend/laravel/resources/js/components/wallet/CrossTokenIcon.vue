<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { logoForToken } from '@/lib/tokenLogos';
import { CROSS_NATIVE } from '@/lib/wallet/crosschain';
import type { CrossToken } from '@/lib/wallet/crosschain';

const props = defineProps<{ token: CrossToken | null }>();
const failed = ref(false);
const logo = computed(() => {
    const token = props.token;

    if (!token) {
        return undefined;
    }

    const address =
        token.address === CROSS_NATIVE ||
        (token.verified && !token.logo && token.name === token.symbol)
            ? null
            : token.address;

    return (
        logoForToken(token.chainId, address, token.symbol) ??
        (token.logo || undefined)
    );
});
watch(logo, () => {
    failed.value = false;
});
</script>
<template>
    <span class="cross-token-icon" aria-hidden="true"
        ><img
            v-if="logo && !failed"
            :src="logo"
            alt=""
            @error="failed = true"
        /><template v-else>{{
            (token?.symbol ?? '?').slice(0, 3)
        }}</template></span
    >
</template>
<style scoped>
.cross-token-icon {
    flex: none;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--cw-raised);
    color: var(--cw-text);
    font-size: 10px;
    font-weight: 700;
    overflow: hidden;
}
.cross-token-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
}
</style>
