<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CYBER.sol whale verification</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         background:#0a0a0f; color:#e6e6f0; display:flex; min-height:100vh;
         align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:460px; background:#13131c; border:1px solid #262636;
          border-radius:14px; padding:28px; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { color:#9a9ab0; font-size:13px; line-height:1.55; }
  .act { display:block; width:100%; box-sizing:border-box; padding:13px; margin-top:16px;
         border:0; border-radius:10px; background:#7c3aed; color:#fff; font-size:15px;
         font-weight:600; cursor:pointer; text-align:center; text-decoration:none;
         font-family:inherit; }
  .act[hidden] { display:none; }
  .act.ghost { background:transparent; border:1px solid #303046; color:#9a9ab0;
               font-weight:500; }
  .act:disabled { opacity:.5; cursor:not-allowed; }
  .hint { margin-top:14px; font-size:12px; color:#71718c; }
  .out { margin-top:16px; padding:14px; border-radius:10px; background:#0f0f17;
         border:1px solid #262636; font-size:13px; white-space:pre-wrap; display:none; }
  .ok { border-color:#1f7a4d; } .bad { border-color:#7a1f1f; }
  .addr { color:#a78bfa; word-break:break-all; }
  .lang { margin-top:20px; font-size:12px; color:#4a4a60; text-align:right; }
  .lang button { background:none; border:0; color:#71718c; font:inherit; cursor:pointer;
                 padding:0 4px; }
  .lang button[aria-pressed="true"] { color:#a78bfa; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">Whales chat — CYBER.sol verification</h1>
  <p id="lede"></p>

  <a  id="open" class="act" hidden></a>
  <button id="go" class="act" hidden></button>
  <a  id="install" class="act ghost" href="https://phantom.com/download" target="_blank" rel="noopener" hidden></a>
  <button id="copy" class="act ghost" hidden></button>
  <button id="again" class="act ghost" hidden></button>

  <p id="hint" class="hint"></p>
  <div id="out" class="out"></div>

  <div class="lang">
    <button type="button" data-lang="en" aria-pressed="false">EN</button>
    <button type="button" data-lang="ru" aria-pressed="false">RU</button>
  </div>
</div>

<script>
const TOKEN = @json($token);
const VALID = @json($valid);
const THRESHOLD = @json($threshold);

// Reopen THIS page inside Phantom's own in-app browser — the only place on a
// phone where a Solana provider exists. A plain mobile browser, and Telegram's
// web view where these links are actually tapped, inject nothing, so "connect"
// there can never work.
//
// Two spellings of the same handover, because neither works everywhere: a web
// view hands an unknown scheme to the OS (which is what Telegram does), while
// a universal link is resolved by the browser and is ignored inside iOS's
// in-app Safari. Scheme first, https a second later if we are still here.
const BROWSE = 'browse/' + encodeURIComponent(location.href)
  + '?ref=' + encodeURIComponent(location.origin);
const DEEPLINK = 'https://phantom.app/ul/' + BROWSE;
const SCHEME = 'phantom://' + BROWSE;

const T = {
  en: {
    title: 'Whales chat — CYBER.sol verification',
    lede: n => 'Prove you hold <b>' + n + '+ CYBER.sol</b> by signing with Phantom. '
             + 'Nothing is sent on-chain — the signature only proves you control the wallet.',
    open: 'Open in Phantom',
    go: 'Connect Phantom & sign',
    install: 'Install the Phantom extension',
    copy: 'Copy the link',
    copied: 'Link copied',
    again: 'Check again',
    hintMobile: 'A phone browser has no wallet inside it — neither does Telegram’s. '
              + 'Tap “Open in Phantom”: the page reopens in Phantom’s own browser, where signing works. '
              + 'If nothing opens, copy the link and paste it into Phantom → the “Browser” tab.',
    hintDesktop: 'No Phantom in this browser. Install the extension and press “Check again”, '
               + 'or copy the link and open it on your phone in the Phantom app’s browser.',
    invalid: 'This link is invalid or expired. Send /whale to the bot for a fresh one.',
    connecting: 'Connecting to Phantom…',
    challenge: 'Requesting a challenge…',
    approve: 'Approve the signature in Phantom…',
    verifying: 'Verifying signature & reading balance…',
    noChallenge: 'Could not get a challenge, try again.',
    failed: 'Verification failed.',
    whale: (addr, bal) => '✅ Verified whale!\n\n' + addr + '\n' + bal + ' CYBER.sol\n\n'
         + 'Return to Telegram — the bot will DM you a one-time invite shortly.',
    short: (addr, bal, need) => 'Wallet verified, but the balance is below the threshold.\n\n'
         + addr + '\n' + bal + ' CYBER.sol (need ' + need + ')\n\nTop up and run /whale again.',
    error: msg => 'Error: ' + msg,
  },
  ru: {
    title: 'Чат китов — проверка CYBER.sol',
    lede: n => 'Докажите, что держите <b>' + n + '+ CYBER.sol</b> — подпишите сообщение в Phantom. '
             + 'Ничего не уходит в сеть: подпись лишь доказывает, что кошелёк ваш.',
    open: 'Открыть в Phantom',
    go: 'Подключить Phantom и подписать',
    install: 'Установить расширение Phantom',
    copy: 'Скопировать ссылку',
    copied: 'Ссылка скопирована',
    again: 'Проверить снова',
    hintMobile: 'В браузере телефона кошелька нет — и во встроенном браузере Telegram тоже. '
              + 'Нажмите «Открыть в Phantom»: страница откроется внутри Phantom, там подпись работает. '
              + 'Если ничего не открылось — скопируйте ссылку и вставьте её в Phantom → вкладка «Браузер».',
    hintDesktop: 'В этом браузере нет Phantom. Установите расширение и нажмите «Проверить снова» '
               + 'или скопируйте ссылку и откройте её на телефоне в браузере приложения Phantom.',
    invalid: 'Ссылка недействительна или истекла. Отправьте боту /whale, чтобы получить новую.',
    connecting: 'Подключаемся к Phantom…',
    challenge: 'Запрашиваем challenge…',
    approve: 'Подтвердите подпись в Phantom…',
    verifying: 'Проверяем подпись и читаем баланс…',
    noChallenge: 'Не удалось получить challenge, попробуйте ещё раз.',
    failed: 'Проверка не прошла.',
    whale: (addr, bal) => '✅ Кит подтверждён!\n\n' + addr + '\n' + bal + ' CYBER.sol\n\n'
         + 'Вернитесь в Telegram — бот пришлёт одноразовое приглашение.',
    short: (addr, bal, need) => 'Кошелёк проверен, но баланс ниже порога.\n\n'
         + addr + '\n' + bal + ' CYBER.sol (нужно ' + need + ')\n\nПополните и снова отправьте /whale.',
    error: msg => 'Ошибка: ' + msg,
  },
};

let lang = (navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';
const t = () => T[lang];

const el = id => document.getElementById(id);
const out = el('out'), btn = el('go'), openBtn = el('open'), copyBtn = el('copy'),
      againBtn = el('again'), installBtn = el('install'), hint = el('hint');

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
let lastStatus = null; // re-rendered on a language switch

function show(msg, kind) {
  out.style.display = 'block';
  out.className = 'out' + (kind ? ' ' + kind : '');
  out.innerHTML = msg;
}
function status(key, kind) {   // a dictionary key, so it survives a language switch
  lastStatus = { key, kind };
  show(t()[key], kind);
}

/** Any injected Solana provider that can connect and sign (Phantom, Solflare…). */
function provider() {
  const p = (window.phantom && window.phantom.solana) || window.solana;
  return (p && typeof p.connect === 'function' && typeof p.signMessage === 'function') ? p : null;
}

/** The extension injects before load, but an in-app browser can be a beat late. */
function waitForProvider(ms) {
  return new Promise(resolve => {
    const started = Date.now();
    (function poll() {
      const p = provider();
      if (p || Date.now() - started > ms) return resolve(p);
      setTimeout(poll, 200);
    })();
  });
}

function render() {
  document.documentElement.lang = lang;
  document.title = t().title;
  el('title').textContent = t().title;
  el('lede').innerHTML = t().lede(THRESHOLD.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US'));
  btn.textContent = t().go;
  openBtn.textContent = t().open;
  copyBtn.textContent = t().copy;
  againBtn.textContent = t().again;
  installBtn.textContent = t().install;
  if (hint.dataset.key) hint.textContent = t()[hint.dataset.key];
  if (lastStatus) show(t()[lastStatus.key], lastStatus.kind);
  for (const b of document.querySelectorAll('.lang button')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
}

/** Which buttons this environment can honestly offer. */
function offer(hasProvider) {
  btn.hidden = !hasProvider;
  openBtn.hidden = hasProvider || !isMobile;
  installBtn.hidden = hasProvider || isMobile;
  copyBtn.hidden = hasProvider;
  againBtn.hidden = hasProvider;
  hint.dataset.key = hasProvider ? '' : (isMobile ? 'hintMobile' : 'hintDesktop');
  hint.textContent = hasProvider ? '' : t()[hint.dataset.key];
  openBtn.href = DEEPLINK;
}

for (const b of document.querySelectorAll('.lang button')) {
  b.onclick = () => { lang = b.dataset.lang; render(); };
}

openBtn.onclick = (e) => {
  e.preventDefault();
  window.location.href = SCHEME;
  // Still on this page a second later means nothing claimed the scheme.
  setTimeout(() => {
    if (!document.hidden) window.location.href = DEEPLINK;
  }, 1000);
};

copyBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    const box = document.createElement('textarea');
    box.value = location.href;
    document.body.appendChild(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
  copyBtn.textContent = t().copied;
  setTimeout(() => { copyBtn.textContent = t().copy; }, 2000);
};

againBtn.onclick = async () => {
  againBtn.disabled = true;
  offer(!!await waitForProvider(1500));
  againBtn.disabled = false;
};

// Coming back from an install or an app switch should not need a reload.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && VALID && provider()) offer(true);
});

btn.onclick = async () => {
  const p = provider();
  if (!p) { offer(false); return; }
  btn.disabled = true;
  try {
    status('connecting');
    const { publicKey } = await p.connect();
    const address = publicKey.toString();

    status('challenge');
    const nRes = await fetch('/api/tg/cyber-sol/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ wallet_address: address }),
    });
    if (!nRes.ok) throw new Error(t().noChallenge);
    const { nonce } = await nRes.json();

    status('approve');
    const message = 'Sign this message to authenticate with your wallet. Nonce: ' + nonce;
    const signed = await p.signMessage(new TextEncoder().encode(message), 'utf8');
    // Phantom answers with {signature}; some wallets hand back the bytes directly.
    const bytes = signed && signed.signature ? signed.signature : signed;
    let s = '';
    for (const byte of bytes) s += String.fromCharCode(byte);
    const signature = btoa(s);

    status('verifying');
    const vRes = await fetch('/api/tg/cyber-sol/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ t: TOKEN, wallet_address: address, signature }),
    });
    const data = await vRes.json();
    if (!vRes.ok) throw new Error(data.message || t().failed);

    const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
    const bal = Number(data.balance).toLocaleString(locale, { maximumFractionDigits: 2 });
    const addr = '<span class="addr">' + address + '</span>';
    lastStatus = null;
    if (data.is_whale) {
      show(t().whale(addr, bal), 'ok');
    } else {
      show(t().short(addr, bal, THRESHOLD.toLocaleString(locale)), 'bad');
      btn.disabled = false;
    }
  } catch (e) {
    lastStatus = null;
    show(t().error(e.message || e), 'bad');
    btn.disabled = false;
  }
};

render();
if (!VALID) {
  status('invalid', 'bad');
} else {
  offer(!!provider());                           // never a dead "connect" button
  waitForProvider(1200).then(p => offer(!!p));
}
</script>
</body>
</html>
