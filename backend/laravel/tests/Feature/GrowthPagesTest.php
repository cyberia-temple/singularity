<?php

use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $this->withoutVite();
});

test('the landing centers Cyberia liquidity and links the whitepaper', function () {
    $this->get('/')->assertOk();

    $landing = file_get_contents(resource_path('views/landing/index.html'));

    expect($landing)
        ->toContain('<a href="/whitepaper">Whitepaper</a>')
        ->toContain('<a href="/cyber">CYBER</a>')
        ->toContain('<a href="https://docs.cyberia.church" target="_blank" rel="noopener noreferrer">Docs</a>')
        ->toContain('The liquidity home of the Cyberia ecosystem')
        ->toContain('Swap and manage liquidity directly on Cyberia')
        ->toContain('Robinhood Chain is natively supported')
        ->toContain('Open Cyberia bridge')
        ->toContain('Explore DEX')
        ->toContain('View staking')
        ->toContain('Read the whitepaper');
});

test('the robinhood chain landing exposes only configured bridge routes', function () {
    $this->get('/robinhood-chain')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Growth/RobinhoodChain')
            ->has('bridgeRoutes')
            ->where('bridgeRoutes', function ($routes): bool {
                $robinhoodRoutes = collect($routes);

                return $robinhoodRoutes->isNotEmpty()
                    && $robinhoodRoutes->every(
                        fn (array $route): bool => in_array(
                            'robinhood',
                            [$route['source'], $route['destination']],
                            true,
                        ),
                    )
                    && $robinhoodRoutes->contains(
                        fn (array $route): bool => $route['direction'] === 'robinhood_to_evm'
                            && $route['operational'] === true
                            && $route['tokens'] === ['USDG', 'ETH', 'SPY', 'CYBER'],
                    )
                    && $robinhoodRoutes->contains(
                        fn (array $route): bool => $route['direction'] === 'evm_to_robinhood'
                            && $route['operational'] === false
                            && $route['unavailableReason'] === 'Coming soon',
                    );
            })
            ->where('seo.title', 'Robinhood Chain Bridge, DEX and Staking | Cyberia')
            ->where('seo.canonical', 'https://cyberia.church/robinhood-chain')
            ->has('faq', 4));
});

test('partner campaigns render from the shared campaign page', function (string $partner) {
    $this->get("/partners/{$partner}")
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Growth/Partner')
            ->where('partnerSlug', $partner));
})->with(['ash', 'hatcher']);

test('pioneer season renders the season and its checkpoints to guests', function () {
    $this->get('/pioneer-season')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Growth/PioneerSeason')
            ->has('checkpoints', 5)
            ->where('me', null));
});

test('the landing sends a visitor who holds a wallet straight into it', function () {
    $landing = file_get_contents(resource_path('views/landing/index.html'));
    $head = substr($landing, 0, (int) strpos($landing, '<script async'));

    expect($head)
        ->toContain("localStorage.getItem('cyberia.wallet.vault.v1')")
        ->toContain("location.replace('/wallet'")
        ->toContain('[?&]site');

    expect(file_get_contents(resource_path('js/lib/wallet/vault.ts')))
        ->toContain("'cyberia.wallet.vault.v1'");

    foreach (['js/pages/Wallet.vue', 'js/components/wallet/WalletPreferences.vue'] as $file) {
        expect(file_get_contents(resource_path($file)))
            ->toContain('href="/?site"')
            ->not->toContain('href="/"');
    }
});
