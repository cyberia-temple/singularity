<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Cyberia in 3D — the home page, and /3d by name: the chain drawn as a black
 * glass cube with the logo's glyphs, its newest blocks laid out as a road
 * behind it as they land, a cross-chain swap window beside it, the ecosystem
 * as two rings of doors and the launchpad's tokens as a step pyramid.
 *
 * Everything the scene shows is read live by the browser — blocks from the
 * public RPC, totals from the explorer, tokens from /api/launchpad/tokens,
 * Cyberia 2.0 from /api/fuji/chain, cross-chain prices from the wallet's own
 * /api/wallet/crosschain routes — so this only names where to read and which
 * doors there are.
 */
class TempleController extends Controller
{
    public function __invoke(Request $request): View
    {
        $chain = (array) config('cyber.chain');

        return view('landing.temple', [
            // Served as the home page it also does the home page's old job:
            // a returning wallet owner, or the installed app launching, goes
            // on to the wallet. /3d is a visit to the site on purpose.
            'home' => $request->routeIs('home'),
            'network' => [
                'name' => $chain['name'],
                'chainId' => $chain['id'],
                'chainIdHex' => $chain['id_hex'],
                'symbol' => $chain['symbol'],
                'rpc' => $chain['rpc'],
                'explorer' => $chain['explorer'].'/',
            ],
            'cyberSol' => config('cyber.contracts.cyber_sol_mint'),
            'doors' => self::doors(),
            'assetsVersion' => self::texturesVersion(),
        ]);
    }

    /**
     * One version for the scene's textures, which the script fetches by name:
     * the newest file's time, so a deploy that changes any of them reaches
     * browsers that cached the old ones.
     */
    private static function texturesVersion(): int
    {
        $files = glob(public_path('assets/3d/*.webp')) ?: [];

        return $files === [] ? 0 : max(array_map('filemtime', $files));
    }

    /**
     * The doors, in the landing page's order: what runs on the chain, then
     * what lives beyond it. `status` is live, running or dev; a door still in
     * development has no link.
     *
     * @return array{chain: list<array{icon: string, kind: string, name: string, href: string, status: string, desc: string}>, beyond: list<array{icon: string, kind: string, name: string, href: ?string, status: string, desc: string}>}
     */
    public static function doors(): array
    {
        return [
            'chain' => [
                ['icon' => 'wallet', 'kind' => 'Wallet', 'name' => 'Cyberia Wallet', 'href' => '/wallet', 'status' => 'live', 'desc' => 'One seed phrase for Cyberia, Solana, Bitcoin, Monero and every EVM network you add.'],
                ['icon' => 'swap', 'kind' => 'DEX', 'name' => 'Cyberia Swap', 'href' => '/swap', 'status' => 'live', 'desc' => 'AMM pools for CYBER and every ecosystem token, routed across the whole pair graph.'],
                ['icon' => 'bridge', 'kind' => 'Interchain', 'name' => 'Bridge', 'href' => '/bridge', 'status' => 'live', 'desc' => 'Solana, TON, BSC and Bitcoin-family chains in and out, with personal deposit addresses.'],
                ['icon' => 'dao', 'kind' => 'Governance', 'name' => 'DAO', 'href' => '/dao', 'status' => 'live', 'desc' => 'Proposals, votes and treasuries, running as software.'],
                ['icon' => 'lending', 'kind' => 'DeFi', 'name' => 'Lending', 'href' => '/lending', 'status' => 'live', 'desc' => 'Collateralized borrowing with on-chain liquidations, and farms on top of the DEX.'],
                ['icon' => 'launchpad', 'kind' => 'Token factory', 'name' => 'Launchpad', 'href' => '/launchpad', 'status' => 'live', 'desc' => 'A token in one transaction, its liquidity locked at birth.'],
                ['icon' => 'markets', 'kind' => 'Data', 'name' => 'Markets', 'href' => '/market', 'status' => 'live', 'desc' => 'Token markets, pool depth and network analytics in one place.'],
                ['icon' => 'profile', 'kind' => 'Identity', 'name' => 'Profile', 'href' => '/profile', 'status' => 'live', 'desc' => 'A nickname and achievements written to the chain.'],
                ['icon' => 'arcade', 'kind' => 'Games', 'name' => 'Arcade', 'href' => '/predictions', 'status' => 'live', 'desc' => 'Slots, prediction markets and a shared pixel canvas, settled on-chain.'],
                ['icon' => 'explorer', 'kind' => 'Infrastructure', 'name' => 'Explorer', 'href' => rtrim((string) config('cyber.chain.explorer'), '/').'/', 'status' => 'live', 'desc' => 'Every block, transaction and contract in the open.'],
            ],
            'beyond' => [
                ['icon' => 'lain', 'kind' => 'AI agents', 'name' => 'Talk to Lain', 'href' => '/lain', 'status' => 'running', 'desc' => 'The resident mind of Cyberia, built on LainOS. Sign in with a wallet.'],
                ['icon' => 'wired', 'kind' => '3D world', 'name' => 'Wired', 'href' => null, 'status' => 'dev', 'desc' => 'A 3D on-chain world whose NPCs think through LainOS and react to Cyberia blocks.'],
                ['icon' => 'nocarrier', 'kind' => 'Survival horror', 'name' => 'NO CARRIER', 'href' => null, 'status' => 'dev', 'desc' => 'Netstalking horror: tune dead frequencies and mint what you find as NFTs.'],
                ['icon' => 'telegram', 'kind' => 'Community', 'name' => 'Telegram', 'href' => 'https://t.me/cyberia_network', 'status' => 'live', 'desc' => 'The news channel, the chat and the rewards bot.'],
                ['icon' => 'os', 'kind' => 'Operating system', 'name' => 'Cyberia OS', 'href' => null, 'status' => 'dev', 'desc' => 'A Linux build that carries the chain in its base image.'],
                ['icon' => 'blog', 'kind' => 'Signal', 'name' => 'Blog', 'href' => 'https://cyberia-temple.github.io', 'status' => 'live', 'desc' => 'Devlogs, research notes and doctrine.'],
            ],
        ];
    }
}
