import {
    analytics,
    bridge,
    convert,
    cyber,
    download,
    farm,
    feed,
    heatmap,
    fuji,
    launchpad,
    leaderboard,
    lending,
    liquidity,
    market,
    pixels,
    predictions,
    staking,
    swap,
    wallet,
    whitepaper,
} from '@/routes';
import { index as arenaIndex } from '@/routes/arena';
import { index as boardIndex } from '@/routes/board';
import { index as daoIndex } from '@/routes/dao';
import { index as lainIndex } from '@/routes/lain';
import { index as tokensIndex } from '@/routes/tokens';
import { index as trackerIndex } from '@/routes/tracker';

export type Web3NavItem = {
    title: string;
    href: string;
    external?: boolean;
};

export type Web3NavGroup = {
    label: string;
    items: Web3NavItem[];
};

/**
 * The wallet, alone and ahead of the groups.
 *
 * It is not a category and it does not belong inside one: everything under
 * Trade needs an account and a connected extension, and the wallet is the one
 * thing here that needs neither. Buried one hover deep it was a page nobody
 * found, which is exactly what happened.
 */
export const walletItem: Web3NavItem = { title: 'Wallet', href: wallet().url };

/**
 * Where the apps come from, next to the thing they contain.
 *
 * Inside a menu group this was unreachable in the only way that matters: the
 * apps existed for months with no address to send anyone to, so they travelled
 * as files in chat messages.
 */
export const downloadItem: Web3NavItem = {
    title: 'Get the app',
    href: download().url,
};

/** Rendered as plain links ahead of the groups, in this order. */
export const topLevelItems: Web3NavItem[] = [walletItem, downloadItem];

export const navGroups: Web3NavGroup[] = [
    {
        label: 'Trade',
        items: [
            { title: 'Swap', href: swap().url },
            { title: 'Bridge', href: bridge().url },
            { title: 'Convert', href: convert().url },
            { title: 'Lending', href: lending().url },
            { title: 'Liquidity', href: liquidity().url },
            { title: 'Farm', href: farm().url },
            { title: 'Staking', href: staking().url },
            { title: 'Launchpad', href: launchpad().url },
            { title: 'Tokens', href: tokensIndex().url },
            { title: 'Heatmap', href: heatmap().url },
        ],
    },
    {
        label: 'Community',
        items: [
            { title: 'Imageboard', href: boardIndex().url },
            { title: 'Agent Arena', href: arenaIndex().url },
            { title: 'Feed', href: feed().url },
            { title: 'DAO', href: daoIndex().url },
            { title: 'Leaderboard', href: leaderboard().url },
            { title: 'NFT Market', href: market().url },
            { title: 'Pixels', href: pixels().url },
            { title: 'Tracker', href: trackerIndex().url },
            { title: 'Predictions', href: predictions().url },
            { title: 'Talk to Lain', href: lainIndex().url },
        ],
    },
    {
        label: 'Explore',
        items: [
            { title: '$CYBER', href: cyber().url },
            { title: 'Whitepaper', href: whitepaper().url },
            { title: 'Analytics', href: analytics().url },
            { title: 'Fuji testnet', href: fuji().url },
            {
                title: 'Explorer',
                href: 'https://explorer.cyberia.church/',
                external: true,
            },
            {
                title: 'cyberia.church',
                href: 'https://cyberia.church/',
                external: true,
            },
        ],
    },
];
