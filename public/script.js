/*
 * Front‑end logic for Caspar Autosync.  This script runs in the browser and
 * synchronises the UI with the server via REST calls and a WebSocket.  It
 * populates configuration inputs, handles button actions, and updates status
 * displays in real time.  Extensive comments are provided to aid
 * understanding for non‑developers.
 */

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => console.error(err));
});

/**
 * Initialise the UI: load configuration from the server, render slot
 * editors, attach event handlers, and open a WebSocket for live status.
 */
async function init() {
  await loadConfig();
  attachGlobalHandlers();
  await refreshStatus();
  setupWebSocket();
}

/**
 * Fetch the current configuration from the server and populate all input
 * controls accordingly.  Builds the slots table dynamically.
 */
async function loadConfig() {
  const cfg = await fetch('/api/config').then(res => res.json());
  // Populate global inputs
  document.getElementById('fps').value = cfg.fps;
  document.getElementById('frames').value = cfg.frames;
  document.getElementById('interval').value = cfg.autosyncIntervalSec;
  document.getElementById('tolerance').value = cfg.driftToleranceFrames;
  document.getElementById('resyncMode').value = cfg.resyncMode;
  document.getElementById('fadeFrames').value = cfg.fadeFrames;
  // Build slot rows
  const tbody = document.getElementById('slot-table-body');
  tbody.innerHTML = '';
  cfg.slots.forEach((slot, idx) => {
    // For each configured slot, create a table row with an enabled checkbox
    // and inputs for all editable properties.  Missing values fall back to
    // sensible defaults (host = 127.0.0.1, baseLayer = 10, etc.).  The
    // enabled checkbox defaults to true unless explicitly set to false.
    const tr = document.createElement('tr');
    const enabled = (slot.enabled !== false);
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><input type="checkbox" id="slot-enabled-${idx}" ${enabled ? 'checked' : ''}></td>
      <td><input type="text" id="slot-name-${idx}" value="${slot.name || ''}" placeholder="Slot ${idx + 1}"></td>
      <td><input type="text" id="slot-host-${idx}" value="${slot.host || '127.0.0.1'}" placeholder="127.0.0.1"></td>
      <td><input type="number" id="slot-port-${idx}" value="${slot.port || 5250}" min="1"></td>
      <td><input type="number" id="slot-channel-${idx}" value="${slot.channel || 1}" min="1"></td>
      <td><input type="number" id="slot-base-${idx}" value="${slot.baseLayer || 10}" min="1"></td>
      <td><input type="text" id="slot-clip-${idx}" value="${slot.clip || ''}" placeholder="file.mov"></td>
      <td><input type="text" id="slot-tc-${idx}" value="${slot.timecode || '00:00:00:00'}" pattern="\\d{2}:\\d{2}:\\d{2}:\\d{2}"></td>
    `;
    tbody.appendChild(tr);
  });

  // Always render an extra empty row at the bottom so the user can add
  // additional slots on demand.  This row defaults to disabled and blank
  // fields (with sensible defaults where appropriate).  When the user
  // populates this row and saves, it will persist and a new empty row
  // will appear on the next reload.
  const blankIdx = cfg.slots.length;
  const trBlank = document.createElement('tr');
  trBlank.innerHTML = `
    <td>${blankIdx + 1}</td>
    <td><input type="checkbox" id="slot-enabled-${blankIdx}"></td>
    <td><input type="text" id="slot-name-${blankIdx}" value="" placeholder="Slot ${blankIdx + 1}"></td>
    <td><input type="text" id="slot-host-${blankIdx}" value="127.0.0.1" placeholder="127.0.0.1"></td>
    <td><input type="number" id="slot-port-${blankIdx}" value="5250" min="1"></td>
    <td><input type="number" id="slot-channel-${blankIdx}" value="1" min="1"></td>
    <td><input type="number" id="slot-base-${blankIdx}" value="10" min="1"></td>
    <td><input type="text" id="slot-clip-${blankIdx}" value="" placeholder="file.mov"></td>
    <td><input type="text" id="slot-tc-${blankIdx}" value="00:00:00:00" pattern="\\d{2}:\\d{2}:\\d{2}:\\d{2}"></td>
  `;
  tbody.appendChild(trBlank);
  // Highlight the current sync mode button
  setActiveMode(cfg.mode || 'off');
  // Select resync mode in the dropdown
  document.getElementById('resyncMode').value = cfg.resyncMode;
  document.getElementById('fadeFrames').value = cfg.fadeFrames;
}

/**
 * Attach click listeners to all buttons and input elements.  Delegates
 * actions to helper functions which talk to the server.
 */
function attachGlobalHandlers() {
  document.getElementById('save').addEventListener('click', onSave);
  document.getElementById('preload').addEventListener('click', () => post('/api/preload'));
  document.getElementById('start').addEventListener('click', () => post('/api/start'));
  document.getElementById('pause').addEventListener('click', () => post('/api/pause'));
  document.getElementById('resync').addEventListener('click', () => post('/api/resync', { mode: document.getElementById('resyncMode').value }));
  document.getElementById('reset').addEventListener('click', () => post('/api/reset-clock'));
  // Mode toggles
  document.getElementById('mode-off').addEventListener('click', () => setMode('off'));
  document.getElementById('mode-manual').addEventListener('click', () => setMode('manual'));
  document.getElementById('mode-auto').addEventListener('click', () => setMode('auto'));
}

/**
 * Helper to POST JSON to a given endpoint.  Returns the parsed JSON
 * response.  Errors are printed to the console.
 *
 * @param {string} url API endpoint to call.
 * @param {Object} [body] Optional JSON body.
 */
async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}'
    });
    return await res.json();
  } catch (err) {
    console.error(err);
  }
}

/**
 * Send the current mode to the server and update the UI to reflect the new
 * state.  Modes are 'off', 'manual', or 'auto'.
 *
 * @param {string} mode The desired autosync mode.
 */
async function setMode(mode) {
  const res = await post('/api/mode', { mode });
  if (res && res.ok) setActiveMode(res.mode);
}

/**
 * Highlight the button corresponding to the current mode by adding an
 * 'active' class and removing it from the others.  This purely affects
 * presentation; the actual mode value lives on the server.
 *
 * @param {string} mode The current mode reported by the server.
 */
function setActiveMode(mode) {
  ['off','manual','auto'].forEach(m => {
    const btn = document.getElementById(`mode-${m}`);
    if (!btn) return;
    if (m === mode) btn.classList.add('active'); else btn.classList.remove('active');
  });
}

/**
 * Gather values from all inputs and send them to the server to persist.  This
 * function constructs a payload containing global settings and all slots.
 */
async function onSave() {
  const cfg = {};
  cfg.fps = parseFloat(document.getElementById('fps').value) || 50;
  cfg.frames = parseInt(document.getElementById('frames').value, 10) || 30000;
  cfg.autosyncIntervalSec = parseInt(document.getElementById('interval').value, 10) || 10;
  cfg.driftToleranceFrames = parseInt(document.getElementById('tolerance').value, 10) || 1;
  cfg.resyncMode = document.getElementById('resyncMode').value || 'cut';
  cfg.fadeFrames = parseInt(document.getElementById('fadeFrames').value, 10) || 2;
  // Gather slot fields from all rows currently rendered.  The table body
  // always contains one extra blank row at the end.  We iterate through
  // each row and extract input values.  Slots that are completely
  // unconfigured (blank) and disabled are dropped.  Slots with at least
  // one non‑default field or with the enabled checkbox ticked will be
  // persisted.  Defaults are applied for host and baseLayer when fields
  // are empty.
  cfg.slots = [];
  const tbody = document.getElementById('slot-table-body');
  const rowCount = tbody.rows.length;
  for (let i = 0; i < rowCount; i++) {
    const enabledEl = document.getElementById(`slot-enabled-${i}`);
    const nameEl    = document.getElementById(`slot-name-${i}`);
    const hostEl    = document.getElementById(`slot-host-${i}`);
    const portEl    = document.getElementById(`slot-port-${i}`);
    const channelEl = document.getElementById(`slot-channel-${i}`);
    const baseEl    = document.getElementById(`slot-base-${i}`);
    const clipEl    = document.getElementById(`slot-clip-${i}`);
    const tcEl      = document.getElementById(`slot-tc-${i}`);
    if (!nameEl || !hostEl || !portEl || !channelEl || !baseEl || !clipEl || !tcEl || !enabledEl) {
      continue;
    }
    const enabled = enabledEl.checked;
    const name    = nameEl.value.trim();
    let host      = hostEl.value.trim();
    const port    = parseInt(portEl.value, 10) || 5250;
    const channel = parseInt(channelEl.value, 10) || 1;
    const base    = parseInt(baseEl.value, 10) || 10;
    const clip    = clipEl.value.trim();
    let tc        = tcEl.value.trim();
    // Normalise timecode; if invalid, default to 00:00:00:00
    if (!/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(tc)) tc = '00:00:00:00';
    // Apply default for host if empty
    if (!host) host = '127.0.0.1';
    // Determine whether this row is effectively blank.  If the user has
    // unticked the enabled checkbox and left all other fields at their
    // defaults, then this slot is ignored.
    const isBlank = !enabled &&
                    name === '' &&
                    (host === '127.0.0.1' || host === '') &&
                    clip === '' &&
                    tc === '00:00:00:00' &&
                    port === 5250 &&
                    channel === 1 &&
                    base === 10;
    if (isBlank) continue;
    cfg.slots.push({ name, host, port, channel, baseLayer: base, clip, timecode: tc, enabled });
  }
  const res = await post('/api/config', cfg);
  if (res && res.ok) {
    // Apply returned config to inputs to reflect any normalisation
    await loadConfig();
  }
}

/**
 * Fetch the latest status once.  Useful when the page first loads to
 * populate the status table before the WebSocket delivers updates.
 */
async function refreshStatus() {
  try {
    const status = await fetch('/api/status').then(r => r.json());
    updateStatus(status);
  } catch (err) {
    console.error(err);
  }
}

/**
 * Open a WebSocket to receive live status updates from the server.  The
 * connection will automatically reconnect if the server restarts or the
 * connection is lost.
 */
function setupWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
        updateStatus(msg.payload);
      }
    } catch {}
  };
  ws.onclose = () => {
    // Try to reconnect after a short delay
    setTimeout(setupWebSocket, 3000);
  };
}

/**
 * Update the status table and meta information based on the latest server
 * snapshot.  Applies colour coding for drift and highlights the active
 * autosync mode.
 *
 * @param {Object} status The payload returned by /api/status or via WebSocket.
 */
function updateStatus(status) {
  if (!status) return;
  // Update mode highlight
  setActiveMode(status.mode);
  // Update meta info: display key parameters
  const meta = document.getElementById('meta');
  const t0Text = status.t0 ? new Date(status.t0).toLocaleTimeString() : 'Not started';
  meta.innerHTML = '';
  const items = [
    `Mode: ${status.mode.toUpperCase()}`,
    `Resync: ${status.resyncMode.toUpperCase()}`,
    `Fade Frames: ${status.fadeFrames}`,
    `FPS: ${status.fps}`,
    `Loop Frames: ${status.frames}`,
    `Interval: ${status.autosyncIntervalSec}s`,
    `Tolerance: ±${status.driftToleranceFrames}f`,
    `t0: ${t0Text}`
  ];
  items.forEach(text => {
    const span = document.createElement('span');
    span.textContent = text;
    meta.appendChild(span);
  });
  // Build status rows
  const tbody = document.getElementById('status-table-body');
  tbody.innerHTML = '';
  const tol = status.driftToleranceFrames;
  status.rows.forEach(row => {
    const tr = document.createElement('tr');
    const drift = row.drift;
    const driftClass = (drift == null) ? '' : (Math.abs(drift) > tol ? 'bad' : 'ok');
    tr.innerHTML = `
      <td>${row.index + 1}</td>
      <td>${row.name || ''}</td>
      <td>${row.host}</td>
      <td>${row.channel}</td>
      <td>${row.activeLayer}</td>
      <td>${row.standbyLayer}</td>
      <td>${row.clip}</td>
      <td>${row.timecode}</td>
      <td>${row.currentFrame != null ? row.currentFrame : '-'}</td>
      <td>${row.targetFrame}</td>
      <td class="${driftClass}">${drift != null ? drift : '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}