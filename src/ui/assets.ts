export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#0A090E">
    <title>Agent Boost setup</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <main class="shell" aria-labelledby="state-title">
      <section class="narrative">
        <header class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <p>Agent Boost</p>
          <span class="network-chip">Sepolia · testnet</span>
        </header>

        <div class="state-copy" aria-live="polite" aria-atomic="true">
          <p class="eyebrow">Dark mode for your agent</p>
          <h1 id="state-title">Creating your wallet</h1>
          <p id="state-description" class="description">Hermes is preparing a private test wallet on this device.</p>
        </div>

        <ol class="progress" aria-label="Setup progress">
          <li data-step="wallet"><span class="step-dot"></span><span>Wallet created</span></li>
          <li data-step="funding"><span class="step-dot"></span><span>Test ETH received</span></li>
          <li data-step="shielding"><span class="step-dot"></span><span>Privacy balance prepared</span></li>
          <li data-step="ready"><span class="step-dot"></span><span>Ready for Hermes</span></li>
        </ol>

        <div id="error-panel" class="error-panel" role="alert" hidden>
          <p class="error-label">Setup needs attention</p>
          <p id="error-message"></p>
          <p id="error-guidance">Return to Hermes and ask it to check Agent Boost.</p>
        </div>

        <p class="return-note" id="return-note">Keep this window open. Setup continues automatically.</p>
      </section>

      <section class="aperture-panel" aria-label="Wallet funding details">
        <div class="aperture" data-progress="0" id="aperture">
          <span class="orbit orbit-one" aria-hidden="true"></span>
          <span class="orbit orbit-two" aria-hidden="true"></span>
          <span class="orbit orbit-three" aria-hidden="true"></span>
          <div class="qr-stage" id="qr-stage" hidden>
            <img id="funding-qr" width="240" height="240" alt="QR code to fund this wallet on Sepolia">
          </div>
          <div class="waiting-mark" id="waiting-mark" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <div class="ready-mark" id="ready-mark" hidden aria-hidden="true">✓</div>
        </div>

        <div class="funding-facts">
          <div class="primary-fact">
            <span class="fact-label" id="funding-label">Send on Sepolia</span>
            <strong id="funding-amount">Waiting for address</strong>
          </div>
          <div class="fact-row">
            <span class="fact-label">Wallet address</span>
            <div class="address-row">
              <code id="wallet-address">—</code>
              <button id="copy-address" type="button" aria-label="Copy wallet address" disabled>
                <span class="copy-default">Copy</span>
                <span class="copy-done" hidden>Copied</span>
              </button>
              <span class="sr-only" id="copy-status" role="status" aria-live="polite"></span>
            </div>
          </div>
          <div class="balance-row">
            <div><span class="fact-label">Received</span><strong id="public-balance">0 ETH</strong></div>
            <div><span class="fact-label">Private</span><strong id="private-balance">0 ETH</strong></div>
          </div>
          <div class="route-row" id="rpc-route" data-status="starting" role="status" aria-live="polite" aria-atomic="true">
            <span class="route-dot" aria-hidden="true"></span>
            <span><span class="fact-label">RPC route</span><strong id="rpc-route-label">Checking Tor…</strong></span>
          </div>
          <p class="testnet-warning"><span aria-hidden="true">◇</span> Sepolia ETH has no monetary value. Do not send mainnet assets.</p>
          <div class="hermes-handoff" id="hermes-handoff" role="status" aria-live="polite" aria-atomic="true">
            <span class="handoff-mark" aria-hidden="true">↗</span>
            <span><span class="fact-label" id="handoff-label">Next in Hermes</span><strong id="handoff-message">After you send, reply ✅ or say “sent”</strong></span>
          </div>
        </div>
      </section>
    </main>
    <p class="connection-status" id="connection-status" role="status">Connected locally</p>
  </body>
