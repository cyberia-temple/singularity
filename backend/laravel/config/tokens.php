<?php

/*
|--------------------------------------------------------------------------
| Cyberia token directory
|--------------------------------------------------------------------------
|
| Human-readable metadata for the ERC-20 tokens that live on the Cyberia
| chain, powering the public token pages (/tokens and /token/{address|symbol})
| that the analytics page links to. Addresses mirror the Cyberia DEX token list
| (frontend/ritual/public/ritual-tokens.json) and the Hardhat token registry
| (crypto/hardhat/deployments/cyberia-tokens.json); the descriptions are the
| "what is it / why is it here" copy those on-chain sources don't carry.
|
| Keys are the lowercased token address. Each entry:
|   symbol   - ticker as shown on the DEX
|   name     - full ERC-20 name
|   decimals - token decimals
|   logo     - path under `logo_base` (vendored in public/token-icons/)
|   category - one of `categories` below; drives grouping on /tokens
|   tagline  - one line, shown under the title
|   what     - what the token is
|   why      - why it exists on Cyberia / what it's for
|   links    - optional extra call-to-action links ([label, url]); the trade and
|              explorer links are added automatically for every token.
|   service  - service tokens only: name, url, label, utility (list), notice
|
*/

return [

    // Token icons ship with the site and do not depend on the retired DEX UI.
    'logo_base' => env('CYBERIA_TOKEN_LOGO_BASE', '/token-icons'),

    // ServiceHub (crypto/hardhat/contracts/ServiceHub.sol) once deployed: the
    // contract that ties each service token to its service. Unset = the
    // landings say it is not live yet.
    'service_hub' => env('CYBERIA_SERVICE_HUB_ADDRESS'),

    // Ordered category labels. The token pages render groups in this order.
    'categories' => [
        'native' => 'Native & DEX',
        'partner' => 'Partner tokens',
        'launchpad' => 'Cyberia launchpad',
        'service' => 'Cyberia services',
        'stablecoin' => 'Stablecoins',
        'crypto' => 'Bridged crypto',
        'commodity' => 'Commodities',
        'community' => 'Community',
    ],

    'list' => [

        // ---- Native & DEX -------------------------------------------------

        '0x78272aad03e4b9d7a9134e874ba6d419b534f6c9' => [
            'symbol' => 'WCYBER',
            'name' => 'Wrapped CYBER',
            'decimals' => 18,
            'logo' => '/CYBER.png',
            'category' => 'native',
            'tagline' => 'The tradable form of Cyberia\'s native gas coin.',
            'what' => 'WCYBER is the ERC-20 wrapper around CYBER, the coin used to pay gas on the Cyberia chain — the same relationship WETH has to ETH. Each WCYBER is redeemable 1:1 for native CYBER at any time.',
            'why' => 'AMMs and most contracts can\'t hold the raw native coin, so CYBER is wrapped into WCYBER to be traded, pooled and farmed on the Cyberia DEX. It is the base asset most liquidity pairs are quoted against.',
            'links' => [
                ['label' => 'Wrap / unwrap', 'url' => '/wallet?wrap=wrap'],
            ],
        ],

        '0x7dcda19cf984ca708e5fa228ac148e7d82d508ba' => [
            'symbol' => 'CYBER.sol',
            'name' => 'CYBER.sol',
            'decimals' => 18,
            'logo' => '/CYBER.png',
            'category' => 'native',
            'tagline' => 'The Solana-issued CYBER, bridged onto Cyberia.',
            'what' => 'CYBER.sol is the EVM representation of the CYBER token that lives on Solana (SPL mint E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump). Supply on Cyberia is minted and burned by the bridge relayer, staying backed 1:1 by the Solana-side reserve.',
            'why' => 'It lets holders of Solana CYBER move it onto the Cyberia chain to trade and provide liquidity — and back again — tying the Solana market to the native Cyberia economy.',
            'links' => [
                ['label' => 'Convert CYBER ⇄ CYBER.sol', 'url' => '/convert'],
            ],
        ],

        '0x992fca0a89dd95afb17751f6cc233adb9b089df5' => [
            'symbol' => 'ASH',
            'name' => 'Ash',
            'decimals' => 18,
            'logo' => '/ash.png',
            'category' => 'native',
            'tagline' => 'The reward token of the Cyberia DEX.',
            'what' => 'Ash is the emission token of Cyberia, Cyberia\'s DEX. Only a 1-ASH premint exists at genesis; all further supply is minted by the farm (MasterChef) contract and handed to liquidity providers.',
            'why' => '"Every swap burns an offering — out of the fire rises Ash." Ash rewards the people who supply liquidity and keep the markets deep. Stake your LP tokens in the farms to earn it.',
            'links' => [
                ['label' => 'Farm ASH', 'url' => '/farm'],
            ],
        ],

        // ---- Stablecoins --------------------------------------------------

        '0xdc25597b19799010047f17e9591efe08efd40077' => [
            'symbol' => 'USDC',
            'name' => 'USD Coin',
            'decimals' => 6,
            'logo' => '/usdc.svg',
            'category' => 'stablecoin',
            'tagline' => 'US-dollar stablecoin and the DEX\'s pricing anchor.',
            'what' => 'USDC on Cyberia is a bridged, mint/burn representation of USD Coin, targeting a value of $1 with 6 decimals to match the original.',
            'why' => 'Together with USDT it is one of the two $1 anchors the analytics price walker starts from — every other token\'s USD price is derived by tracing pool exchange rates back to USDC/USDT. It is the main unit of account for trading on Cyberia.',
        ],

        '0x94845af24a3e431593a2b941b2b31836de45185d' => [
            'symbol' => 'USDT',
            'name' => 'Tether USD',
            'decimals' => 6,
            'logo' => '/usdt.svg',
            'category' => 'stablecoin',
            'tagline' => 'Tether USD stablecoin — the second dollar anchor.',
            'what' => 'USDT is a bridged, mint/burn representation of Tether USD, pegged to $1 with 6 decimals.',
            'why' => 'The other USD anchor alongside USDC. It provides a familiar dollar-pegged asset for pricing, quoting and settling trades on the chain.',
        ],

        '0x3ce7d8e486e16bad2fb1487fe1da4dc33237d923' => [
            'symbol' => 'RUB',
            'name' => 'Russian Ruble',
            'decimals' => 2,
            'logo' => '/rub.png',
            'category' => 'stablecoin',
            'tagline' => 'Russian ruble stablecoin.',
            'what' => 'RUB is a bridged, mint/burn ERC-20 tracking the Russian ruble, with 2-decimal (kopeck) precision.',
            'why' => 'It gives the Cyberia community a ruble-denominated unit for trading and pricing, and anchors the rouble-market tokens (the T‑Capital funds) to a familiar fiat value.',
        ],

        // ---- Bridged crypto ----------------------------------------------

        '0x8852335b8a54e1616abb77ac5b392a8b566568a0' => [
            'symbol' => 'AVAX.FUJI',
            'name' => 'Avalanche Fuji Test AVAX',
            'decimals' => 18,
            'logo' => '/avax-fuji.svg',
            'category' => 'crypto',
            'tagline' => 'Test AVAX from Avalanche Fuji, bridged to Cyberia.',
            'what' => 'AVAX.FUJI represents test AVAX deposited on Avalanche Fuji C-Chain (43113). It is a testnet asset, separate from mainnet AVAX, and has no mainnet AVAX redemption.',
            'why' => 'It lets you test transfers between Avalanche Fuji, the existing Cyberia chain (49406), and the new Cyberia Fuji network (49407). The bridge mints against confirmed deposits and burns deposited wrappers after the destination payout.',
            'links' => [
                ['label' => 'Bridge test AVAX', 'url' => '/bridge'],
            ],
        ],

        '0x9332081f308bc978fe259237850fa253131b46fa' => [
            'symbol' => 'BTC',
            'name' => 'Bitcoin',
            'decimals' => 8,
            'logo' => '/btc.svg',
            'category' => 'crypto',
            'tagline' => 'Bitcoin, represented on Cyberia.',
            'what' => 'BTC is a bridged, mint/burn representation of Bitcoin with 8 decimals (satoshi precision). Supply is driven by the bridge and backed 1:1 by BTC held in reserve.',
            'why' => 'It lets you hold and trade Bitcoin price exposure natively on Cyberia — pool it, farm it or swap in and out — without leaving the chain.',
        ],

        '0x001afd19c9d890b0cf0fcd6d654f9bfe4f264f14' => [
            'symbol' => 'LTC',
            'name' => 'Litecoin',
            'decimals' => 8,
            'logo' => '/ltc.svg',
            'category' => 'crypto',
            'tagline' => 'Litecoin on Cyberia.',
            'what' => 'LTC is a bridged Litecoin representation, 8 decimals, mint/burned by the bridge and backed 1:1 by reserve LTC.',
            'why' => 'It brings Litecoin liquidity onto Cyberia for trading and yield.',
        ],

        '0x53450b1d205f1e41d10b653fbbdea74160dafff4' => [
            'symbol' => 'SOL',
            'name' => 'Solana',
            'decimals' => 9,
            'logo' => '/sol.svg',
            'category' => 'crypto',
            'tagline' => 'Solana, bridged to Cyberia.',
            'what' => 'SOL is a bridged representation of Solana\'s SOL, using 9 decimals to match the native lamport precision.',
            'why' => 'Cyberia\'s bridge is Solana-connected, so SOL is a first-class bridged asset: move it over to trade, provide liquidity, or pair it with CYBER.sol.',
        ],

        '0xfda2f6eeb11f1acc7ccab559133e8f07d9f81986' => [
            'symbol' => 'ETH',
            'name' => 'Ethereum',
            'decimals' => 18,
            'logo' => '/eth.svg',
            'category' => 'crypto',
            'tagline' => 'Ether, bridged onto Cyberia.',
            'what' => 'ETH is a bridged representation of Ethereum\'s ether, 18 decimals (wei), backed 1:1 by ETH in reserve and driven by the bridge relayer.',
            'why' => 'It lets you trade ETH exposure and pair the leading smart-contract asset against CYBER and the stablecoins on Cyberia.',
        ],

        '0xe2e8d51c18d6e0fddbb9ff4bf63235d688dd00ae' => [
            'symbol' => 'XMR',
            'name' => 'Monero',
            'decimals' => 12,
            'logo' => '/monero.svg',
            'category' => 'crypto',
            'tagline' => 'Monero on Cyberia.',
            'what' => 'XMR is a bridged Monero representation with 12 decimals, mint/burned by the bridge.',
            'why' => 'It adds privacy-coin exposure to the Cyberia markets.',
        ],

        '0x60617237bc60f73c0393c7a6d7352e16df20472a' => [
            'symbol' => 'TRX',
            'name' => 'Tron',
            'decimals' => 6,
            'logo' => '/tron.svg',
            'category' => 'crypto',
            'tagline' => 'Tron, represented on Cyberia.',
            'what' => 'TRX is a bridged Tron representation, 6 decimals, mint/burned by the bridge.',
            'why' => 'It brings TRX liquidity and price exposure onto the chain.',
        ],

        // ---- Commodities --------------------------------------------------

        '0x38297140d60b48f746ad83d851b852fd23ef9871' => [
            'symbol' => 'GOLD',
            'name' => 'Gold',
            'decimals' => 18,
            'logo' => '/gold.png',
            'category' => 'commodity',
            'tagline' => 'One token, one troy ounce of gold.',
            'what' => 'GOLD is a bridged, gold-backed ERC-20 where one whole token represents one troy ounce of allocated gold held by the custodian. 18 decimals.',
            'why' => 'It puts a hard-asset, inflation-hedge instrument on-chain so Cyberia users can hold and trade gold exposure alongside crypto and fiat.',
        ],

        '0xad9dfef9d671afcf29dbdd7df360e7ca8d5ac40b' => [
            'symbol' => 'SILVER',
            'name' => 'Silver',
            'decimals' => 18,
            'logo' => '/silver.png',
            'category' => 'commodity',
            'tagline' => 'Silver-backed token.',
            'what' => 'SILVER is a bridged, silver-backed ERC-20 (18 decimals) tracking the price of silver, mint/burned by the bridge.',
            'why' => 'A second precious-metal instrument for diversification and pricing on Cyberia. Some SILVER pools can be thin — check depth before large trades.',
        ],

        // ---- Partner tokens -----------------------------------------------

        '0x621021f18b6404123f98b1395c418868418acf36' => [
            'symbol' => 'HATCHER',
            'name' => 'Hatcher',
            'decimals' => 9,
            'logo' => '/hatcher.jpg',
            'category' => 'partner',
            'tagline' => 'Partner project — bridged to Cyberia from Solana.',
            'what' => 'Hatcher is a managed AI Agents hosting platform. It has features like easy agent deployment just by chatting, out-of-box preconfigured agents, mobile apps available, a full 3D city and rooms for agents, e-mails and many more.',
            'why' => 'As a partner token it trades on the Cyberia DEX and is a listed lending market, bringing its community and Solana liquidity onto the Cyberia chain.',
            'links' => [
                ['label' => 'Website', 'url' => 'https://hatcher.host/'],
                ['label' => 'pump.fun', 'url' => 'https://pump.fun/coin/Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump'],
            ],
        ],

        '0x4945419cceef0dc70b054700de2750a056b03ee3' => [
            'symbol' => 'KRSQ',
            'name' => 'KARASIQUE',
            'decimals' => 18,
            'logo' => '/karasique.webp',
            'category' => 'partner',
            'tagline' => 'Partner project — the KARASIQUE token.',
            'what' => 'KRSQ (KARASIQUE) is a partner project\'s token on Cyberia, an owner-minted ERC-20 with 18 decimals.',
            'why' => 'A partner in the Cyberia ecosystem: trade KRSQ on Cyberia, supply or borrow it in the lending market, and take part in its community.',
            'links' => [
                ['label' => 'Website', 'url' => 'https://akvarium228.ru/'],
                ['label' => 'Telegram', 'url' => 'https://t.me/akvarium228'],
            ],
        ],

        '0x3a5820be90c3fb9c5f3fb47a4859544193b0f8c6' => [
            'symbol' => 'YTN',
            'name' => 'Yenten',
            'decimals' => 18,
            'logo' => '/yenten.png',
            'category' => 'partner',
            'tagline' => 'Partner project — Yenten, a CPU-mined PoW coin.',
            'what' => 'YTN is the Cyberia token for Yenten, a CPU-mineable proof-of-work cryptocurrency listed as a partner project. 18 decimals, owner-minted.',
            'why' => 'As a partner token, Yenten gets an on-chain market and liquidity on Cyberia — tradable on Cyberia and available in the lending market.',
            'links' => [
                ['label' => 'Website', 'url' => 'https://yentencoin.info/'],
            ],
        ],

        '0xf10d68fd358d5f5eb5fbf23376183d17a0684e43' => [
            'symbol' => 'CYBERGUARD',
            'name' => 'Cyberguard',
            'decimals' => 6,
            'logo' => '/cyberguard.jpg',
            'category' => 'partner',
            'tagline' => 'Partner project — CyberGuard, bridged to Cyberia from Solana.',
            'what' => 'CyberGuard is a cybersecurity project whose token lives on Solana (mint VANMkCYNDJ5DLpw1s6Jz89Lg7TZxy8SFhuCaFKQpump, traded on PumpSwap). On Cyberia it is a bridged mint/burn representation with 6 decimals, backed 1:1 by tokens held on the Solana side of the bridge.',
            'why' => 'CyberGuard is a Cyberia partner since November 2026 and is reviewing the security of the Cyberia wallet. Bridge it in, trade it on the Cyberia DEX and pool it with CYBER. Partner status is not an audit of the token itself — check the contract and the liquidity before you trade.',
            'links' => [
                ['label' => 'Website', 'url' => 'https://cyberguardai.org/'],
                ['label' => 'X', 'url' => 'https://x.com/CyberGuardAISec'],
                ['label' => 'Telegram', 'url' => 'https://t.me/cyberguardai'],
                ['label' => 'DexScreener', 'url' => 'https://dexscreener.com/solana/6RxgxA8x8Nkbpejp3quX4tBwbKuUPrL7XnEGE6zLV1Cm'],
                ['label' => 'Bridge', 'url' => '/bridge'],
            ],
        ],

        // ---- Cyberia launchpad --------------------------------------------

        '0x05cd1afd5b2df3cca6ceab80cbc21168ec981e8b' => [
            'symbol' => 'LAIN',
            'name' => 'Lain',
            'decimals' => 18,
            'logo' => '/lain.jpg',
            'category' => 'launchpad',
            'tagline' => 'Launched on the Cyberia launchpad.',
            'what' => 'LAIN is a community token minted through the Cyberia launchpad, themed on the Serial-Experiments-Lain motif that runs through the whole ecosystem. ERC-20, 18 decimals.',
            'why' => 'One of the tokens created on Cyberia\'s own launchpad. It leans into the Lain aesthetic — present everywhere, connected to everything. Trade it on Cyberia.',
            'links' => [
                ['label' => 'Cyberia launchpad', 'url' => '/launchpad'],
            ],
        ],

        '0xd8c1f812add03ccde8d3c7f86fead181980cd7ec' => [
            'symbol' => 'MINE',
            'name' => 'Minecraft',
            'decimals' => 18,
            'logo' => '/mine.jpg',
            'category' => 'launchpad',
            'tagline' => 'Launched on the Cyberia launchpad — Minecraft-themed.',
            'what' => 'MINE is a community token minted through the Cyberia launchpad, themed after Minecraft. ERC-20, 18 decimals.',
            'why' => 'A launchpad-born token for the gaming corner of Cyberia; trade and pool it on Cyberia.',
            'links' => [
                ['label' => 'Cyberia launchpad', 'url' => '/launchpad'],
            ],
        ],

        // ---- Cyberia services ---------------------------------------------
        // One token per service, launched on LaunchpadV3 on 2026-10-25 (DAO 29-42).
        // `service` drives the landing block on /token/{symbol}; the DAO link is
        // resolved by address, the hub link from `service_hub` above.

        '0x8bb022060e4946b9498d11f3e87666dc7129ccbc' => [
            'symbol' => 'NFT',
            'name' => 'Cyberia NFT market',
            'decimals' => 18,
            'logo' => '/services/NFT.svg',
            'category' => 'service',
            'tagline' => 'The token of NFT market on Cyberia. Buy, sell and mint NFTs on Cyberia.',
            'what' => 'NFT is the service token of the NFT market where any CyberiaNFT or ERC-721 on the chain is listed and sold for CYBER or tokens. 1,000,000 NFT were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding NFT is a say in how nft market is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'NFT market',
                'url' => '/market',
                'label' => 'Cyberia NFT market',
                'utility' => [
                    'Vote in the NFT DAO on listings and the market fee',
                    'Stake NFT in the service hub for a share of what the hub actually receives for this service',
                    'Staked holders get the market\'s holder discount once it is wired to the hub',
                ],
            ],
        ],

        '0xba6bdda1988e72e796032c1cebfc4192ac5a8497' => [
            'symbol' => 'LEND',
            'name' => 'Cyberia Lending',
            'decimals' => 18,
            'logo' => '/services/LEND.svg',
            'category' => 'service',
            'tagline' => 'The token of Lending on Cyberia. Borrow and lend against collateral on Cyberia.',
            'what' => 'LEND is the service token of the lending market: supply assets to earn interest, borrow against collateral, liquidate unhealthy positions. 1,000,000 LEND were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding LEND is a say in how lending is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Lending',
                'url' => '/lending',
                'label' => 'Cyberia lending',
                'utility' => [
                    'Vote in the LEND DAO on market parameters (LTV, rates, listed assets)',
                    'Stake LEND in the service hub for a share of what the hub receives for lending',
                ],
            ],
        ],

        '0x0a2d855d70728fea342c338f3668b91ecc330cb5' => [
            'symbol' => 'PRED',
            'name' => 'Cyberia Prediction markets',
            'decimals' => 18,
            'logo' => '/services/PRED.svg',
            'category' => 'service',
            'tagline' => 'The token of Prediction markets on Cyberia. Parimutuel YES/NO markets in native CYBER.',
            'what' => 'PRED is the service token of parimutuel YES/NO prediction markets settled in native CYBER, most of them answered by a price feed. 1,000,000 PRED were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding PRED is a say in how prediction markets is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Prediction markets',
                'url' => '/predictions',
                'label' => 'Cyberia predictions',
                'utility' => [
                    'Vote in the PRED DAO on new markets and disputed free-form outcomes',
                    'Stake PRED in the service hub for a share of what the hub receives for predictions',
                ],
            ],
        ],

        '0x9ba523b368fd338d45594616b4515f6d421b21d2' => [
            'symbol' => 'FARM',
            'name' => 'Cyberia Farming',
            'decimals' => 18,
            'logo' => '/services/FARM.svg',
            'category' => 'service',
            'tagline' => 'The token of Farming on Cyberia. Stake LP tokens, earn ASH.',
            'what' => 'FARM is the service token of liquidity farms: stake a pool\'s LP token and earn ASH. 1,000,000 FARM were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding FARM is a say in how farming is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Farming',
                'url' => '/farm',
                'label' => 'Cyberia farms',
                'utility' => [
                    'Vote in the FARM DAO on which pools are farmed and their ASH weights',
                    'Stake FARM in the service hub for a share of what the hub receives for farming',
                ],
            ],
        ],

        '0x0f5cee1f315a84e109b5817839b5474e0ca7431d' => [
            'symbol' => 'STAKE',
            'name' => 'Cyberia Staking',
            'decimals' => 18,
            'logo' => '/services/STAKE.svg',
            'category' => 'service',
            'tagline' => 'The token of Staking on Cyberia. Single-asset staking on Cyberia.',
            'what' => 'STAKE is the service token of single-asset staking pools. 1,000,000 STAKE were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding STAKE is a say in how staking is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Staking',
                'url' => '/staking',
                'label' => 'Cyberia staking',
                'utility' => [
                    'Vote in the STAKE DAO on staking rewards',
                    'Stake STAKE in the service hub for a share of what the hub receives for staking',
                ],
            ],
        ],

        '0xe17f466e3501d80650f955c66a8ad4336bfd17c8' => [
            'symbol' => 'LAUNCH',
            'name' => 'Cyberia Launchpad',
            'decimals' => 18,
            'logo' => '/services/LAUNCH.svg',
            'category' => 'service',
            'tagline' => 'The token of Launchpad on Cyberia. Fair launches with locked liquidity.',
            'what' => 'LAUNCH is the service token of the launchpad: fair launches into locked v3 liquidity, each with its own DAO, from the site, the wallet or LainOS. 1,000,000 LAUNCH were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding LAUNCH is a say in how launchpad is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Launchpad',
                'url' => '/launchpad',
                'label' => 'Cyberia launchpad',
                'utility' => [
                    'Vote in the LAUNCH DAO on launchpad parameters',
                    'Stake LAUNCH in the service hub for a share of what the hub receives for the launchpad',
                ],
            ],
        ],

        '0x82708a8d873ca89f9f341307cca949a4a5a240f3' => [
            'symbol' => 'BRIDGE',
            'name' => 'Cyberia Bridge',
            'decimals' => 18,
            'logo' => '/services/BRIDGE.svg',
            'category' => 'service',
            'tagline' => 'The token of Bridge on Cyberia. Move assets between Cyberia and other chains.',
            'what' => 'BRIDGE is the service token of the bridge between Cyberia, Solana, EVM chains, Bitcoin, Litecoin and Monero. 1,000,000 BRIDGE were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding BRIDGE is a say in how bridge is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Bridge',
                'url' => '/bridge',
                'label' => 'Cyberia bridge',
                'utility' => [
                    'Vote in the BRIDGE DAO on corridors and bridge fees',
                    'Stake BRIDGE in the service hub for a share of what the hub receives for the bridge',
                ],
                'notice' => 'The bridge is under a safety fix (B03). Do not bridge large amounts until it ships; the token itself trades normally.',
            ],
        ],

        '0xbf763e079584a35d19968fd5e2d528087d9bc3fe' => [
            'symbol' => 'WALLET',
            'name' => 'Cyberia Wallet',
            'decimals' => 18,
            'logo' => '/services/WALLET.svg',
            'category' => 'service',
            'tagline' => 'The token of Wallet on Cyberia. One phrase, every chain.',
            'what' => 'WALLET is the service token of the non-custodial multichain wallet: web, desktop, mobile, Telegram and the browser extension. 1,000,000 WALLET were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding WALLET is a say in how wallet is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Wallet',
                'url' => '/wallet',
                'label' => 'Cyberia wallet',
                'utility' => [
                    'Vote in the WALLET DAO on the wallet roadmap',
                    'Stake WALLET in the service hub for a share of what the hub receives for the wallet',
                ],
            ],
        ],

        '0xdb003b50dd2f5e9dcd1d177ca07d85cf3e3c6b48' => [
            'symbol' => 'CLOUD',
            'name' => 'Cyberia Cloud hosting',
            'decimals' => 18,
            'logo' => '/services/CLOUD.svg',
            'category' => 'service',
            'tagline' => 'The token of Cloud hosting on Cyberia. Services that pay for their own containers.',
            'what' => 'CLOUD is the service token of self-paying cloud hosting: a service\'s treasury pays a node operator per second in CYBER for its container (in development). 1,000,000 CLOUD were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding CLOUD is a say in how cloud hosting is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Cloud hosting',
                'url' => null,
                'label' => 'Cyberia cloud',
                'utility' => [
                    'Vote in the CLOUD DAO on vCPU/GB prices and the provider bond',
                    'Stake CLOUD in the service hub for a share of what the hub receives for hosting',
                ],
                'notice' => 'Cloud hosting is in development: the token and its DAO exist, the service does not yet.',
            ],
        ],

        '0xdd390535a353317625bcd8c27582abcc5e151186' => [
            'symbol' => 'INFER',
            'name' => 'Cyberia AI inference API',
            'decimals' => 18,
            'logo' => '/services/INFER.svg',
            'category' => 'service',
            'tagline' => 'The token of AI inference API on Cyberia. OpenAI-compatible inference, paid with a holding or x402.',
            'what' => 'INFER is the service token of the OpenAI-compatible inference API at /api/ai/v1, open to holders or paid per call over x402. 1,000,000 INFER were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding INFER is a say in how ai inference api is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'AI inference API',
                'url' => 'https://github.com/cyberia-temple/singularity/blob/main/backend/laravel/docs/ai-api.md',
                'label' => 'AI API docs',
                'utility' => [
                    'Vote in the INFER DAO on the model catalogue',
                    'Stake INFER in the service hub for a share of what the hub receives for inference',
                ],
            ],
        ],

        '0x28084a351a87f20219ef04e596b6d3b84dd0afd3' => [
            'symbol' => 'IPFS',
            'name' => 'Cyberia IPFS pinning',
            'decimals' => 18,
            'logo' => '/services/IPFS.svg',
            'category' => 'service',
            'tagline' => 'The token of IPFS pinning on Cyberia. Pin files and sites to IPFS.',
            'what' => 'IPFS is the service token of IPFS pinning for files, token sites and NFT metadata. 1,000,000 IPFS were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding IPFS is a say in how ipfs pinning is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'IPFS pinning',
                'url' => '/wallet?section=nft',
                'label' => 'Pin in the wallet',
                'utility' => [
                    'Vote in the IPFS DAO on pinning limits',
                    'Stake IPFS in the service hub for a share of what the hub receives for pinning',
                ],
            ],
        ],

        '0x7d01915b2ef0c5931f2520b7fa2523d1bd6b0cb5' => [
            'symbol' => 'SEED',
            'name' => 'Cyberia Tracker',
            'decimals' => 18,
            'logo' => '/services/SEED.svg',
            'category' => 'service',
            'tagline' => 'The token of Tracker on Cyberia. A BitTorrent tracker where every release is an NFT.',
            'what' => 'SEED is the service token of the BitTorrent tracker where a release exists because somebody minted it. 1,000,000 SEED were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding SEED is a say in how tracker is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Tracker',
                'url' => '/tracker',
                'label' => 'Cyberia tracker',
                'utility' => [
                    'Vote in the SEED DAO on release moderation',
                    'Stake SEED in the service hub for a share of what the hub receives for the tracker',
                ],
            ],
        ],

        '0xde99a012a910419736e4c33228df6972fbcf0e72' => [
            'symbol' => 'SCAN',
            'name' => 'Cyberia Explorer',
            'decimals' => 18,
            'logo' => '/services/SCAN.svg',
            'category' => 'service',
            'tagline' => 'The token of Explorer on Cyberia. The Blockscout explorer for Cyberia.',
            'what' => 'SCAN is the service token of the Blockscout explorer and its public API. 1,000,000 SCAN were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding SCAN is a say in how explorer is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Explorer',
                'url' => 'https://explorer.cyberia.church',
                'label' => 'Cyberia explorer',
                'utility' => [
                    'Vote in the SCAN DAO on explorer hosting',
                    'Stake SCAN in the service hub for a share of what the hub receives for the explorer',
                ],
            ],
        ],

        '0x7911085dc26825349b0ce2518b72d49ff4a26ee8' => [
            'symbol' => 'GAS',
            'name' => 'Cyberia Gas station',
            'decimals' => 18,
            'logo' => '/services/GAS.svg',
            'category' => 'service',
            'tagline' => 'The token of Gas station on Cyberia. A drip of CYBER for an address that has tokens but no gas.',
            'what' => 'GAS is the service token of the gas station that drips CYBER to an address holding tokens but no coin to pay fees with. 1,000,000 GAS were minted at launch, all of it into a CYBER pool whose liquidity is locked forever; nothing else was or can be minted.',
            'why' => 'Holding GAS is a say in how gas station is run and, once the service hub is live, a claim on what this service really earns: the creator share of its pool fees and payments made through the hub. Nothing is promised beyond those flows, and no CYBER is emitted to pay anyone.',
            'service' => [
                'name' => 'Gas station',
                'url' => '/wallet?section=gas',
                'label' => 'Gas station',
                'utility' => [
                    'Vote in the GAS DAO on the drip size and station limits',
                    'Stake GAS in the service hub for a share of what the hub receives for the station',
                ],
            ],
        ],

        // ---- Community ----------------------------------------------------

        '0x3d32fe83ad0c1157fddca0a3280764c495cdad6d' => [
            'symbol' => 'TG',
            'name' => 'Telegram',
            'decimals' => 18,
            'logo' => '/telegram.svg',
            'category' => 'community',
            'tagline' => 'The community chat & governance token.',
            'what' => 'TG is Cyberia\'s Telegram community token: an ERC-20 with on-chain voting (ERC20Votes) minted and handed out by the community Telegram bot for participation and rewards.',
            'why' => 'It rewards active members of the Cyberia Telegram, and its vote-tracking makes it usable for community governance signals. Earn it by taking part in chat.',
        ],

        '0xeb91ec10462a249b9922d6d62fb2be73bd084ade' => [
            'symbol' => 'GOAL',
            'name' => 'Goal Bear Coin',
            'decimals' => 18,
            'logo' => '/goal.webp',
            'category' => 'community',
            'tagline' => 'Goal Bear Coin — a community meme token.',
            'what' => 'GOAL (Goal Bear Coin) is a community/meme ERC-20 on Cyberia, 18 decimals, owner-minted.',
            'why' => 'A lighthearted community token; trade and pool it on Cyberia.',
        ],

    ],

];
