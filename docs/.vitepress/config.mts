import { defineConfig } from 'vitepress';

const userGuide = [
    { text: 'Overview', link: '/user-guide/' },
    { text: 'Crypto basics', link: '/user-guide/crypto-basics' },
    { text: 'Getting started', link: '/user-guide/getting-started' },
    { text: 'Cyberia Wallet', link: '/user-guide/wallet' },
    { text: 'Why CYBER exists', link: '/user-guide/cyber' },
    { text: 'Bridge', link: '/user-guide/bridge' },
    { text: 'DEX and swapping', link: '/user-guide/dex' },
    { text: 'Liquidity and farming', link: '/user-guide/liquidity' },
    { text: 'Explore the ecosystem', link: '/user-guide/ecosystem' },
    { text: 'Apps and downloads', link: '/user-guide/apps' },
    { text: 'Tokens and contracts', link: '/user-guide/tokens' },
    { text: 'Account and profile', link: '/user-guide/account-and-profile' },
    { text: 'FAQ and troubleshooting', link: '/user-guide/faq' },
];

const developerGuide = [
    { text: 'Developer overview', link: '/developers/' },
    { text: 'Architecture', link: '/developers/architecture' },
    { text: 'Component guide', link: '/developers/components' },
    { text: 'Local development', link: '/developers/local-development' },
    { text: 'Testing and verification', link: '/developers/testing' },
    { text: 'Network reference', link: '/developers/network-reference' },
    { text: 'Inference API', link: '/ai-api' },
    { text: 'LainOS and Wired', link: '/lainos-wired' },
];

export default defineConfig({
    lang: 'en-US',
    title: 'Cyberia Docs',
    titleTemplate: ':title · Cyberia Docs',
    description:
        'User and developer documentation for the Cyberia network and Singularity monorepo.',
    sitemap: {
        hostname: 'https://docs.cyberia.church',
    },
    cleanUrls: true,
    lastUpdated: true,
    rewrites: {
        'user-guide/README.md': 'user-guide/index.md',
    },
    // Internal manuals and working artifacts remain source-controlled for the
    // team, but are not emitted into the public site or its search index.
    srcExclude: [
        'growth/**',
        'strategy/**',
        'operations/**',
        'console.md',
        'monitoring.md',
        'product-analytics.md',
        'RELEASES.md',
        'developers/running-a-node.md',
    ],
    head: [
        ['meta', { name: 'theme-color', content: '#9d6cff' }],
        ['meta', { name: 'color-scheme', content: 'dark light' }],
    ],
    themeConfig: {
        siteTitle: 'CYBERIA / DOCS',
        nav: [
            { text: 'User guide', link: '/user-guide/' },
            { text: 'Developers', link: '/developers/' },
            { text: 'AI API', link: '/ai-api' },
            {
                text: 'Live apps',
                items: [
                    { text: 'Cyberia', link: 'https://cyberia.church' },
                    { text: 'Wallet', link: 'https://cyberia.church/wallet' },
                    { text: 'Bridge', link: 'https://bridge.cyberia.church' },
                    { text: 'Ritual DEX', link: 'https://swap.cyberia.church' },
                    { text: 'Explorer', link: 'https://explorer.cyberia.church' },
                ],
            },
        ],
        sidebar: {
            '/user-guide/': [
                { text: 'Use Cyberia', items: userGuide },
            ],
            '/developers/': [
                { text: 'Build on Cyberia', items: developerGuide },
            ],
            '/': [
                { text: 'Use Cyberia', collapsed: false, items: userGuide },
                { text: 'Build', collapsed: true, items: developerGuide },
                {
                    text: 'Project',
                    collapsed: true,
                    items: [
                        { text: 'Documentation guide', link: '/contributing' },
                        { text: 'Documentation plan', link: '/documentation-plan' },
                        { text: 'Good first issues', link: '/GOOD_FIRST_ISSUES' },
                    ],
                },
            ],
        },
        search: {
            provider: 'local',
        },
        outline: {
            level: [2, 3],
            label: 'On this page',
        },
        socialLinks: [
            {
                icon: 'github',
                link: 'https://github.com/cyberia-temple/singularity',
            },
        ],
        editLink: {
            pattern:
                'https://github.com/cyberia-temple/singularity/edit/master/docs/:path',
            text: 'Edit this page on GitHub',
        },
        lastUpdated: {
            text: 'Last updated',
            formatOptions: {
                dateStyle: 'medium',
            },
        },
        docFooter: {
            prev: 'Previous page',
            next: 'Next page',
        },
        footer: {
            message: 'Open-source documentation for the Cyberia ecosystem.',
            copyright: 'Singularity is licensed under GPL-3.0.',
        },
    },
});
