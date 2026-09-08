<?php

namespace App\Services\Monero;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Two ways to swap Monero, quoted side by side.
 *
 * The wallet's other swap screens have one venue each and simply use it. This
 * one has two that are not comparable on price alone — one is custodial for
 * the length of a deposit and feeds our own pools, the other never touches
 * this host and costs a spread we do not set — so the screen shows both and
 * the person decides. This service is what makes that comparison possible:
 * it states our own route's terms, asks the partner for theirs, and never
 * decides on the user's behalf which one is "the" route.
 *
 * What it deliberately does NOT do is quote the DEX leg of our own route. That
 * quote lives in the browser, where the pool graph and both AMM versions
 * already are, and where it can be read at the block the user is looking at.
 * A server-side copy would be a second implementation of the one number the
 * user is about to sign against.
 */
class MoneroSwapService
{
    public function enabled(): bool
    {
        return (bool) config('moneroswap.enabled', true);
    }

    /**
     * What this app asks for, in basis points, clamped so an env typo cannot
     * charge somebody a third of their swap.
     */
    public function feeBps(): int
    {
        $asked = (int) config('moneroswap.fee.bps', 0);
        $ceiling = (int) config('moneroswap.fee.max_bps', 300);

        return max(0, min($asked, $ceiling));
    }

    /**
     * Our own route: bridge the XMR in, then trade the wrapper on our pools.
     *
     * `available` is the load-bearing field. The corridor is real code with a
     * real wrapper already deployed, but it needs a Monero wallet on the host
     * to see a deposit and sign a payout — until that exists the route is
     * announced with the reason rather than hidden, because "coming soon" and
     * "we don't do that" are different promises.
     */
    public function ownRoute(): array
    {
        $chain = config('bridge.chains.monero', []);
        $inbound = config('bridge.routes.xmr_to_evm', []);
        $outbound = config('bridge.routes.evm_to_xmr', []);
        $wrapper = config('bridge.assets.XMR.chains.cyberia', []);

        $chainOn = (bool) ($chain['enabled'] ?? false);
        $depositSet = filled($chain['deposit_address'] ?? null);
        $inboundOn = (bool) ($inbound['enabled'] ?? false) && ! ($inbound['coming_soon'] ?? true);
        $outboundOn = (bool) ($outbound['enabled'] ?? false) && ! ($outbound['coming_soon'] ?? true);

        return [
            'key' => 'cyberia',
            'label' => 'Cyberia bridge',
            'available' => $chainOn && $depositSet && ($inboundOn || $outboundOn),
            'directions' => [
                'xmr_to_cyberia' => $chainOn && $depositSet && $inboundOn,
                'cyberia_to_xmr' => $chainOn && $outboundOn,
            ],
            // Said in the order an operator would fix them.
            'reason' => match (true) {
                ! $chainOn => 'monero_chain_disabled',
                ! $depositSet => 'no_deposit_address',
                ! ($inboundOn || $outboundOn) => 'corridor_coming_soon',
                default => null,
            },
            'wrapper' => [
                'address' => $wrapper['address'] ?? null,
                'decimals' => (int) ($wrapper['decimals'] ?? 12),
                'chain_id' => 49406,
            ],
            'minimum_xmr' => (string) config('moneroswap.ours.minimum_xmr', '0.05'),
            'confirmations' => (int) ($chain['minimum_confirmations'] ?? 10),
            'minutes' => (int) config('moneroswap.ours.minutes', 25),
            'fee_bps' => $this->feeBps(),
            'bridge_fee' => [
                'flat_usd' => (string) config('bridge.fee.flat_usd', '0'),
                'rate_bps' => (int) config('bridge.fee.rate_bps', 0),
            ],
            // Custody is the difference between the two routes, so it is a
            // field rather than a footnote somebody may forget to render.
            'custodial' => true,
        ];
    }

    public function partnerConfigured(): bool
    {
        return (bool) config('moneroswap.partner.enabled', false)
            && filled(config('moneroswap.partner.api_key'));
    }

    /**
     * The partner's own terms, without a quote.
     *
     * Kept apart from `partnerQuote()` so a screen can be drawn — name, custody
     * model, whether it is switched on at all — before anybody types an amount.
     */
    public function partnerRoute(): array
    {
        return [
            'key' => 'partner',
            'label' => (string) config('moneroswap.partner.name', 'Partner exchanger'),
            'available' => $this->partnerConfigured(),
            'reason' => $this->partnerConfigured() ? null : 'partner_not_configured',
            'fee_bps' => $this->feeBps(),
            // The exchanger holds the coins for the length of the swap; this
            // host never does. Different risk, not a smaller one.
            'custodial' => true,
            'custodian' => (string) config('moneroswap.partner.name', ''),
        ];
    }

