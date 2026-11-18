<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05090a">
<title>Cyberia — the chain that pays open source back</title>
<meta name="description" content="Cyberia is a sovereign EVM chain where a contribution is an economic event. The cube is the chain itself, live: every block on the road behind it is a real one, read as it lands. Wallet, swap, bridge, DAO, lending and a launchpad, all running on it.">
<meta property="og:type" content="website">
<meta property="og:title" content="Cyberia — the chain that pays open source back">
<meta property="og:description" content="A sovereign EVM chain, live in 3D: every block as it lands, every door into the ecosystem, every token launched on it.">
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
};
</script>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
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
      <p class="lede">Cyberia is the missing layer: a sovereign chain where a contribution — code, content, moderation, capital — is an economic event, recorded and settled. The cube is the chain itself. Every stone on the road behind it is a real block, read from the network the second it lands.</p>
      <div class="ctas">
        <a class="btn cyan" href="/wallet">Open the wallet</a>
        <a class="btn" href="#doors">Walk through the doors</a>
      </div>
      <p class="hint">Drag to turn the cube. Point at a block to read it, click it to open it in the explorer.</p>
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
      <p class="eyebrow">Cyberia 2.0</p>
      <h2>The same temple, on Avalanche.</h2>
      <p>The wireframe cube is Cyberia 2.0: its own Avalanche L1, running on the Fuji testnet today. Network fees go to the DAO treasury, a multisig Safe, instead of to a company. The wallet already speaks both chains, and the old one stays.</p>
      <dl class="params" id="fuji">
        <div><dt>Block</dt><dd data-fuji="block">–</dd></div>
        <div><dt>Chain ID</dt><dd data-fuji="chain">49407</dd></div>
        <div><dt>DAO treasury</dt><dd data-fuji="treasury">–</dd></div>
        <div><dt>Validator</dt><dd data-fuji="validator">–</dd></div>
      </dl>
      <ul class="road">
        <li><b>Running</b> Sovereign EVM L1 · wallet, DEX, bridge, DAO, lending, launchpad · on-chain profiles</li>
        <li><b>In motion</b> Cyberia 2.0 on Avalanche · Lain’s agents on-chain · the Wired and NO CARRIER</li>
        <li><b>Next</b> Independent validators · contribution-weighted governance · settlement for open-source work</li>
      </ul>
      <div class="ctas">
        <a class="btn" href="/fuji">Get test CYBER on 2.0</a>
      </div>
    </div>
  </section>

  <section class="panel end" id="join" data-scene="join">
    <div class="copy">
      <p class="eyebrow">Step inside</p>
      <h2>One wallet. Every door.</h2>
      <p>One seed phrase for Cyberia, Solana, Bitcoin, Litecoin, Monero and every EVM network you add, with encrypted messages between wallets. In the browser, or installed on Windows, macOS, Linux and Android.</p>
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