</html>`;

export const STYLES_CSS = `
:root {
  color-scheme: dark;
  --soot: #0a090e;
  --carbon: #15131b;
  --carbon-raised: #1c1923;
  --bone: #f1eee8;
  --muted: #9993a3;
  --line: #302b39;
  --ultraviolet: #8268ff;
  --volt: #c9ff57;
  --amber: #ffb84d;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--soot);
  color: var(--bone);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background:
    linear-gradient(rgba(130, 104, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(130, 104, 255, 0.025) 1px, transparent 1px),
    var(--soot);
  background-size: 48px 48px;
}

button, code { font: inherit; }

.shell {
  width: min(1120px, calc(100% - 48px));
  min-height: min(720px, calc(100vh - 96px));
  margin: 48px auto;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(380px, 0.85fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--carbon);
  box-shadow: 0 32px 100px rgba(0, 0, 0, 0.42);
}

.narrative, .aperture-panel { min-width: 0; padding: clamp(32px, 5vw, 68px); }
.narrative { display: flex; flex-direction: column; }
.aperture-panel {
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-left: 1px solid var(--line);
  background: #100e15;
}

.brand { display: flex; align-items: center; gap: 10px; min-height: 28px; }
.brand p { margin: 0; font-weight: 680; letter-spacing: -0.01em; }
.brand-mark { width: 10px; height: 10px; border-radius: 50%; background: var(--ultraviolet); box-shadow: 0 0 22px var(--ultraviolet); }
.network-chip { margin-left: auto; padding: 6px 9px; border: 1px solid rgba(255, 184, 77, 0.34); border-radius: 99px; color: var(--amber); font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.05em; text-transform: uppercase; }

.state-copy { margin: clamp(70px, 12vh, 132px) 0 48px; }
.eyebrow { margin: 0 0 16px; color: var(--ultraviolet); font: 650 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { max-width: 630px; margin: 0; font-family: "Arial Narrow", "Roboto Condensed", ui-sans-serif, sans-serif; font-size: clamp(43px, 6vw, 76px); font-stretch: condensed; font-weight: 760; letter-spacing: -0.055em; line-height: 0.96; text-wrap: balance; }
.description { max-width: 560px; margin: 24px 0 0; color: var(--muted); font-size: 17px; line-height: 1.6; }

.progress { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.progress li { position: relative; display: flex; align-items: center; gap: 16px; min-height: 44px; color: #77717f; font-size: 14px; }
.progress li:not(:last-child)::after { content: ""; position: absolute; z-index: 0; top: 28px; bottom: -16px; left: 6px; width: 1px; background: var(--line); }
.step-dot { z-index: 1; width: 13px; height: 13px; flex: 0 0 auto; border: 2px solid #57505f; border-radius: 50%; background: var(--carbon); }
.progress li[data-status="active"] { color: var(--bone); }
.progress li[data-status="active"] .step-dot { border-color: var(--amber); box-shadow: 0 0 0 5px rgba(255, 184, 77, 0.08); }
.progress li[data-status="done"] { color: #b9b3c0; }
.progress li[data-status="done"] .step-dot { border-color: var(--ultraviolet); background: var(--ultraviolet); }
.progress li[data-status="done"]::after { background: var(--ultraviolet); }
.progress li[data-status="ready"] { color: var(--volt); }
.progress li[data-status="ready"] .step-dot { border-color: var(--volt); background: var(--volt); box-shadow: 0 0 15px rgba(201, 255, 87, 0.38); }

.return-note { margin: auto 0 0; padding-top: 42px; color: var(--muted); font-size: 13px; }
.return-note[data-ready="true"] { color: var(--volt); font-weight: 650; }
.error-panel { margin: 28px 0; padding: 18px; border-left: 3px solid var(--amber); background: rgba(255, 184, 77, 0.07); }
.error-panel p { margin: 4px 0; }
.error-label { color: var(--amber); font: 650 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }

.aperture { --close: 0; position: relative; width: min(100%, 370px); aspect-ratio: 1; margin: 0 auto 42px; display: grid; place-items: center; }
.orbit { position: absolute; border: 1px solid color-mix(in srgb, var(--ultraviolet) calc(45% + var(--close) * 45%), transparent); border-radius: 44% 56% 51% 49% / 54% 45% 55% 46%; transform: rotate(calc(var(--rotation) + var(--close) * 35deg)) scale(calc(1 - var(--close) * var(--shrink))); transition: transform 900ms cubic-bezier(.2,.8,.2,1), border-color 700ms ease; }
.orbit-one { inset: 0; --rotation: 5deg; --shrink: 0.10; }
.orbit-two { inset: 8%; --rotation: 63deg; --shrink: 0.07; }
.orbit-three { inset: 16%; --rotation: 117deg; --shrink: 0.03; }
.aperture[data-progress="1"] { --close: .28; }
.aperture[data-progress="2"] { --close: .55; }
.aperture[data-progress="3"] { --close: .78; }
.aperture[data-progress="4"] { --close: 1; }
.aperture[data-progress="4"] .orbit { border-color: rgba(201, 255, 87, 0.76); }

.qr-stage { position: relative; z-index: 2; width: min(62%, 240px); padding: 12px; border-radius: 18px; background: var(--bone); box-shadow: 0 0 0 1px rgba(241, 238, 232, 0.15), 0 20px 80px rgba(0,0,0,.48); }
.qr-stage img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
.waiting-mark { display: flex; gap: 8px; }
.waiting-mark span { width: 8px; height: 8px; border-radius: 50%; background: var(--ultraviolet); opacity: .32; animation: pulse 1.4s infinite ease-in-out; }
.waiting-mark span:nth-child(2) { animation-delay: .18s; }
.waiting-mark span:nth-child(3) { animation-delay: .36s; }
.ready-mark { z-index: 2; width: 110px; height: 110px; display: grid; place-items: center; border: 1px solid rgba(201,255,87,.65); border-radius: 50%; color: var(--volt); background: rgba(201,255,87,.06); font-size: 46px; box-shadow: 0 0 50px rgba(201,255,87,.12); }

.funding-facts { display: grid; min-width: 0; gap: 24px; }
.funding-facts > * { min-width: 0; }
.primary-fact, .fact-row { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.fact-label { display: block; margin-bottom: 8px; color: var(--muted); font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
.primary-fact strong { color: var(--amber); font: 650 clamp(23px, 4vw, 32px)/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.04em; }
.address-row { display: flex; min-width: 0; align-items: center; gap: 10px; }
.address-row code { min-width: 0; flex: 1 1 0; overflow: hidden; color: var(--bone); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.address-row button { min-width: max-content; flex: 0 0 auto; margin-left: auto; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--bone); background: transparent; cursor: pointer; }
.address-row button:hover:not(:disabled) { border-color: var(--ultraviolet); }
.address-row button:disabled { opacity: .38; cursor: not-allowed; }
button:focus-visible { outline: 3px solid var(--volt); outline-offset: 3px; }
.balance-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.balance-row strong { font: 600 14px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.route-row { display: flex; align-items: center; gap: 10px; color: var(--muted); }
.route-row .fact-label { margin-bottom: 3px; }
.route-row strong { color: var(--bone); font: 600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.route-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--amber); box-shadow: 0 0 14px rgba(255,184,77,.28); }
.route-row[data-status="ready"] .route-dot { background: var(--volt); box-shadow: 0 0 14px rgba(201,255,87,.34); }
.route-row[data-status="failed"] strong, .route-row[data-status="closed"] strong { color: var(--amber); }
.testnet-warning { margin: 0; padding: 12px 14px; border: 1px solid rgba(255,184,77,.2); border-radius: 10px; color: var(--amber); background: rgba(255,184,77,.04); font-size: 12px; line-height: 1.45; }
.hermes-handoff { display: flex; align-items: center; gap: 13px; padding: 15px 16px; border: 1px solid rgba(130,104,255,.32); border-radius: 12px; background: rgba(130,104,255,.07); }
.handoff-mark { width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid rgba(130,104,255,.46); border-radius: 50%; color: var(--ultraviolet); font: 650 16px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.hermes-handoff .fact-label { margin-bottom: 4px; color: #aaa3b5; }
.hermes-handoff strong { color: var(--bone); font-size: 13px; line-height: 1.35; }
.hermes-handoff[data-state="ready"] { border-color: rgba(201,255,87,.3); background: rgba(201,255,87,.055); }
.hermes-handoff[data-state="ready"] .handoff-mark { border-color: rgba(201,255,87,.45); color: var(--volt); }
.hermes-handoff[data-state="error"] { border-color: rgba(255,184,77,.32); background: rgba(255,184,77,.055); }
.hermes-handoff[data-state="error"] .handoff-mark { border-color: rgba(255,184,77,.45); color: var(--amber); }
.connection-status { position: fixed; right: 18px; bottom: 14px; margin: 0; color: #716a78; font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.connection-status[data-offline="true"] { color: var(--amber); }

@keyframes pulse { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-4px); } }

@media (max-height: 820px) and (min-width: 761px) {
  .shell { min-height: calc(100vh - 16px); margin: 8px auto; }
  .narrative, .aperture-panel { padding: 26px 34px; }
  .state-copy { margin: 46px 0 28px; }
  .description { margin-top: 16px; }
  .return-note { padding-top: 20px; }
  .aperture { width: min(100%, 245px); margin-bottom: 8px; }
  .qr-stage { width: min(62%, 172px); padding: 8px; border-radius: 13px; }
  .ready-mark { width: 76px; height: 76px; font-size: 32px; }
  .funding-facts { gap: 10px; }
  .primary-fact, .fact-row { padding-bottom: 8px; }
  .testnet-warning { padding: 7px 9px; font-size: 11px; }
  .hermes-handoff { padding: 9px 11px; }
}

@media (max-width: 760px) {
  .shell { width: min(100% - 24px, 620px); margin: 12px auto 40px; grid-template-columns: minmax(0, 1fr); }
  .narrative { grid-row: 1; padding: 88px 24px 36px; }
  .aperture-panel { grid-row: 2; padding: 28px 24px; border-top: 1px solid var(--line); border-left: 0; }
  body[data-has-address="true"] .aperture-panel { grid-row: 1; border-top: 0; border-bottom: 1px solid var(--line); }
  body[data-has-address="true"] .narrative { grid-row: 2; padding-top: 30px; }
  .brand { position: absolute; top: 30px; left: 36px; right: 36px; z-index: 3; }
  .aperture { width: min(85vw, 330px); margin-top: 44px; margin-bottom: 24px; }
  .state-copy { margin: 12px 0 30px; }
  h1 { font-size: clamp(42px, 13vw, 64px); }
  .return-note { padding-top: 28px; }
  .connection-status { position: static; margin: 0 20px 16px; text-align: center; }
}

@media (max-width: 420px) {
  .shell { width: calc(100% - 16px); }
  .aperture-panel, .narrative { padding-right: 20px; padding-left: 20px; }
  .brand { right: 28px; left: 28px; }
  .network-chip { padding-right: 7px; padding-left: 7px; font-size: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
`;

export const APP_JS = String.raw`
const elements = {
  title: document.querySelector('#state-title'),
  description: document.querySelector('#state-description'),
  aperture: document.querySelector('#aperture'),
  qrStage: document.querySelector('#qr-stage'),
  qr: document.querySelector('#funding-qr'),
  waiting: document.querySelector('#waiting-mark'),
  ready: document.querySelector('#ready-mark'),
  amount: document.querySelector('#funding-amount'),
  fundingLabel: document.querySelector('#funding-label'),
  address: document.querySelector('#wallet-address'),
  copy: document.querySelector('#copy-address'),
  copyStatus: document.querySelector('#copy-status'),
  publicBalance: document.querySelector('#public-balance'),
  privateBalance: document.querySelector('#private-balance'),
  rpcRoute: document.querySelector('#rpc-route'),
  rpcRouteLabel: document.querySelector('#rpc-route-label'),
  handoff: document.querySelector('#hermes-handoff'),
  handoffLabel: document.querySelector('#handoff-label'),
  handoffMessage: document.querySelector('#handoff-message'),
  errorPanel: document.querySelector('#error-panel'),
  errorMessage: document.querySelector('#error-message'),
  returnNote: document.querySelector('#return-note'),
  connection: document.querySelector('#connection-status'),
  steps: Array.from(document.querySelectorAll('[data-step]')),
};

const viewByPhase = {
  not_started: ['Creating your test wallet', 'Hermes is preparing a local Sepolia wallet on this device.', 0, 0],
  creating_wallet: ['Creating your test wallet', 'A new local Sepolia wallet is being prepared for this demo.', 0, 0],
  preparing_privacy: ['Creating your test wallet', 'Agent Boost is finishing the wallet before funding.', 1, 1],
  awaiting_funding: ['Fund your test wallet', 'Scan the QR code or copy the address. Send only Sepolia ETH.', 1, 1],
  funding_pending: ['More funding needed', 'Some Sepolia ETH arrived. Send the remaining amount shown.', 2, 2],
  funded_public: ['Funding found', 'Your test ETH arrived. Agent Boost is preparing the private balance.', 2, 2],
  shielding: ['Preparing your private balance', 'This can take a few minutes. No action is needed.', 3, 3],
  private_ready: ['Ready', 'Your private test balance and Tor-routed Sepolia access are ready.', 4, 4],
  failed: ['Setup needs attention', 'Agent Boost could not finish setup automatically.', 0, 0],
};

function formatEth(wei) {
  try {
    const value = BigInt(wei);
    const whole = value / 1000000000000000000n;
    const fraction = (value % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6);
    return whole.toString() + (fraction ? '.' + fraction : '') + ' ETH';
  } catch {
    return '—';
  }
}

function remainingFunding(snapshot) {
  try {
    const remaining = BigInt(snapshot.requiredFundingWei) - BigInt(snapshot.publicBalanceWei);
    return remaining > 0n ? remaining.toString() : '0';
  } catch {
    return snapshot.requiredFundingWei;
  }
}

function setProgress(phase, fullyReady) {
  if (phase === 'failed') {
    for (const step of elements.steps) {
      delete step.dataset.status;
      step.removeAttribute('aria-current');
      step.setAttribute('aria-label', step.textContent.trim() + ', status unavailable');
    }
    return;
  }
  const statuses = {
    wallet: phase === 'creating_wallet' || phase === 'not_started' ? 'active' : 'done',
    funding: ['awaiting_funding', 'preparing_privacy'].includes(phase) ? 'active' : ['funding_pending', 'funded_public', 'shielding', 'private_ready'].includes(phase) ? 'done' : '',
    shielding: phase === 'shielding' ? 'active' : phase === 'private_ready' ? 'done' : '',
    ready: fullyReady ? 'ready' : phase === 'private_ready' ? 'active' : '',
  };
  for (const step of elements.steps) {
    const status = statuses[step.dataset.step] || '';
    if (status) {
      step.dataset.status = status;
      if (status === 'active') step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    } else {
      delete step.dataset.status;
      step.removeAttribute('aria-current');
    }
    const label = step.textContent.trim();
    const accessibleStatus = status === 'done' || status === 'ready'
      ? 'complete'
      : status === 'active'
        ? 'in progress'
        : 'not started';
    step.setAttribute('aria-label', label + ', ' + accessibleStatus);
  }
}

function render(snapshot) {
  const routeStatus = snapshot.rpcRoute && snapshot.rpcRoute.status
    ? snapshot.rpcRoute.status
    : 'starting';
  const fullyReady = snapshot.phase === 'private_ready' && routeStatus === 'ready';
  const view = snapshot.phase === 'private_ready' && !fullyReady
    ? ['Tor route unavailable', 'Your private test balance is ready, but direct RPC access is disabled. Return to Hermes.', 3, 3]
    : viewByPhase[snapshot.phase] || viewByPhase.failed;
  elements.title.textContent = view[0];
  elements.description.textContent = view[1];
  elements.aperture.dataset.progress = String(view[2]);
  setProgress(snapshot.phase, fullyReady);

  const hasAddress = typeof snapshot.address === 'string' && snapshot.address.length > 0;
  document.body.dataset.hasAddress = String(hasAddress);
  elements.address.textContent = hasAddress ? snapshot.address : '—';
  elements.address.title = hasAddress ? snapshot.address : '';
  elements.copy.disabled = !hasAddress;
  const stillFunding = ['awaiting_funding', 'funding_pending'].includes(snapshot.phase);
  elements.fundingLabel.textContent = snapshot.phase === 'awaiting_funding'
    ? 'Send on Sepolia'
    : snapshot.phase === 'funding_pending'
      ? 'Still needed on Sepolia'
      : snapshot.phase === 'private_ready'
        ? 'Setup status'
        : 'Funding status';
  elements.amount.textContent = !hasAddress
    ? 'Waiting for address'
    : stillFunding
      ? formatEth(remainingFunding(snapshot)) + ' needed'
      : 'Funding complete';
  elements.publicBalance.textContent = formatEth(snapshot.publicBalanceWei);
  elements.privateBalance.textContent = formatEth(snapshot.privateBalanceWei);

  elements.rpcRoute.dataset.status = routeStatus;
  elements.rpcRouteLabel.textContent = routeStatus === 'ready'
    ? 'Tor ready'
    : routeStatus === 'failed' || routeStatus === 'closed'
      ? 'Tor unavailable — direct access disabled'
      : 'Checking Tor…';

  const handoff = snapshot.phase === 'private_ready'
    ? ['ready', 'Setup complete', 'Return to Hermes — Agent Boost is ready']
    : snapshot.phase === 'failed'
      ? ['error', 'Next in Hermes', 'Ask Hermes to check Agent Boost']
      : ['funded_public', 'shielding'].includes(snapshot.phase)
        ? ['working', 'In progress', 'Hermes is preparing your private balance']
        : ['awaiting_funding', 'funding_pending'].includes(snapshot.phase)
          ? ['funding', 'Next in Hermes', 'After you send, reply ✅ or say “sent”']
          : ['working', 'In progress', 'Hermes is creating your test wallet'];
  elements.handoff.dataset.state = handoff[0];
  elements.handoffLabel.textContent = handoff[1];
  elements.handoffMessage.textContent = handoff[2];

  const showReady = fullyReady;
  const showQr = hasAddress && typeof snapshot.qrDataUrl === 'string' && !showReady;
  elements.qrStage.hidden = !showQr;
  elements.qr.hidden = !showQr;
  if (showQr && elements.qr.src !== snapshot.qrDataUrl) elements.qr.src = snapshot.qrDataUrl;
  if (showQr) elements.qr.alt = 'QR code to send ' + formatEth(remainingFunding(snapshot)) + ' to this setup wallet on Sepolia';
  elements.waiting.hidden = showQr || showReady;
  elements.ready.hidden = !showReady;

  const failed = snapshot.phase === 'failed';
  elements.errorPanel.hidden = !failed;
  elements.errorMessage.textContent = failed && snapshot.error && snapshot.error.message
    ? snapshot.error.message
    : 'Return to Hermes and ask it to check Agent Boost.';

  elements.returnNote.dataset.ready = String(showReady);
  elements.returnNote.textContent = showReady
    ? 'Setup complete. You can close this window and return to Hermes.'
    : snapshot.phase === 'private_ready'
      ? 'Setup is paused. Return to Hermes and check the Tor RPC route.'
      : ['awaiting_funding', 'funding_pending'].includes(snapshot.phase)
        ? 'After sending, return to Hermes and reply ✅ or say “sent.” This window updates automatically.'
        : 'Keep this window open. Setup continues automatically.';
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('state unavailable');
    render(await response.json());
    elements.connection.textContent = 'Connected locally';
    delete elements.connection.dataset.offline;
  } catch {
    elements.connection.textContent = 'Reconnecting locally…';
    elements.connection.dataset.offline = 'true';
  }
}

elements.copy.addEventListener('click', async () => {
  if (elements.copy.disabled) return;
  try {
    await navigator.clipboard.writeText(elements.address.textContent);
    elements.copyStatus.textContent = 'Wallet address copied.';
    elements.copy.querySelector('.copy-default').hidden = true;
    elements.copy.querySelector('.copy-done').hidden = false;
    window.setTimeout(() => {
      elements.copy.querySelector('.copy-default').hidden = false;
      elements.copy.querySelector('.copy-done').hidden = true;
      elements.copyStatus.textContent = '';
    }, 1600);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(elements.address);
    selection.removeAllRanges();
    selection.addRange(range);
    elements.copyStatus.textContent = 'Wallet address selected. Copy it manually.';
  }
});

void refresh();
window.setInterval(refresh, 1500);
`;
