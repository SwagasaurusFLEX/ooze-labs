/* OOZE LABS — frontend logic */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const API = '';
const STORAGE_KEY = 'oozeLabsWallet'; // {provider, address} for sticky reconnect
const RPC_URL_FALLBACK = 'http://77.42.80.65:8911';

// ─────────────────────────── formatters ───────────────────────────
function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtSol(s) {
  if (s === null || s === undefined) return '—';
  if (s >= 1e6) return (s / 1e6).toFixed(1) + 'M ◎';
  if (s >= 1e3) return (s / 1e3).toFixed(1) + 'K ◎';
  return Math.floor(s).toLocaleString() + ' ◎';
}
function shortKey(k) {
  if (!k || typeof k !== 'string') return '—';
  if (k.length <= 12) return k;
  return k.slice(0, 4) + '…' + k.slice(-4);
}

// ─────────────────────────── copy buttons ───────────────────────────
$$('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = $('#' + btn.dataset.target);
    if (!target) return;
    const text = target.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1400);
    } catch (e) {
      btn.textContent = 'err';
      setTimeout(() => { btn.textContent = 'copy'; }, 1400);
    }
  });
});

// ─────────────────────────── info bootstrap ───────────────────────────
let RPC_URL = RPC_URL_FALLBACK;

async function loadInfo() {
  try {
    const res = await fetch(API + '/api/info');
    const data = await res.json();
    if (data.rpcUrl) {
      RPC_URL = data.rpcUrl;
      $('#rpc-url').textContent = data.rpcUrl;
      $('#cli-url').textContent = data.rpcUrl;
      $$('.rpc-inline').forEach((el) => el.textContent = data.rpcUrl);
    }
    if (data.faucetPubkey) $('#faucet-pubkey-foot').textContent = shortKey(data.faucetPubkey);
    if (data.dripCapSol) {
      const amtInput = $('#drip-amount');
      if (amtInput) amtInput.max = data.dripCapSol;
    }
  } catch (e) { /* non-fatal */ }
}

