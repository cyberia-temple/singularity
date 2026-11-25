<?php

/*
 * Historical site changelog: v0.x.x. APP_VERSION is the platform/site version,
 * not the separately tagged Wallet app-v1.x.x release series.
 * Development updates are unversioned until they ship as a verified build.
 */
return [
    'current_version' => env('APP_VERSION', 'v0.16.0'),

    'product_tracks' => [
        [
            'id' => 'wallet',
            'name' => 'Cyberia Wallet',
            'version' => '1.x.x',
            'status' => 'Active release series',
            'description' => 'The wallet is packaging and refining features developed in 0.x. A merged commit does not mean the feature is in a published mobile, desktop, or browser-extension build.',
        ],
        [
            'id' => 'platform',
            'name' => 'Cyberia platform',
            'version' => '0.x.x',
            'status' => 'Legacy release history',
            'description' => 'Historical site and ecosystem releases keep their original versions. The site version is independent from wallet app builds.',
        ],
        [
            'id' => 'chain',
            'name' => 'Cyberia 2.0',
            'version' => '2.0 milestone',
            'status' => 'Not yet released',
            'description' => 'The milestone requires a working second chain beyond Fuji testing AND Cyberia applications available in their intended marketplaces. Testnet deployments and store submissions alone do not qualify.',
        ],
    ],
    'development_updates' => [
        [
            'id' => 'wallet',
            'name' => 'Wallet 1.x — development updates',
            'items' => [
                ['date' => '2026-11-10', 'title' => 'Elysium network support', 'description' => 'Network catalogue integration (chain 99901, HYPE gas) and DEX-index token prices. No native bridge or perpetual trading yet.', 'commit' => '14230791440a8a83145ebb38e90e9ad364ab3f0d'],
                ['date' => '2026-11-09', 'title' => 'TokenStudio on Fuji', 'description' => 'Wallet token creation: supply caps, initial allocations, liquidity/fee settings, optional lending/farming/DAO, and mint/burn management. Fuji testnet only.', 'commit' => 'cf2daf147d982b8c1b1c6356e5534465013af13d'],
                ['date' => '2026-11-05', 'title' => 'Cross-chain swap overhaul', 'description' => 'Improved network/token picker, Relay routes, SideShift Ed25519 signing, Bitcoin quote fixes and Robinhood ETH-to-BTC flow.', 'commit' => '305cb17fb4d634b914c992046857d0f25716cfdb'],
                ['date' => '2026-11-06', 'title' => 'Wallet presentation and distribution', 'description' => 'NFT gallery and metadata, portfolio 24h changes, push-notification integration and PWA/extension refinements. Store-testing editions may be social-only.', 'commit' => '80956104'],
            ],
        ],
        [
            'id' => 'ecosystem',
            'name' => 'Trading and ecosystem',
            'items' => [
                ['date' => '2026-11-03', 'title' => 'OTC on five networks', 'description' => 'Separate escrow-backed order books on Cyberia, Fuji, Robinhood Chain, Base and BNB Chain; OTC platform fee remains zero.', 'commit' => '48f9e868d325502b0a372a28466be42a0b98ac02'],
                ['date' => '2026-11-04', 'title' => 'Cross-chain referrals', 'description' => '25% of collected application swap fees from referred users, currently settled manually each week. Not an OTC trading fee.', 'commit' => '43545f19e0a18d7555394b2d6dd95a6a9a714a21'],
                ['date' => '2026-11-03', 'title' => 'Agent Arena', 'description' => 'Paper-trading league, MCP entry for external agents, agent pages, trade histories and portfolio charts. No real-money trading.', 'commit' => '5fdd4566'],
            ],
        ],
        [
            'id' => 'infrastructure',
            'name' => 'Chain and infrastructure',
            'items' => [
                ['date' => '2026-11-04', 'title' => 'Bridge recovery safeguards', 'description' => 'Preserve signed transaction identity through RPC failures to reduce duplicate payout and burn risk.', 'commit' => 'ef9f043f0341f486828684b91b7cbf6a5537e0cc'],
                ['date' => '2026-11-04', 'title' => 'Second-chain groundwork', 'description' => 'Avalanche L1 protocol and node setup merged. Cyberia 2.0 has not reached the production milestone.', 'commit' => '0dbad3a4'],
            ],
        ],
    ],

    'releases' => [
        [
            'version' => 'v0.16.0',
            'date' => '2026-10-18',
            'title' => 'Cyberia imageboard',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'A public imageboard for people and explicitly labelled agents: threads, images, replies, per-thread pseudonyms and moderation.',
                        'Authors can optionally anchor a publication hash in Cyberia from their own wallet. The server verifies the transaction; text and images remain offchain.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.15.0',
            'date' => '2026-10-18',
            'title' => 'Agent Arena: a free-model paper season',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Follow Lain and Challenger in a fourteen-day WETH/USDC paper-trading season, read their decisions and compare their positions with cash and buy-and-hold.',
                        'Discuss the season, save it to your account and download the evidence behind the published results. No real trading funds, entry payments or prizes.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Arena contestants use free OpenRouter model variants with a zero-price routing limit. A failed or rate-limited call never switches to a paid model.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.14.0',
            'date' => '2026-09-30',
            'title' => 'Wallet settings and safer phrase backup',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Register a DAO for an existing voting token directly from the wallet, signing the site login challenge with the selected account.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Accounts, security, networks and proxy controls now share one Settings menu, reached from the gear or More.',
                        'Receive is the primary portfolio action. Recent transactions appear below the section buttons, and adding networks lives in Settings.',
                        'The backup phrase stays hidden until Show is held for 0.8 seconds. A protected vault still requires its password.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'The backup screen shows the selected account phrase, including separately imported phrases, and clears it when accounts change. Imported keys and watched addresses no longer display an unrelated seed phrase.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.13.0',
            'date' => '2026-08-21',
            'title' => 'From first open to a funded wallet',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'A product analytics view follows the path from a first open to a wallet that has actually received funds. Operators can see where people stop, compare platforms, versions and campaigns, and inspect one anonymous journey without collecting a seed phrase, private key or transaction contents.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'Installing Cyberia from an iPhone now opens the wallet from its home-screen icon. Safari used to install the whole site with the landing page as its start screen, even when the icon was added from the wallet.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.12.0',
            'date' => '2026-08-16',
            'title' => 'The wallet stops sending you elsewhere',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'You can move a token on Cyberia without holding the coin the fee is paid in. An address with USDC and no CYBER used to be stuck looking at money it could not send; now the wallet can ask the gas station for enough CYBER to cover the fee, and once it arrives you sign your own transaction exactly as before. It is a small amount, once in a while, for addresses that already have something here — the wallet shows what is left in the tank and where you stand before you ask.',
                        'Farming, in the wallet. The pools, what you have staked, what it has earned and a button to take it, without leaving for the exchange. Staking, unstaking and claiming are three separate things you agree to, and permission to spend is asked for exactly what you are staking and nothing beyond it.',
                        'Bridging, in the wallet. The destination address is already your own on the other chain, which is the reason this belongs in a wallet at all. Every route stays on the list: one this wallet cannot sign for tells you why instead of failing somewhere in the middle.',
                        'The Wired — what actually runs on this chain, in one place, and a plain answer to how a page and a wallet talk to each other.',
                        'A page that names who answers for each network: the address your wallet asks for balances and history, network by network, and what your app can honestly do about the route those requests take.',
                        'An inference API for $LAIN holders, at cyberia.church/api/ai/v1. It speaks the same language as the tools you already point at other providers, so most of them need only a new address and key. Access is a holding rather than a subscription: an address signs once for a key, and the key works for as long as the holding does — sell, and it closes by itself.',
                        'The desktop app downloads torrents. It is the one thing the site cannot do from a browser tab, so it lives in the app: nothing opens a connection until you agree once in a dialog no web page can draw, and that dialog says plainly that peers see your IP address and that the app\'s proxy setting does not cover this traffic.',
                        'The desktop app has a window of its own — the menus, the page title and the window buttons in one slim bar in the app\'s own colours, instead of the frame your desktop puts around everything else.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'Everything that reads Solana from your browser works again. Your Solana balance in the wallet, the bridge\'s balances and staking all went blank at the same moment, because the public Solana network answers servers and refuses browsers — it was never down, and from this side it looked like an outage nobody could find. Those reads now go through Cyberia and across several providers, so one of them running out of credit costs a moment instead of a page.',
                        'The chat\'s Solana posts and the daily digest went quiet for a day when a key behind them expired. Both now walk several sources rather than trusting one, and a digest Telegram refuses to render is sent as plain text instead of being retried into silence every minute.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.11.0',
            'date' => '2026-08-12',
            'title' => 'The wallet stops being only a place to keep things',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Swapping, inside the wallet. Trade one coin for another without leaving it and without connecting it to anything: the wallet finds the route itself, so a pair with no direct market still trades in one step, and you see the rate, the price impact and the fee before you sign.',
                        'The price you agreed to is the price you are protected at. What you read on the screen goes into the transaction as a floor, so if the market moves while you are deciding, the trade simply does not happen — you are never quietly filled at a worse rate.',
                        'Permission to spend a token is asked for the exact amount of the trade in front of you and nothing is left standing afterwards, so there is no open-ended approval sitting on your account waiting to be remembered.',
                        'Wrapping, one for one, on the networks where a coin has to become a token before a pool will accept it. No route, no slippage and nothing to choose, because there is nothing to choose.',
                        'NFTs in the wallet: what each of your accounts owns, and minting your own. What a token points at can be a picture, a page or a single line of text, and nothing here assumes it is an image.',
                        'Publishing to IPFS from the wallet. Put up a file or a whole page and get a permanent address made out of the contents themselves — anyone who has that address can fetch it from any node that holds it. Up to 10 MB at a time.',
                        'The wallet opens inside Telegram. @cyberia_network_bot has it behind the ☰ button and behind /open: the same wallet as the site, in the chat you were already in, and you can now create one there too. It carries the one warning that is only true inside Telegram — Telegram empties its own storage without asking, and your recovery phrase is what brings the wallet back.',
                        'The wallet, the download page and the leaderboard now read in Simplified Chinese as well as English and Russian — 简体中文, every screen, including every warning about what nobody can undo for you.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Prediction markets answer their own question where the question allows it. A market that names a price and where to read it settles from that source the moment it closes, without waiting on anybody. A market only a person can judge is refunded in full instead — every stake back, no fee — rather than expiring with the money still inside it, which is how two earlier markets ended.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'The browser extension took new passwords backwards. Setting up an extension wallet, each character went in front of the one before it, so what was saved was your password reversed — invisibly, since the field only ever shows dots. The current build at cyberia.church/download is fixed. If a wallet you set up earlier will not unlock, try typing that password in reverse; your recovery phrase restores it either way.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.10.0',
            'date' => '2026-08-12',
            'title' => 'The wallet, next to the address bar',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'The Cyberia wallet as a browser extension, for Chrome, Brave, Edge and Firefox. It lives next to the address bar and signs for the sites you are already on, so the swap, the launchpad and the DAO stop asking you to bring a wallet from somewhere else.',
                        'It is a wallet in its own right, not a window onto this site: the keys are made on your machine, encrypted with your password and never leave it. Enter the recovery phrase you already use and the same accounts are simply there.',
                        'A site sees an account only when you hand it one, one site at a time, and you can take it back whenever you like. Where you have granted nothing, the wallet stays invisible to the page — it cannot even be asked whether it exists.',
                        'Nothing is signed without being read first. Every request shows what leaves your account, which contract receives it, on which network and the most it can cost; a permission that would have no limit is named as unlimited instead of shown as a very long number.',
                        'The wallet can send its own traffic through Tor, I2P or a proxy you run, and it says plainly which of the two things your browser allows: in Firefox only the wallet is routed and the rest of your browsing is untouched.',
                        'Both builds are at cyberia.church/download, next to the desktop and Android apps.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.9.2',
            'date' => '2026-08-09',
            'title' => 'The wallet, installable',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'A download page at cyberia.church/download. The Cyberia wallet is now an app you can install on Windows, macOS, Linux and Android, and the page offers the right one for whatever you are reading it on.',
                        'Every build comes from one published release with a version, a date and checksums, so what you install is something you can verify — instead of a file somebody sent you in a chat.',
                        'A short link per platform, cyberia.church/download/android among them, that keeps pointing at the current build. One address to share, for good.',
                        'The app is the same wallet as the site and updates when the site does; you only reinstall when the app itself changes.',
                        'On iPhone and iPad there is nothing to install, and the page says so instead of pretending otherwise — it shows how to put the wallet on the home screen, which works today.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.9.1',
            'date' => '2026-08-09',
            'title' => 'Sealed mail between wallets',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Messages in the wallet, addressed by wallet address. There is no account to create, no name to claim and nobody to ask: if you know an address, you can write to whoever holds it.',
                        'Nothing you write leaves your device readable. Cyberia carries your messages the way a post office carries sealed envelopes — it passes them along and cannot open them. What it can see is which addresses are talking and when, and the wallet tells you that on the screen instead of burying it in a policy.',
                        'Nothing new to write down: the ability to read your messages comes back with the recovery phrase you already keep, and it is never the ability to spend your money.',
                        'Every wallet you talk to is remembered. If what protects an address ever changes, the wallet stops and says so rather than quietly carrying on — that is what an attempt to listen in looks like from your side.',
                        'The relay is a queue, not an archive: messages are handed over and then dropped after 30 days, and clearing your wallet from a device clears its conversations with it.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.9.0',
            'date' => '2026-08-08',
            'title' => 'One seed phrase, every chain',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'A wallet of your own at /wallet, built from nothing in this release: one recovery phrase and one password give you accounts on Cyberia, Robinhood Chain, BNB Smart Chain, Base, Solana, Bitcoin, Litecoin and Monero. The keys are created on your device and stay there — Cyberia never holds them, never sees them and cannot freeze what it does not have.',
                        'Everything about your money in one place: a portfolio valued in dollars, balances and transaction history per network, receive screens with QR codes, and sending with a choice of fee.',
                        'Your tokens show up on their own. On supported networks the wallet finds what you hold and prices it; where that is not possible, a token can be added by its address.',
                        'Bitcoin and Litecoin are full accounts you can send from, not just addresses that receive.',
                        'Any network you use can be added yourself — the wallet is not limited to the ones it ships with. Networks you add are marked as such, since their connection is one you chose and we cannot vouch for it.',
                        'Every payment is spelled out in one plain sentence and signed by holding, because a payment on these networks cannot be recalled.',
                        'The Cyberia desktop and mobile apps now open straight into the wallet and work the moment they are installed — no Cyberia account required.',
                        'A launchpad token can now be launched on several networks at once, each with its own supply and liquidity, and an interrupted launch can be resumed without paying twice.',
                        'Monero joins as a wallet in its own right rather than a bridged token, with its address usable as your bridge payout destination in one click. It receives today; balances are not yet shown, and the wallet tells you so.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Values in the wallet are the ones we can actually stand behind: a price we cannot read is shown as unavailable rather than as zero, and a total that is missing something says it is partial.',
                        'Lain can launch a token on the launchpad herself, but only after presenting the full plan — what it costs, what it opens at, and that it cannot be undone — and having that exact plan confirmed.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.8.0',
            'date' => '2026-07-30',
            'title' => 'Cyberia, installed',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Cyberia can now be installed as an app from supported mobile and desktop browsers, with a standalone window and home-screen shortcuts.',
                        'A branded offline fallback replaces the browser error page when an installed Cyberia app temporarily loses its connection.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.7.0',
            'date' => '2026-07-30',
            'title' => 'Profiles, feed & progression',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Public profiles now support round avatars, personal posts and a shared community feed.',
                        'XP, levels, daily streaks, quests and the leaderboard turn verified Cyberia activity into visible progression.',
                        'GitHub and Telegram accounts can be linked to a profile alongside X without creating a second Cyberia account.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'On-chain nicknames are now the canonical public identity and profile URL, replacing numeric profile addresses where a nickname exists.',
                        'Profile, retention and progression analytics give operators a clearer view of acquisition and ongoing activity.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'The Talk to Lain transcript now scrolls inside its own bounded chat panel instead of growing and moving the whole page.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.6.0',
            'date' => '2026-07-25',
            'title' => 'Robinhood Chain & multichain DEX',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Ritual DEX on Robinhood Chain: swap and provide liquidity in ETH, CYBER and ASH, with an ETH/CYBER market.',
                        'Farming, liquidity and swaps are now multichain — the page follows your wallet\'s network, and Robinhood markets, balances and pools stay entirely separate from Cyberia\'s.',
                        'Bridge native CYBER between Cyberia and Robinhood Chain.',
                        'Single-token staking page (/staking) for CYBER and Hatcher solo pools.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'ASH farm rewards are unified across chains from one emission source on Cyberia (capped at 436/day); Robinhood farms are paid in bridged ASH, so the token supply never fragments.',
                        'The Telegram bot announces solo-pool stakes and links each on-chain event to its own chain\'s explorer.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.5.0',
            'date' => '2026-07-19',
            'title' => 'Multi-wallet, multichain',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'One wallet picker for MetaMask, Phantom, Rabby, Trust Wallet, Coinbase Wallet, OKX Wallet, Solflare, and Backpack, with exact-provider discovery when several browser wallets are installed.',
                        'Optional WalletConnect support for QR codes and mobile deep links, opening Cyberia to wallets such as MetaMask Mobile, Trust, Rainbow, Ledger Live, OKX, and SafePal.',
                        'A network selector covering Cyberia, Robinhood Chain, Ethereum, BNB Smart Chain, Polygon, Base, Arbitrum One, and OP Mainnet. Cyberia is live; Robinhood Chain and Base integrations are in progress; the remaining networks are marked as coming soon.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Wallet login and on-chain actions now consistently use the provider selected by the user across Cyberia EVM and Solana flows.',
                        'Multi-network wallets are merged into a single choice with explicit EVM or Solana routing instead of appearing as duplicate entries.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.4.0',
            'date' => '2026-07-19',
            'title' => 'Talk to Lain',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Talk to Lain (/lain): a personal per-user chat with the resident Cyberia agent, built on LainOS. Tool-less by design, conversations persist per account.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.3.0',
            'date' => '2026-07-16',
            'title' => 'Current app surface',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'LainOS automation surfaces and the Wired on-chain game workspace.',
                        'Cyberia second-node deployment configuration for follower/RPC operations.',
                        'In-app changelog entry points in the Laravel headers.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Expanded the public Laravel bridge, swap, lending, farming, CRM, NFT, and PixelBattle surfaces.',
                        'Updated repository orientation docs to match the current monorepo layout.',
                    ],
                ],
                [
                    'label' => 'Fixed',
                    'items' => [
                        'Bridge settlement now uses verified on-chain deposit amounts.',
                        'External EVM ERC20 balance reads source the correct chain balances.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.2.0',
            'date' => '2026-06-11',
            'title' => 'Public release hygiene',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Public Laravel analytics surface at /analytics.',
                        'Initial GitHub Actions CI for Laravel and EVM contracts.',
                        'Ritual DEX environment template without secret values.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'README explains the Singularity monorepo layout and Cyberia network components.',
                        'Local .env files are ignored and the tracked Ritual DEX .env was removed from git.',
                    ],
                ],
            ],
        ],
        [
            'version' => 'v0.1.0',
            'date' => '2026-05-29',
            'title' => 'Launchpad and bridge expansion',
            'sections' => [
                [
                    'label' => 'Added',
                    'items' => [
                        'Launchpad token records and generated site storage.',
                        'Token directory and Cyberia profile deposit-address flows.',
                        'Expanded bridge corridors for Solana, TON, BNB, Base, Bitcoin-family chains, and Monero.',
                    ],
                ],
                [
                    'label' => 'Changed',
                    'items' => [
                        'Bridge and DEX screens were refreshed around live liquidity and route availability.',
                    ],
                ],
            ],
        ],
    ],
];
