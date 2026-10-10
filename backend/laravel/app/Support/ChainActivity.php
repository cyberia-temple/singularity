<?php

namespace App\Support;

use Illuminate\Support\Str;

/**
 * One on-chain action as the feed and its push say it.
 *
 * The rows come from the Telegram bot's `activity_events` — swaps on both of
 * Cyberia's exchanges, liquidity, lending, staking, CYBER.sol conversions,
 * pump.fun buys, bridges, NFT mints and sales, domains and zones, prediction
 * markets and bets — and every one of them is somebody doing something on
 * chain, so every one is told to everybody. This is where a row's `kind`
 * becomes words, its amounts become one line and its hash becomes a link to
 * the explorer that can show it, so the feed card and the notification cannot
 * describe the same act two ways.
 *
 * An unknown kind is still announced, under a generic title: a watcher added
 * to the bot tomorrow should read plainly, not vanish.
 */
class ChainActivity
{
    /** How the two amounts of a row relate: in → out, a + b, or just one. */
    private const JOIN = [
        'swap' => ' → ',
        'convert' => ' → ',
        'pumpfun_buy' => ' → ',
        'liq_add' => ' + ',
        'liq_remove' => ' + ',
    ];

    /** @var array<string, array<string, string>> */
    private const TITLES = [
        'swap' => ['en' => '{name} swapped', 'ru' => '{name}: обмен', 'zh' => '{name} 完成了兑换'],
        'liq_add' => ['en' => '{name} added liquidity', 'ru' => '{name} добавил ликвидность', 'zh' => '{name} 添加了流动性'],
        'liq_remove' => ['en' => '{name} removed liquidity', 'ru' => '{name} забрал ликвидность', 'zh' => '{name} 移除了流动性'],
        'lend_supplied' => ['en' => '{name} supplied to lending', 'ru' => '{name} внёс в лендинг', 'zh' => '{name} 存入借贷市场'],
        'lend_withdrew' => ['en' => '{name} withdrew from lending', 'ru' => '{name} вывел из лендинга', 'zh' => '{name} 从借贷市场取出'],
        'lend_borrowed' => ['en' => '{name} borrowed', 'ru' => '{name} занял', 'zh' => '{name} 借入'],
        'lend_repaid' => ['en' => '{name} repaid a loan', 'ru' => '{name} погасил долг', 'zh' => '{name} 偿还了借款'],
        'stake' => ['en' => '{name} staked', 'ru' => '{name} застейкал', 'zh' => '{name} 质押了'],
        'unstake' => ['en' => '{name} unstaked', 'ru' => '{name} снял со стейкинга', 'zh' => '{name} 解除了质押'],
        'convert' => ['en' => '{name} converted CYBER.sol', 'ru' => '{name} сконвертировал CYBER.sol', 'zh' => '{name} 转换了 CYBER.sol'],
        'pumpfun_buy' => ['en' => '{name} bought on pump.fun', 'ru' => '{name} купил на pump.fun', 'zh' => '{name} 在 pump.fun 买入'],
        'bridge' => ['en' => '{name} bridged', 'ru' => '{name}: перевод через мост', 'zh' => '{name} 完成了跨链'],
        'nft_mint' => ['en' => '{name} minted an NFT', 'ru' => '{name} выпустил NFT', 'zh' => '{name} 铸造了 NFT'],
        'nft_sale' => ['en' => '{name} bought an NFT', 'ru' => '{name} купил NFT', 'zh' => '{name} 买下了 NFT'],
        'domain' => ['en' => '{name} registered a domain', 'ru' => '{name} зарегистрировал домен', 'zh' => '{name} 注册了域名'],
        'zone' => ['en' => '{name} opened a domain zone', 'ru' => '{name} открыл доменную зону', 'zh' => '{name} 开放了域名区'],
        'predict_market' => ['en' => '{name} opened a prediction market', 'ru' => '{name} открыл рынок прогнозов', 'zh' => '{name} 开设了预测市场'],
        'predict_bet' => ['en' => '{name} placed a prediction', 'ru' => '{name} сделал прогноз', 'zh' => '{name} 下了预测'],
    ];

    private const UNKNOWN = ['en' => '{name}: on-chain action', 'ru' => '{name}: действие в сети', 'zh' => '{name}：链上操作'];

