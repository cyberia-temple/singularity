<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05090a">
<title>Cyberia — the chain that pays open source back</title>
<meta name="description" content="Cyberia is a sovereign EVM chain where a contribution is an economic event, now relaunching as its own Avalanche L1 — Cyberia 2.0. The cube is the chain itself, live: every block on the road behind it is a real one. Swap across chains, open the wallet, walk through the doors.">
<meta property="og:type" content="website">
<meta property="og:title" content="Cyberia — the chain that pays open source back">
<meta property="og:description" content="A sovereign EVM chain, live in 3D — relaunching on Avalanche as Cyberia 2.0. Every block as it lands, a swap across chains, every door into the ecosystem.">
<meta property="og:url" content="{{ route('temple') }}">
<meta property="og:image" content="https://cyberia.church/cyberia_logo.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@cyberia_chain">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/css/cyberia-3d.css?v={{ filemtime(public_path('css/cyberia-3d.css')) }}">
@include('partials.session-replay')
<script>
window.CYBERIA_3D = {
  rpc: @json($network['rpc']),
  explorer: @json($network['explorer']),
  stats: @json($network['explorer'].'api/v2/stats'),
  tokens: @json(url('/api/launchpad/tokens')),
  fuji: @json(url('/api/fuji/chain')),
  tokenPage: @json(url('/token')),
  cube: '/assets/cube.png',
  textures: '/assets/3d/',
  texturesVersion: @json($assetsVersion),
  swap: {
    config: @json(url('/api/wallet/crosschain')),
    quote: @json(url('/api/wallet/crosschain/quote')),
    wallet: @json(url('/wallet')),
  },
};
</script>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/",
  "cyberia-swap": "/js/cyberia-3d-swap.js?v={{ filemtime(public_path('js/cyberia-3d-swap.js')) }}"
} }
</script>
</head>
<body>
<canvas id="scene" aria-hidden="true"></canvas>
<div id="labels" aria-hidden="true"></div>
<div id="tip" role="status" hidden></div>

<header class="nav">
  <a class="mark" href="#top" aria-label="Cyberia, top of the page"><b>CYBERIA</b><span>chain 49406</span></a>
  <nav aria-label="Sections">
    <a href="#chain">The chain</a>
    <a href="#doors">Doors</a>
    <a href="#launched">Launched here</a>
    <a href="#next">Cyberia 2.0</a>
  </nav>
  <a class="btn cyan small" href="/wallet">Open the wallet</a>
</header>