// ─────────────────────────── stats poll ───────────────────────────
let statsFails = 0;
async function loadStats() {
  try {
    const res = await fetch(API + '/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();

    $('#stat-slot').textContent = fmtNum(data.slot);
    $('#stat-txns').textContent = fmtNum(data.transactionCount);
    $('#stat-validators').textContent = fmtNum(data.validatorCount);
    $('#stat-faucet').textContent = fmtSol(data.faucetBalanceSol);

    if (data.validatorIdentity) {
      $('#validator-id-foot').textContent = shortKey(data.validatorIdentity);
    }

    $('#status-dot').classList.add('live');
    $('#status-dot').classList.remove('err');
    $('#status-text').textContent = 'live';
    statsFails = 0;
  } catch (e) {
    statsFails++;
    if (statsFails > 2) {
      $('#status-dot').classList.remove('live');
      $('#status-dot').classList.add('err');
      $('#status-text').textContent = 'rpc unreachable';
    }
  }
}

// ─────────────────────────── wallet detection ───────────────────────────
function isMobile() {
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function getProvider(name) {
  // Returns the provider object or null.
  // Each wallet exposes a different shape. Keep it tolerant.
  if (name === 'phantom') {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana; // legacy
    return null;
  }
  if (name === 'solflare') {
    if (window.solflare?.isSolflare) return window.solflare;
    return null;
  }
  if (name === 'backpack') {
    if (window.backpack?.isBackpack) return window.backpack;
    if (window.xnft?.solana) return window.xnft.solana; // older Backpack
    return null;
  }
  return null;
}

function walletInstallUrl(name) {
  return ({
    phantom: 'https://phantom.app/download',
    solflare: 'https://solflare.com/download',
    backpack: 'https://backpack.app/downloads',
  })[name];
}

function mobileDeepLink(name) {
  // Each wallet has its own deep link / universal-link convention for opening
  // the dApp inside their in-app browser.
  const dapp = encodeURIComponent(window.location.origin + window.location.pathname);
  if (name === 'phantom') {
    // https://docs.phantom.com/phantom-deeplinks/provider-methods/connect
    return 'https://phantom.app/ul/browse/' + dapp + '?ref=' + dapp;
  }
  if (name === 'solflare') {
    return 'https://solflare.com/ul/v1/browse/' + dapp + '?ref=' + dapp;
  }
  if (name === 'backpack') {
    return 'https://backpack.app/ul/browse?url=' + dapp;
  }
  return null;
}

function refreshWalletStatuses() {
  ['phantom', 'solflare', 'backpack'].forEach((name) => {
    const el = document.querySelector(`[data-wallet-status="${name}"]`);
    if (!el) return;
    const provider = getProvider(name);
    if (provider) {
      el.textContent = 'detected';
      el.dataset.state = 'detected';
    } else if (isMobile()) {
      el.textContent = 'open in app';
      el.dataset.state = 'mobile';
    } else {
      el.textContent = 'not installed';
      el.dataset.state = 'missing';
    }
  });
}

// ─────────────────────────── wallet state ───────────────────────────
let connected = null; // { provider, providerName, publicKey }

function setWalletButtonConnected(addr) {
  const btn = $('#wallet-btn');
  btn.classList.add('connected');
  btn.querySelector('.wallet-btn-label').textContent = shortKey(addr);
}
function setWalletButtonDisconnected() {
  const btn = $('#wallet-btn');
  btn.classList.remove('connected');
  btn.querySelector('.wallet-btn-label').textContent = 'CONNECT';
}

function reflectConnectedUI() {
  const useBtn = $('#drip-use-connected');
  const addRpcBtn = $('#add-rpc-btn');
  const addRpcHint = $('#add-rpc-hint');

  if (connected) {
    setWalletButtonConnected(connected.publicKey);
    useBtn.hidden = false;
    addRpcBtn.disabled = false;
    addRpcHint.textContent = `connected: ${shortKey(connected.publicKey)} via ${connected.providerName}`;
  } else {
    setWalletButtonDisconnected();
    useBtn.hidden = true;
    addRpcBtn.disabled = true;
    addRpcHint.textContent = 'connect a wallet first to use this';
  }
}

async function connectWallet(name) {
  const provider = getProvider(name);
  if (!provider) {
    if (isMobile()) {
      const link = mobileDeepLink(name);
      if (link) window.location.href = link;
      return;
    }
    window.open(walletInstallUrl(name), '_blank');
    return;
  }
  try {
    const resp = await provider.connect();
    // Different wallets return slightly different shapes.
    let pubkey =
      resp?.publicKey?.toString?.() ||
      provider.publicKey?.toString?.() ||
      (typeof resp === 'string' ? resp : null);
    if (!pubkey) throw new Error('no public key returned');

    connected = { provider, providerName: name, publicKey: pubkey };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: name, address: pubkey }));
    } catch (_) {}

    // Wire disconnect listeners if exposed.
    if (provider.on) {
      provider.on('disconnect', onProviderDisconnect);
      provider.on('accountChanged', (newPk) => {
        if (newPk) {
          connected.publicKey = newPk.toString();
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: name, address: connected.publicKey }));
          } catch (_) {}
          reflectConnectedUI();
        } else {
          onProviderDisconnect();
        }
      });
    }

    closeModal();
    reflectConnectedUI();
  } catch (e) {
    // User cancelled or wallet rejected.
    flashWalletError(name, e?.message || 'connection rejected');
  }
}

function onProviderDisconnect() {
  connected = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  reflectConnectedUI();
}

async function disconnectWallet() {
  if (!connected) return;
  try {
    if (connected.provider?.disconnect) {
      await connected.provider.disconnect();
    }
  } catch (_) {}
  onProviderDisconnect();
}

async function tryRestoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch (_) { saved = null; }
  if (!saved?.provider) return;
  const provider = getProvider(saved.provider);
  if (!provider) return;
  try {
    // Most wallets support `connect({ onlyIfTrusted: true })` — silent reconnect.
    const resp = await provider.connect({ onlyIfTrusted: true });
    const pubkey =
      resp?.publicKey?.toString?.() ||
      provider.publicKey?.toString?.();
    if (!pubkey) return;
    connected = { provider, providerName: saved.provider, publicKey: pubkey };
    if (provider.on) {
      provider.on('disconnect', onProviderDisconnect);
      provider.on('accountChanged', (newPk) => {
        if (newPk) { connected.publicKey = newPk.toString(); reflectConnectedUI(); }
        else { onProviderDisconnect(); }
      });
    }
    reflectConnectedUI();
  } catch (_) {
    /* not trusted, leave disconnected */
  }
}