    /**
     * Bridge directions are `{source}_to_{dest}` over these shorthands — the
     * keys of config/bridge.php's routes, and of the bot's own table.
     *
     * @var array<string, array{0: string, 1: string|null}> label, tx-link prefix
     */
    private const BRIDGE_SIDES = [
        'evm' => ['Cyberia', null],
        'sol' => ['Solana', 'https://solscan.io/tx/'],
        'ton' => ['TON', 'https://tonviewer.com/transaction/'],
        'bnb' => ['BNB Chain', 'https://bscscan.com/tx/'],
        'base' => ['Base', 'https://basescan.org/tx/'],
        'robinhood' => ['Robinhood Chain', 'https://robinhoodchain.blockscout.com/tx/'],
        'yenten' => ['Yenten', 'https://explorer.yentencoin.info/tx/'],
        'btc' => ['Bitcoin', 'https://mempool.space/tx/'],
        'ltc' => ['Litecoin', 'https://litecoinspace.org/tx/'],
        'xmr' => ['Monero', 'https://xmrchain.net/tx/'],
    ];

    /** @return array<string, string> */
    public static function title(string $kind): array
    {
        return self::TITLES[$kind] ?? self::UNKNOWN;
    }

    /** "100 CYBER → 12.5 USDC", "1 CYBER + 40 USDC", "500 CYBER", or null. */
    public static function amounts(object $row): ?string
    {
        $in = TradeAmount::format($row->amt_in ?? null, $row->sym_in ?? null);
        $out = TradeAmount::format($row->amt_out ?? null, $row->sym_out ?? null);

        if ($in === null || $out === null) {
            return $in ?? $out;
        }

        return $in.(self::JOIN[$row->kind] ?? ' · ').$out;
    }

    /**
     * What the row's `meta` says in words, where it says anything a reader
     * wants: a bridge's route, a domain's name. Null otherwise.
     */
    public static function detail(object $row): ?string
    {
        $meta = isset($row->meta) ? trim((string) $row->meta) : '';

        if ($meta === '') {
            return null;
        }

        if ($row->kind === 'bridge' && str_contains($meta, '_to_')) {
            [$from, $to] = explode('_to_', $meta, 2);

            return (self::BRIDGE_SIDES[$from][0] ?? $from).' → '.(self::BRIDGE_SIDES[$to][0] ?? $to);
        }

        if (in_array($row->kind, ['domain', 'zone', 'nft_mint', 'nft_sale', 'predict_market', 'predict_bet'], true)) {
            return Str::limit($meta, 120);
        }

        return null;
    }

    /** "$12.50", "$3,400", or null when the bot found no price — never $0. */
    public static function usd(mixed $usd): ?string
    {
        if ($usd === null) {
            return null;
        }

        $value = (float) $usd;

        return '$'.number_format($value, $value >= 100 ? 0 : 2);
    }

    /**
     * The receipt: a link to the explorer of the chain the hash is from. A
     * pump.fun buy is a Solana signature; a bridge's hash is its *source*
     * leg, on whichever chain that was.
     */
    public static function txUrl(object $row): ?string
    {
        $hash = isset($row->tx_hash) ? trim((string) $row->tx_hash) : '';

        if ($hash === '') {
            return null;
        }

        if ($row->kind === 'pumpfun_buy') {
            return 'https://solscan.io/tx/'.$hash;
        }

        if ($row->kind === 'bridge' && is_string($row->meta ?? null) && str_contains($row->meta, '_to_')) {
            $prefix = self::BRIDGE_SIDES[explode('_to_', $row->meta, 2)[0]][1] ?? null;

            if ($prefix !== null) {
                return $prefix.$hash;
            }
        }

        return self::explorer().'/tx/'.$hash;
    }

    /**
     * Who did it, when all that is known is the address: an EVM address is
     * shortened and can open a profile; anything else (a Solana buyer, a
     * bridge sender on another chain) is shortened and opens nothing, because
     * the wallet's profile lookup takes EVM addresses only.
     *
     * @return array{name: string, avatar: null, address: string|null, url: string}|null
     */
    public static function person(?string $address): ?array
    {
        $address = $address === null ? '' : trim($address);

        if ($address === '' || $address === '?') {
            return null;
        }

        $evm = (bool) preg_match('/^0x[0-9a-fA-F]{40}$/', $address);

        return [
            'name' => self::short($address),
            'avatar' => null,
            'address' => $evm ? $address : null,
            'url' => $evm
                ? self::explorer().'/address/'.$address
                : (preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $address) ? 'https://solscan.io/account/'.$address : self::explorer()),
        ];
    }

    public static function short(string $address): string
    {
        return Str::length($address) > 12
            ? Str::substr($address, 0, 6).'…'.Str::substr($address, -4)
            : $address;
    }

    public static function explorer(): string
    {
        return rtrim((string) (config('cyber.chain.explorer') ?: 'https://explorer.cyberia.church'), '/');
    }
}