<main>
  <section class="hero" id="top" data-scene="hero">
    <div class="copy">
      <p class="live" id="live"><i></i><span>Reading the chain…</span></p>
      <h1>Open source built the world.<br><em>The world forgot to pay it back.</em></h1>
      <p class="lede">Cyberia is the missing layer: a sovereign chain where a contribution — code, content, moderation, capital — is an economic event, recorded and settled. The cube is the chain itself; every stone on the road behind it is a real block, read the second it lands.</p>
      <div class="ctas">
        <a class="btn cyan" href="/wallet">Open the wallet</a>
        <a class="btn" href="#doors">Walk through the doors</a>
      </div>
      <a class="relaunch" href="#next">
        <span class="relaunch-tag">Cyberia 2.0</span>
        <span class="relaunch-text"><b>The chain is relaunching on Avalanche.</b> Its testnet is live; mainnet is next, and bridges open with it.</span>
      </a>
    </div>
    <div class="swap-home">
      <aside class="swap" id="swap" aria-labelledby="swap-title">
        <header class="swap-head">
          <h2 id="swap-title">Swap across chains</h2>
          <p class="swap-kicker">Any coin · any chain</p>
        </header>
        <div class="swap-row">
          <span class="swap-coin" data-coin="from" aria-hidden="true"></span>
          <div class="swap-cell">
            <label class="swap-label" for="swap-amount">You pay</label>
            <div class="swap-line">
              <input class="swap-amount" id="swap-amount" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="0.05" aria-describedby="swap-in-usd">
              <button class="swap-asset" type="button" data-pick="from" aria-haspopup="listbox">ETH</button>
            </div>
            <span class="swap-sub" id="swap-in-usd" data-out="in-usd"></span>
          </div>
        </div>
        <div class="swap-mid"><button class="swap-flip" type="button" aria-label="Turn the route around">⇅</button></div>
        <div class="swap-row">
          <span class="swap-coin" data-coin="to" aria-hidden="true"></span>
          <div class="swap-cell">
            <span class="swap-label">You get</span>
            <div class="swap-line">
              <output class="swap-amount" data-out="amount" aria-live="polite">–</output>
              <button class="swap-asset" type="button" data-pick="to" aria-haspopup="listbox">BTC</button>
            </div>
            <span class="swap-sub" data-out="out-usd"></span>
          </div>
        </div>
        <dl class="swap-facts">
          <div><dt>Arrives</dt><dd data-out="time">–</dd></div>
          <div><dt>Cyberia fee</dt><dd data-out="fee">–</dd></div>
          <div><dt>Total cost</dt><dd data-out="impact">–</dd></div>
        </dl>
        <p class="swap-note" data-out="note" role="status"></p>
        <a class="btn cyan swap-go" data-out="go" href="/wallet?section=crosschain">Swap in Cyberia Wallet →</a>
        <p class="swap-small">A live price from Relay. You sign in the wallet, which prices it again for your own address — keys never leave your browser.</p>
        <div class="swap-pick" hidden>
          <div class="swap-pick-head"><b>Pay with</b><button class="swap-x" type="button" aria-label="Close the list">×</button></div>
          <ul role="listbox" aria-label="Coins and networks"></ul>
        </div>
      </aside>
    </div>
    <dl class="pulse" id="pulse">
      <div><dt>Blocks</dt><dd data-pulse="blocks">–</dd></div>
      <div><dt>Transactions</dt><dd data-pulse="transactions">–</dd></div>
      <div><dt>Transactions today</dt><dd data-pulse="today">–</dd></div>
      <div><dt>Tokens launched</dt><dd data-pulse="launched">–</dd></div>
      <div><dt>Doors open</dt><dd data-pulse="doors">–</dd></div>
    </dl>
  </section>

  <section class="panel" id="chain" data-scene="chain">
    <div class="copy">
      <p class="eyebrow">The chain</p>
      <h2>The chain has no back office.</h2>
      <p>Cyberia is an EVM Layer 1 with its own gas token, CYBER. A block every second, since genesis, every one of them public. The road behind the cube is the newest of them in the order they landed: the bright ones carry transactions, the dark ones kept time.</p>
      <p class="muted" id="chain-note">Waiting for the next block…</p>
      <dl class="params">
        <div><dt>Network</dt><dd>{{ $network['name'] }}</dd></div>
        <div><dt>Chain ID</dt><dd>{{ $network['chainId'] }} <span>· {{ $network['chainIdHex'] }}</span></dd></div>
        <div><dt>RPC</dt><dd>{{ $network['rpc'] }}</dd></div>
        <div><dt>Gas token</dt><dd>{{ $network['symbol'] }}</dd></div>
      </dl>
      <div class="ctas">
        <button class="btn cyan" type="button" id="add-network">Add Cyberia to MetaMask</button>
        <a class="btn" href="{{ $network['explorer'] }}" rel="noopener">Open the explorer ↗</a>
      </div>
      <p class="muted small" id="add-network-note" role="status"></p>
    </div>
  </section>

  <section class="panel" id="doctrine" data-scene="doctrine">
    <div class="copy">
      <p class="eyebrow">Why Cyberia exists</p>
      <h2>Contribution is capital.</h2>
      <p>Every bank, hospital and phone runs on code written by people who were mostly never paid for it. That is not a failure of goodwill, it is missing infrastructure: open-source work has no settlement layer. Cyberia is built to be one.</p>
      <ol class="tenets">
        <li><b>Built in public. Always.</b> No private repo, no off-the-record roadmap.</li>
        <li><b>Contribution is measured.</b> If work was done, it is recorded; if value was created, it can settle.</li>
        <li><b>Infrastructure first. Hype never.</b> Built to still be running in 2036.</li>
        <li><b>Forkable by design.</b> GPL-3.0 from consensus to UI.</li>
      </ol>
      <div class="ctas">
        <a class="btn" href="/whitepaper">Read the whitepaper</a>
      </div>
    </div>
  </section>

  <section class="panel" id="doors" data-scene="doors">
    <div class="copy wide">
      <p class="eyebrow">The ecosystem</p>
      <h2>One chain. Many doors in.</h2>
      <p>Every cube around the temple is something running against the same L1. The inner ring is on the chain, the outer ring is beyond it. Click one to go through.</p>
      <div class="doors">
        <h3>On the chain</h3>
        <ul>
          @foreach ($doors['chain'] as $door)
            <li><a class="door" href="{{ $door['href'] }}" data-ring="0" data-icon="{{ $door['icon'] }}" data-status="{{ $door['status'] }}" data-kind="{{ $door['kind'] }}" data-desc="{{ $door['desc'] }}"><b>{{ $door['name'] }}</b><span>{{ $door['kind'] }}</span></a></li>
          @endforeach
        </ul>
        <h3>Beyond the chain</h3>
        <ul>
          @foreach ($doors['beyond'] as $door)
            <li><a class="door" @if ($door['href']) href="{{ $door['href'] }}" @endif data-ring="1" data-icon="{{ $door['icon'] }}" data-status="{{ $door['status'] }}" data-kind="{{ $door['kind'] }}" data-desc="{{ $door['desc'] }}"><b>{{ $door['name'] }}</b><span>{{ $door['status'] === 'dev' ? 'in development' : $door['kind'] }}</span></a></li>
          @endforeach
        </ul>
      </div>
    </div>
  </section>

  <section class="panel" id="launched" data-scene="launched">
    <div class="copy">
      <p class="eyebrow">Launched here</p>
      <h2>A temple built from what launched on it.</h2>
      <p>Every lit stone of the step pyramid is a real token launched on Cyberia, newest at the top. A launch is one transaction; ten CYBER are burned into locked liquidity at birth, so there is no rug lever to pull.</p>
      <p class="muted" id="launched-note">Reading the launchpad…</p>
      <div class="ctas">
        <a class="btn cyan" href="/launchpad">Launch a token</a>
        <a class="btn" href="/tokens">Every token</a>
      </div>
    </div>
  </section>

  <section class="panel" id="next" data-scene="next">
    <div class="copy">
      <p class="eyebrow">Cyberia 2.0 · Avalanche</p>
      <h2>The chain is moving to Avalanche.</h2>
      <p>Cyberia relaunches as its own Avalanche L1 — the same temple on stronger ground, with CYBER still the coin you pay gas in. The wired cube on the horizon is that chain, live on the Fuji testnet today. Its network fees already go to the DAO treasury, a multisig Safe, instead of to a company.</p>
      <p><b class="hl">Bridges are coming.</b> When mainnet opens, CYBER.sol from Solana, CYBER from today’s chain and AVAX from the C-Chain will cross into 2.0. Nothing needs moving yet: today’s chain keeps running, and the wallet already speaks both.</p>
      <dl class="params" id="fuji">
        <div><dt>Testnet block</dt><dd data-fuji="block">–</dd></div>
        <div><dt>Chain ID</dt><dd data-fuji="chain">49407</dd></div>
        <div><dt>DAO treasury</dt><dd data-fuji="treasury">–</dd></div>
        <div><dt>Validator</dt><dd data-fuji="validator">–</dd></div>
      </dl>
      <ol class="road">
        <li class="done"><b>Live</b> Fuji testnet · chain 49407 · test CYBER from the faucet · every fee to the DAO</li>
        <li><b>Next</b> Bridges into 2.0 — from Solana, from today’s chain and from the C-Chain</li>
        <li><b>Then</b> An outside security review of the protocol, and mainnet</li>
        <li><b>After</b> Independent validators · contribution-weighted governance</li>
      </ol>
      <div class="ctas">
        <a class="btn cyan" href="/fuji">Get test CYBER on 2.0</a>
        <a class="btn" href="/wallet">Open the wallet</a>
      </div>
    </div>
  </section>

  <section class="panel end" id="join" data-scene="join">
    <div class="copy">
      <p class="eyebrow">Step inside</p>
      <h2>One wallet. Every door.</h2>
      <p>One seed phrase for Cyberia, Solana, Bitcoin, Litecoin, Monero and every EVM network you add, with a swap between any two of them and encrypted messages between wallets. In the browser, or installed on Windows, macOS, Linux and Android.</p>
      <div class="ctas">
        <a class="btn cyan" href="/wallet">Open the wallet</a>
        <a class="btn" href="/download">Install it</a>
      </div>
      <ul class="links">
        <li><a href="https://t.me/cyberia_network" rel="noopener">Telegram</a></li>
        <li><a href="https://x.com/cyberia_chain" rel="noopener">X</a></li>
        <li><a href="https://github.com/cyberia-temple/singularity/" rel="noopener">GitHub</a></li>
        <li><a href="https://cyberia-temple.github.io" rel="noopener">Blog</a></li>
        <li><a href="https://pump.fun/coin/{{ $cyberSol }}" rel="noopener">$CYBER.sol</a></li>
        <li><a href="{{ route('home') }}?site">The classic site</a></li>
      </ul>
    </div>
  </section>
</main>

<footer class="foot">
  <span>Cyberia · GPL-3.0 · built in public</span>
  <span id="foot-block"></span>
</footer>

<noscript><style>#scene,#labels{display:none}</style></noscript>
<script type="module" src="/js/cyberia-3d.js?v={{ filemtime(public_path('js/cyberia-3d.js')) }}"></script>
</body>
</html>