    /**
     * Ask the partner what it pays for this trade, with our share attached.
     *
     * The affiliate share is composed here from config and never read back
     * from the request: a fee that a caller can name is a fee a caller can
     * zero. What comes back is reported as it came back — `fee_applied` false
     * when the exchanger did not honour it — because a fee nobody collects
     * must not be shown as though somebody did.
     *
     * @return array{ok: bool, ...}
     */
    public function partnerQuote(string $from, string $to, string $amount, string $direction = 'from'): array
    {
        if (! $this->enabled()) {
            return ['ok' => false, 'reason' => 'disabled'];
        }

        if (! $this->partnerConfigured()) {
            return ['ok' => false, 'reason' => 'partner_not_configured'];
        }

        $query = [
            'ticker_from' => strtolower($from),
            'ticker_to' => strtolower($to),
            'network_from' => $this->networkFor($from),
            'network_to' => $this->networkFor($to),
            $direction === 'to' ? 'amount_to' : 'amount_from' => $amount,
            'payment' => 'False',
            'min_kycrating' => 'A',
        ];

        $referral = (string) config('moneroswap.partner.referral', '');
        if ($referral !== '') {
            $query['ref'] = $referral;
        }

        $feeBps = $this->feeBps();
        if ($feeBps > 0) {
            // Trocador states the affiliate share as a percentage of the trade.
            $query['markup'] = number_format($feeBps / 100, 2, '.', '');
        }

        try {
            $response = Http::withHeaders([
                'API-Key' => (string) config('moneroswap.partner.api_key'),
            ])
                ->timeout((int) config('moneroswap.partner.timeout', 20))
                ->get(rtrim((string) config('moneroswap.partner.api'), '/').'/api/new_rate', $query);
        } catch (Throwable $e) {
            Log::warning('monero partner quote failed', ['message' => $e->getMessage()]);

            return ['ok' => false, 'reason' => 'unreachable'];
        }

        if (! $response->successful()) {
            return [
                'ok' => false,
                'reason' => 'refused',
                'status' => $response->status(),
                'detail' => $this->reason($response->json(), $response->status()),
            ];
        }

        $body = (array) $response->json();
        $amountTo = $this->decimal($body['amount_to'] ?? null);
        $amountFrom = $this->decimal($body['amount_from'] ?? null);

        if ($amountTo === null || $amountFrom === null) {
            return ['ok' => false, 'reason' => 'unreadable'];
        }

        $applied = $this->decimal($body['markup'] ?? null);

        return [
            'ok' => true,
            'route' => 'partner',
            'provider' => (string) ($body['provider'] ?? config('moneroswap.partner.name')),
            'amount_from' => $amountFrom,
            'amount_to' => $amountTo,
            'rate' => $this->decimal($body['rate'] ?? null),
            'minimum' => $this->decimal($body['min_amount'] ?? null),
            'maximum' => $this->decimal($body['max_amount'] ?? null),
            'eta_minutes' => (int) ($body['eta'] ?? 0) ?: null,
            'fee_bps' => $feeBps,
            // What the exchanger actually agreed to, not what we asked for.
            'fee_applied' => $applied !== null && (float) $applied > 0,
            'fee_percent' => $applied,
            'quote_id' => isset($body['trade_id']) ? (string) $body['trade_id'] : null,
            'custodial' => true,
        ];
    }

    /**
     * Which network an exchanger means by a ticker.
     *
     * XMR has one and everything else here lives on Cyberia, which no partner
     * has heard of — so a Cyberia-side asset is quoted against the asset it is
     * a wrapper *of*, and the last leg happens on our own pools. Saying that
     * out loud is the point: a partner quote for "CYBER" would be a quote for
     * somebody else's token with the same name.
     */
    private function networkFor(string $ticker): string
    {
        return match (strtolower($ticker)) {
            'xmr' => 'Mainnet',
            'btc' => 'Mainnet',
            'ltc' => 'Mainnet',
            'sol' => 'Mainnet',
            'eth' => 'ERC20',
            'usdt', 'usdc' => 'ERC20',
            default => 'Mainnet',
        };
    }

    private function decimal(mixed $value): ?string
    {
        if (is_int($value) || is_float($value)) {
            return rtrim(rtrim(number_format((float) $value, 12, '.', ''), '0'), '.');
        }

        if (is_string($value) && is_numeric($value)) {
            return $value;
        }

        return null;
    }

    private function reason(mixed $body, int $status): string
    {
        if (is_array($body)) {
            foreach (['error', 'message', 'detail'] as $key) {
                if (is_string($body[$key] ?? null) && $body[$key] !== '') {
                    return $body[$key];
                }
            }
        }

        return "The exchanger answered {$status}.";
    }
}
