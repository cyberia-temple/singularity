<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import type { ChangelogRelease } from '@/types';
import type { ChangelogProductTrack, ChangelogDevelopmentGroup } from '@/types/changelog';

defineProps<{
    currentVersion: string;
    releases: ChangelogRelease[];
    productTracks: ChangelogProductTrack[];
    developmentUpdates: ChangelogDevelopmentGroup[];
}>();
</script>

<template>
    <Head title="Changelog" />

    <section class="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
        <header class="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
                <p class="font-mono text-sm text-muted-foreground">
                    Platform {{ currentVersion }}
                </p>
                <h1 class="mt-2 text-3xl font-semibold tracking-tight">
                    Changelog
                </h1>
            </div>
            <p class="max-w-xl text-sm leading-6 text-muted-foreground">
                Cyberia Wallet 1.x, legacy platform releases, and the planned
                Cyberia 2.0 milestone follow separate timelines.
            </p>
        </header>

        <div class="mb-10 grid gap-4 md:grid-cols-3">
            <article v-for="track in productTracks" :key="track.id" class="rounded-lg border bg-card p-5">
                <p class="font-mono text-sm text-muted-foreground">{{ track.version }}</p>
                <h2 class="mt-2 text-lg font-semibold">{{ track.name }}</h2>
                <p class="mt-1 text-xs font-medium text-muted-foreground">{{ track.status }}</p>
                <p class="mt-3 text-sm leading-6 text-muted-foreground">{{ track.description }}</p>
            </article>
        </div>

        <section class="mb-12">
            <h2 class="text-xl font-semibold">Recent development</h2>
            <p class="mt-2 mb-5 text-sm leading-6 text-muted-foreground">
                Merged source changes, not numbered Wallet 1.x releases or proof of store publication.
            </p>
            <div class="space-y-6">
                <section v-for="group in developmentUpdates" :key="group.id">
                    <h3 class="mb-3 text-base font-semibold">{{ group.name }}</h3>
                    <div class="space-y-3">
                        <article v-for="item in group.items" :key="item.commit" class="rounded-lg border bg-card p-4">
                            <div class="flex flex-wrap items-baseline justify-between gap-2">
                                <h4 class="text-sm font-semibold">{{ item.title }}</h4>
                                <time class="font-mono text-xs text-muted-foreground">{{ item.date }}</time>
                            </div>
                            <p class="mt-2 text-sm leading-6 text-muted-foreground">{{ item.description }}</p>
                            <a
                                :href="`https://github.com/cyberia-temple/singularity/commit/${item.commit}`"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="mt-2 inline-block text-xs font-medium text-brand-cyan hover:underline"
                            >View commit</a>
                        </article>
                    </div>
                </section>
            </div>
        </section>

        <h2 class="mb-2 text-xl font-semibold">Legacy platform releases (0.x)</h2>
        <p class="mb-5 text-sm leading-6 text-muted-foreground">
            Historical versions of the Cyberia site and ecosystem. These are not Wallet 1.x build numbers.
        </p>
        <div class="space-y-5">
            <article
                v-for="entry in releases"
                :key="entry.version"
                class="rounded-lg border bg-card p-5 shadow-xs"
            >
                <div
                    class="flex flex-wrap items-baseline justify-between gap-2 border-b pb-4"
                >
                    <div>
                        <h2 class="font-mono text-lg font-semibold">
                            {{ entry.version }}
                        </h2>
                        <p class="mt-1 text-sm text-muted-foreground">
                            {{ entry.title }}
                        </p>
                    </div>
                    <time class="font-mono text-sm text-muted-foreground">
                        {{ entry.date }}
                    </time>
                </div>

                <div class="mt-5 grid gap-5 sm:grid-cols-2">
                    <section
                        v-for="section in entry.sections"
                        :key="`${entry.version}-${section.label}`"
                    >
                        <h3
                            class="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
                        >
                            {{ section.label }}
                        </h3>
                        <ul class="mt-2 space-y-2 text-sm leading-6">
                            <li
                                v-for="item in section.items"
                                :key="item"
                                class="border-l-2 border-brand-cyan/70 pl-3"
                            >
                                {{ item }}
                            </li>
                        </ul>
                    </section>
                </div>
            </article>
        </div>
    </section>
</template>
