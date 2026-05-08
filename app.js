/* OOZE LABS — frontend logic */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- API base ----------
// Same-origin: requests go to /api/* on whatever host serves the page.
const API = '';

// ---------- formatters ----------

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

// ---------- copy buttons ----------

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
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 1400);
    } catch (e) {
      btn.textContent = 'err';
      setTimeout(() => { btn.textContent = 'copy'; }, 1400);
    }
  });
});

// ---------- info bootstrap ----------

async function loadInfo() {
  try {
    const res = await fetch(API + '/api/info');
    const data = await res.json();
    if (data.rpcUrl) {
      $('#rpc-url').textContent = data.rpcUrl;
      $('#cli-url').textContent = data.rpcUrl;
      $$('.rpc-inline').forEach((el) => el.textContent = data.rpcUrl);
    }
    if (data.faucetPubkey) {
      $('#faucet-pubkey-foot').textContent = shortKey(data.faucetPubkey);
    }
    if (data.dripCapSol) {
      const amtInput = $('#drip-amount');
      if (amtInput) amtInput.max = data.dripCapSol;
    }
  } catch (e) {
    /* non-fatal */
  }
}

// ---------- stats poll ----------

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

// ---------- drip form ----------

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

    if (!wallet) {
      dripStatus.className = 'drip-status err';
      dripStatus.textContent = '× wallet required';
      return;
    }
    if (!amount || amount < 1) {
      dripStatus.className = 'drip-status err';
      dripStatus.textContent = '× amount must be >= 1';
      return;
    }

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
      // refresh stats so faucet balance updates visibly
      loadStats();
    } catch (e) {
      dripStatus.className = 'drip-status err';
      dripStatus.textContent = '× network error';
    } finally {
      setDripBtn('idle', 'drip');
    }
  });
}

// ---------- boot ----------

loadInfo();
loadStats();
setInterval(loadStats, 5000);