function flashWalletError(name, msg) {
  const el = document.querySelector(`[data-wallet-status="${name}"]`);
  if (!el) return;
  const orig = el.textContent;
  el.textContent = msg;
  el.dataset.state = 'err';
  setTimeout(() => { refreshWalletStatuses(); }, 2500);
}

// ─────────────────────────── modal ───────────────────────────
function openModal() {
  const modal = $('#wallet-modal');
  modal.hidden = false;
  refreshWalletStatuses();
  document.addEventListener('keydown', escClose);
}
function closeModal() {
  const modal = $('#wallet-modal');
  modal.hidden = true;
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

$('#wallet-btn').addEventListener('click', () => {
  if (connected) {
    if (confirm(`Disconnect ${connected.providerName} (${shortKey(connected.publicKey)})?`)) {
      disconnectWallet();
    }
    return;
  }
  openModal();
});

$('#wallet-modal-close').addEventListener('click', closeModal);
$('#wallet-modal').addEventListener('click', (e) => {
  if (e.target.id === 'wallet-modal') closeModal();
});

$$('.wallet-option').forEach((btn) => {
  btn.addEventListener('click', () => connectWallet(btn.dataset.wallet));
});

// ─────────────────────────── "use connected" / "add rpc" ───────────────────────────
$('#drip-use-connected').addEventListener('click', () => {
  if (!connected) return;
  $('#drip-wallet').value = connected.publicKey;
});

$('#add-rpc-btn').addEventListener('click', async () => {
  if (!connected) return;
  // No standard exists for "add custom RPC programmatically" across Solana wallets,
  // so we copy the URL and show clear instructions.
  try {
    await navigator.clipboard.writeText(RPC_URL);
    showToast('RPC URL copied. Paste into your wallet\'s custom RPC settings.', 'ok');
  } catch (_) {
    showToast('Could not copy. Manual copy from the field above.', 'err');
  }
});

function showToast(msg, kind) {
  const hint = $('#add-rpc-hint');
  hint.textContent = msg;
  hint.dataset.state = kind || '';
  setTimeout(() => {
    hint.dataset.state = '';
    if (connected) hint.textContent = `connected: ${shortKey(connected.publicKey)} via ${connected.providerName}`;
    else hint.textContent = 'connect a wallet first to use this';
  }, 3500);
}

// ─────────────────────────── drip form ───────────────────────────
const dripForm = $('#drip-form');
const dripWallet = $('#drip-wallet');
const dripAmount = $('#drip-amount');
const dripBtn = $('#drip-submit');
const dripStatus = $('#drip-status');

function setDripBtn(state, label) {
  dripBtn.disabled = state === 'loading';
  if (state === 'idle') dripBtn.innerHTML = '<span class="btn-glyph">&gt;</span> ' + (label || 'drip');
  else if (state === 'loading') dripBtn.innerHTML = '<span class="btn-glyph">⠿</span> ' + (label || 'dripping…');
}
setDripBtn('idle', 'drip');

if (dripForm) {
  dripForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const wallet = dripWallet.value.trim();
    const amount = parseInt(dripAmount.value, 10);

    dripStatus.className = 'drip-status';
    dripStatus.textContent = '';

    if (!wallet) { dripStatus.className = 'drip-status err'; dripStatus.textContent = '× wallet required'; return; }
    if (!amount || amount < 1) { dripStatus.className = 'drip-status err'; dripStatus.textContent = '× amount must be >= 1'; return; }

    setDripBtn('loading', 'dripping…');
    try {
      const res = await fetch(API + '/api/drip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        dripStatus.className = 'drip-status err';
        dripStatus.textContent = '× ' + (data.detail || 'drip failed');
        return;
      }
      dripStatus.className = 'drip-status ok';
      dripStatus.innerHTML = '✓ dripped ' + amount + ' SOL to ' + shortKey(wallet) +
                             '<span class="sig">sig: ' + data.signature + '</span>';
      loadStats();
    } catch (e) {
      dripStatus.className = 'drip-status err';
      dripStatus.textContent = '× network error';
    } finally {
      setDripBtn('idle', 'drip');
    }
  });
}

// ─────────────────────────── boot ───────────────────────────
loadInfo();
loadStats();
setInterval(loadStats, 5000);

// Wallet UI default state.
reflectConnectedUI();

// Wait a tick for injected providers to register, then attempt silent reconnect
// and set the modal status labels.
setTimeout(() => {
  refreshWalletStatuses();
  tryRestoreSession();
}, 350);