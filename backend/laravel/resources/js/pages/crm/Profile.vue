<script setup lang="ts">
import { Head, Link, useForm, useHttp } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { consoleMessages } from '@/lib/consoleMessages';
import crm from '@/routes/crm';
import profileRoutes from '@/routes/crm/profile';
import security from '@/routes/security';

const props = defineProps<{
    profile: {
        display_name: string;
        role: string | null;
        bio: string | null;
        contacts: Record<string, string>;
        theme: string;
        registered_at: string | null;
        avatar: string | null;
        account_email: string;
    };
    stats: {
        completed: number;
        active: number;
        created: number;
        comments: number;
        rank: number;
    };
}>();
const { t } = useLocale(consoleMessages);
const fields = [
    'email',
    'phone',
    'telegram',
    'x',
    'discord',
    'github',
    'website',
];
const form = useForm({
    display_name: props.profile.display_name,
    role: props.profile.role ?? '',
    bio: props.profile.bio ?? '',
    contacts: Object.fromEntries(
        fields.map((k) => [k, props.profile.contacts[k] ?? '']),
    ),
    avatar: null as File | null,
    remove_avatar: false,
});
const themeForm = useHttp<{ theme: string }, { theme: string }>({
    theme: props.profile.theme,
});
const preview = ref<string | null>(null);
const initials = computed(() =>
    form.display_name
        .split(/\s+/)
        .slice(0, 2)
        .map((x) => x[0])
        .join('')
        .toUpperCase(),
);
function photo(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    form.avatar = file;
    form.remove_avatar = false;

    if (preview.value) {
URL.revokeObjectURL(preview.value);
}

    preview.value = file ? URL.createObjectURL(file) : null;
}
function save() {
    form.post(profileRoutes.update.url(), {
        forceFormData: true,
        preserveScroll: true,
    });
}
async function selectTheme(theme: string) {
    themeForm.theme = theme;
    await themeForm.submit(profileRoutes.theme());
    window.location.reload();
}
</script>
<template>
    <div class="operator-page">
        <Head :title="t('profile.title')" />
        <header class="operator-heading">
            <div>
                <h1>{{ t('profile.title') }}</h1>
                <p>{{ t('profile.intro') }}</p>
            </div>
            <Link :href="crm.index()" class="mk-btn">{{
                t('profile.back')
            }}</Link>
        </header>
        <div class="operator-grid">
            <form class="operator-form mk-panel" @submit.prevent="save">
                <div class="operator-card">
                    <div class="operator-avatar">
                        <img
                            v-if="
                                preview ||
                                (!form.remove_avatar && profile.avatar)
                            "
                            :src="preview || profile.avatar!"
                            alt=""
                        /><span v-else>{{ initials }}</span>
                    </div>
                    <div>
                        <strong>{{ form.display_name }}</strong>
                        <p>{{ form.role }}</p>
                    </div>
                    <span class="mk-tag"
                        >{{ t('profile.rank') }} {{ stats.rank + 1 }}</span
                    >
                </div>
                <label
                    >{{ t('profile.name')
                    }}<input
                        v-model="form.display_name"
                        class="mk-input"
                        required
                        maxlength="80" /></label
                ><label
                    >{{ t('profile.role')
                    }}<input
                        v-model="form.role"
                        class="mk-input"
                        maxlength="120" /></label
                ><label class="wide"
                    >{{ t('profile.bio')
                    }}<textarea
                        v-model="form.bio"
                        class="mk-input"
                        rows="5"
                        maxlength="2000"
                    />
                </label>
                <label class="wide"
                    >{{ t('profile.photo')
                    }}<input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        @change="photo"
                    /><button
                        v-if="profile.avatar"
                        type="button"
                        class="mk-btn mk-ghost"
                        @click="
                            form.remove_avatar = true;
                            preview = null;
                        "
                    >
                        ×
                    </button></label
                >
                <h2 class="mk-k wide">{{ t('profile.contacts') }}</h2>
                <label v-for="field in fields" :key="field"
                    >{{ field
                    }}<input
                        v-model="form.contacts[field]"
                        class="mk-input"
                        :type="
                            field === 'email'
                                ? 'email'
                                : field === 'website'
                                  ? 'url'
                                  : field === 'phone'
                                    ? 'tel'
                                    : 'text'
                        "
                /></label>
                <p v-if="form.hasErrors" class="operator-error wide">
                    {{ Object.values(form.errors)[0] }}
                </p>
                <button class="mk-btn mk-act" :disabled="form.processing">
                    {{
                        profile.registered_at
                            ? t('profile.save')
                            : t('profile.register')
                    }}
                </button>
            </form>
            <aside>
                <section class="mk-panel operator-side">
                    <h2 class="mk-k">{{ t('profile.activity') }}</h2>
                    <dl>
                        <div
                            v-for="key in [
                                'completed',
                                'active',
                                'created',
                                'comments',
                            ]"
                            :key="key"
                        >
                            <dt>{{ t(`profile.${key}`) }}</dt>
                            <dd class="mk-num">
                                {{ stats[key as keyof typeof stats] }}
                            </dd>
                        </div>
                    </dl>
                </section>
                <section class="mk-panel operator-side">
                    <h2 class="mk-k">{{ t('profile.theme') }}</h2>
                    <div class="theme-list">
                        <button
                            v-for="item in [
                                'cyberia',
                                'burichan',
                                'yotsuba',
                                'photon',
                                'wakaba',
                            ]"
                            :key="item"
                            type="button"
                            class="mk-btn"
                            :class="{ 'mk-act': themeForm.theme === item }"
                            :disabled="themeForm.processing"
                            @click="selectTheme(item)"
                        >
                            {{ item }}
                        </button>
                    </div>
                </section>
                <section class="mk-panel operator-side">
                    <p>{{ profile.account_email }}</p>
                    <Link :href="security.edit()" class="mk-btn">{{
                        t('profile.security')
                    }}</Link>
                </section>
            </aside>
        </div>
    </div>
</template>
