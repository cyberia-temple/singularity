<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { useLocale } from '@/composables/useLocale';
import { haptic } from '@/lib/mobileShell';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The camera, reading one QR code and closing.
 *
 * Built on the browser's own BarcodeDetector (Chromium, the Android app's
 * WebView included), so nothing leaves the device and nothing is bundled: a
 * browser without it never shows the button that opens this (see
 * `qrScanSupported()`). What was read is handed up as text; deciding whether it
 * is an address belongs to the screen that asked.
 */

const emit = defineEmits<{ detected: [text: string]; close: [] }>();

const { t } = useLocale(walletMessages);

const video = ref<HTMLVideoElement | null>(null);
const error = ref<string | null>(null);

let stream: MediaStream | null = null;
let timer: number | null = null;

interface Detector {
    detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}

const stop = (): void => {
    if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
    }

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
};

onMounted(async () => {
    const Ctor = (
        window as unknown as {
            BarcodeDetector?: new (o: { formats: string[] }) => Detector;
        }
    ).BarcodeDetector;

    if (!Ctor) {
        error.value = t('qrUnsupported');

        return;
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
        });
    } catch {
        error.value = t('qrNoCamera');

        return;
    }

    if (!video.value) {
        stop();

        return;
    }

    video.value.srcObject = stream;
    await video.value.play().catch(() => undefined);

    const detector = new Ctor({ formats: ['qr_code'] });
    let busy = false;

    timer = window.setInterval(async () => {
        if (busy || !video.value || video.value.readyState < 2) {
            return;
        }

        busy = true;

        try {
            const codes = await detector.detect(video.value);
            const text = codes[0]?.rawValue?.trim();

            if (text) {
                haptic('success');
                stop();
                emit('detected', text);
            }
        } catch {
            // A frame the detector could not read; the next one will do.
        } finally {
            busy = false;
        }
    }, 250);
});

onBeforeUnmount(stop);

const close = (): void => {
    stop();
    emit('close');
};
</script>

<template>
    <div class="cw-qr" role="dialog" :aria-label="t('qrScanTitle')">
        <div class="cw-qr__frame">
            <video ref="video" class="cw-qr__video" playsinline muted />
            <div class="cw-qr__aim" aria-hidden="true" />
        </div>
        <p class="cw-qr__hint">{{ error ?? t('qrScanHint') }}</p>
        <button type="button" class="cw-btn" @click="close">
            {{ t('qrClose') }}
        </button>
    </div>
</template>

<style scoped>
.cw-qr {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
    background: rgb(5 9 10 / 0.94);
}

.cw-qr__frame {
    position: relative;
    width: min(78vw, 360px);
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 18px;
    background: #000;
}

.cw-qr__video {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.cw-qr__aim {
    position: absolute;
    inset: 14%;
    border: 2px solid var(--cw-accent, #00e5d1);
    border-radius: 14px;
    box-shadow: 0 0 0 999px rgb(0 0 0 / 0.35);
}

.cw-qr__hint {
    max-width: 360px;
    margin: 0;
    color: #cfe9e6;
    text-align: center;
}
</style>
