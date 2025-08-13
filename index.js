/**
 * Main entry point for the Caspar Autosync server.
 *
 * This file implements a Node.js service that acts as a central controller
 * for synchronising multiple CasparCG servers.  It loads a configuration
 * describing up to twenty playback slots, connects to each specified host,
 * and exposes a simple REST API plus a WebSocket for status updates.
 *
 * Key responsibilities:
 *  - Loading and persisting configuration (config.json)
 *  - Managing AMCP connections to each remote CasparCG server
 *  - Computing target frames based on a common start time (`t0`)
 *  - Performing preload, start, pause and resync operations on all active slots
 *  - Tracking per‑slot active/standby layers for seamless resyncs
 *  - Periodically checking for drift and initiating automatic resyncs when needed
 *  - Serving a static dark‑themed web UI from the `public/` folder
 */

import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { CasparCG } from 'casparcg-connection';

// -----------------------------------------------------------------------------
// Configuration and state
//
// The configuration file holds all user‑definable settings, including global
// parameters (fps, autosync interval, drift tolerance, resync mode, etc.) and
// per‑slot definitions.  Each slot describes a remote CasparCG server and the
// media file to play.

const CONFIG_FILE = path.resolve('config.json');
const SAMPLE_FILE = path.resolve('config.sample.json');

/**
 * Load the current configuration from disk.  If `config.json` does not exist
 * the sample configuration is used instead.  Any missing top‑level fields or
 * slot properties are filled in from the sample to ensure a complete object.
 *
 * @returns {Promise<Object>} A promise resolving to the configuration object.
 */
async function loadConfig() {
  let base;
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    base = JSON.parse(data);
  } catch {
    // Fall back to sample if no custom config exists
    const sampleData = await fs.readFile(SAMPLE_FILE, 'utf8');
    base = JSON.parse(sampleData);
  }
  // Fill in defaults from sample for any missing keys
  const sample = JSON.parse(await fs.readFile(SAMPLE_FILE, 'utf8'));
  // Merge top‑level keys
  const merged = { ...sample, ...base };
  // Ensure slots array has the correct length
  merged.slots = merged.slots || sample.slots;
  // Deep merge each slot with sample slot to fill missing props
  merged.slots = merged.slots.map((s, idx) => {
    const def = sample.slots[idx] || {};
    return { ...def, ...s };
  });
  return merged;
}

/**
 * Persist the configuration to disk.  This is called whenever the client
 * updates settings via the API.  The file will be formatted with two‑space
 * indentation for readability.
 *
 * @param {Object} cfg The configuration object to save.
 */
async function saveConfig(cfg) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// The in‑memory configuration.  Populated at startup and mutated when
// receiving updates via the API.  Use `loadConfig()` and `saveConfig()` to
// persist changes.
let config = await loadConfig();

// -----------------------------------------------------------------------------
// AMCP connections and per‑slot state
//
// Each unique host/port combination is mapped to a `CasparCG` connection.  If
// multiple slots reference the same host we reuse the same connection object.
const connections = new Map(); // key: `${host}:${port}` -> CasparCG instance

/**
 * Ensure a connection exists for the given host/port pair.  If a connection
 * already exists it is returned; otherwise a new one is created and stored.
 *
 * @param {string} host The hostname or IP address of the CasparCG server.
 * @param {number} port The AMCP control port (default 5250).
 * @returns {CasparCG} A connected CasparCG instance.
 */
function getConnection(host, port) {
  const key = `${host}:${port}`;
  if (connections.has(key)) return connections.get(key);
  const conn = new CasparCG({
    host,
    port,
    autoConnect: true,
    autoReconnect: true,
    queueMode: 'sequential'
  });
  connections.set(key, conn);
  return conn;
}

// Each slot maintains a pair of layers: `active` and `standby`.  When the
// application starts, the active layer equals `baseLayer` from config and
// standby is `baseLayer + 10`.  During resync operations the roles swap.
const pairState = new Map(); // key: slot index -> { active: number, standby: number }

/**
 * Retrieve or initialise the pairState for a given slot.  If the slot does
 * not yet exist in the map, it is initialised with `active = baseLayer` and
 * `standby = baseLayer + 10`.  Calling this after updating `baseLayer` in
 * config ensures the pair layers remain aligned with the latest settings.
 *
 * @param {number} idx The index of the slot in `config.slots`.
 * @returns {{ active: number, standby: number }} The current pair for the slot.
 */
function getPair(idx) {
  const slot = config.slots[idx];
  let pair = pairState.get(idx);
  if (!pair || pair.baseLayer !== slot.baseLayer) {
    pair = { active: slot.baseLayer, standby: slot.baseLayer + 10, baseLayer: slot.baseLayer };
    pairState.set(idx, pair);
  }
  return pair;
}

// -----------------------------------------------------------------------------
// Timecode utilities
//
// Functions to convert between human‑readable timecodes (HH:MM:SS:FF) and
// frame numbers.  CasparCG uses integer frame indices starting at 0.

/**
 * Convert a timecode string to an absolute frame number, given a frame rate.
 * If the string is malformed it returns zero.  The frames component (FF)
 * should be less than the fps value; any overflow wraps into the next second.
 *
 * @param {string} tc Timecode in the format `HH:MM:SS:FF`.
 * @param {number} fps Frames per second.
 * @returns {number} Total frames from start of file.
 */
function timecodeToFrames(tc, fps) {
  if (!tc || typeof tc !== 'string') return 0;
  const parts = tc.trim().split(':');
  if (parts.length !== 4) return 0;
  const [hh, mm, ss, ff] = parts.map(v => parseInt(v, 10));
  if ([hh, mm, ss, ff].some(n => Number.isNaN(n))) return 0;
  const totalSeconds = hh * 3600 + mm * 60 + ss;
  const frame = Math.floor(totalSeconds * fps + ff);
  return frame;
}

/**
 * Compute the target frame relative to the global start time (`t0`).  This
 * function calculates how many frames have elapsed since `t0` at the current
 * frame rate and wraps the result by `config.frames` to avoid overflow.  It
 * returns an integer frame index.  If `t0` has not been set (no start
 * triggered yet) it returns zero.
 *
 * @returns {number} The expected frame number at the current time.
 */
function targetFrame() {
  if (!t0) return 0;
  const elapsedSec = (Date.now() - t0) / 1000;
  const frame = Math.floor((elapsedSec * config.fps) % config.frames);
  return frame;
}

// Global state for playback and autosync
let t0 = null;               // Timestamp (ms) when `startAll` was last called
let autosyncMode = 'off';    // 'off' | 'manual' | 'auto'
let autosyncTimer = null;    // Interval timer handle for automatic resync

// -----------------------------------------------------------------------------
// Caspar command helpers
//
// To keep the business logic readable, helper functions wrap common AMCP
// patterns (e.g. `DEFER`, `RESUME`, load/seek/play, fade/cut transitions).

/**
 * Send a DEFER command on a connection.  DEFER collects subsequent commands
 * until a matching RESUME is issued, batching them into a single render cycle.
 *
 * @param {CasparCG} conn The connection.
 * @returns {Promise<unknown>} Resolves when the command is acknowledged.
 */
function defer(conn) { return conn.do('DEFER'); }

/**
 * Send a RESUME command on a connection.  RESUME executes all deferred
 * commands.  It must be called after one or more DEFER calls.
 *
 * @param {CasparCG} conn The connection.
 * @returns {Promise<unknown>} Resolves when the command is acknowledged.
 */
function resume(conn) { return conn.do('RESUME'); }

/**
 * Issue a `LOADBG` followed by `PAUSE` on the given layer.  This preloads a
 * clip into memory and parks it on the specified frame without showing it.
 *
 * @param {CasparCG} conn The connection to use.
 * @param {number} ch The channel number on the remote CasparCG server.
 * @param {number} layer The layer number (active or standby).
 * @param {string} clip The file name (including extension) to load.
 * @param {number} frame The frame to seek to before pausing.
 */
async function loadAndPause(conn, ch, layer, clip, frame) {
  await defer(conn);
  await conn.do(`LOADBG ${ch}-${layer} "${clip}" SEEK ${frame} LOOP`);
  await conn.do(`PAUSE ${ch}-${layer}`);
  await conn.do(`MIXER ${ch}-${layer} OPACITY 0 0`);
  await conn.do(`MIXER ${ch}-${layer} VOLUME 0.0 0`);
  await resume(conn);
}

/**
 * Perform a seamless cut transition from the active layer to the standby layer.
 * The standby layer must already be loaded on the correct frame.  This
 * function makes the standby layer visible and the active layer invisible in
 * the same render cycle, then pauses the old layer.  After the cut the
 * returned pair reflects the new active/standby assignments.
 *
 * @param {CasparCG} conn The CasparCG connection.
 * @param {number} ch The channel.
 * @param {{active:number, standby:number}} pair The current pair.
 * @returns {{active:number, standby:number}} The updated pair after swap.
 */
async function cutTransition(conn, ch, pair) {
  await defer(conn);
  // Start the standby layer and immediately make it visible
  await conn.do(`PLAY ${ch}-${pair.standby}`);
  await conn.do(`MIXER ${ch}-${pair.standby} OPACITY 1 0`);
  await conn.do(`MIXER ${ch}-${pair.standby} VOLUME 1.0 0`);
  // Hide and mute the active layer
  await conn.do(`MIXER ${ch}-${pair.active} OPACITY 0 0`);
  await conn.do(`MIXER ${ch}-${pair.active} VOLUME 0.0 0`);
  await resume(conn);
  // Pause the old layer to stop decoding
  await defer(conn);
  await conn.do(`PAUSE ${ch}-${pair.active}`);
  await resume(conn);
  // Swap roles
  return { active: pair.standby, standby: pair.active, baseLayer: pair.baseLayer };
}

/**
 * Perform a cross‑fade transition from the active layer to the standby layer.
 * Both layers will play simultaneously while their opacities cross over
 * linearly over `fadeFrames` frames.  After the fade, the old layer is
 * paused.  Returns the updated pair after swap.
 *
 * @param {CasparCG} conn The CasparCG connection.
 * @param {number} ch The channel.
 * @param {{active:number, standby:number}} pair The current pair.
 * @param {number} fadeFrames Duration of the fade, in frames.
 * @returns {{active:number, standby:number}} The updated pair.
 */
async function fadeTransition(conn, ch, pair, fadeFrames) {
  await defer(conn);
  await conn.do(`PLAY ${ch}-${pair.standby}`);
  // Fade in standby and fade out active over fadeFrames frames
  await conn.do(`MIXER ${ch}-${pair.standby} OPACITY 1 ${fadeFrames} LINEAR`);
  await conn.do(`MIXER ${ch}-${pair.standby} VOLUME 1.0 ${fadeFrames} LINEAR`);
  await conn.do(`MIXER ${ch}-${pair.active} OPACITY 0 ${fadeFrames} LINEAR`);
  await conn.do(`MIXER ${ch}-${pair.active} VOLUME 0.0 ${fadeFrames} LINEAR`);
  await resume(conn);
  // Allow the fade to finish before pausing the old layer
  await defer(conn);
  await conn.do(`PAUSE ${ch}-${pair.active}`);
  await resume(conn);
  return { active: pair.standby, standby: pair.active, baseLayer: pair.baseLayer };
}

/**
 * Query the current frame of a given playing layer.  If the layer is not
 * currently playing the command may fail; in that case it returns null.
 *
 * @param {CasparCG} conn The connection.
 * @param {number} ch Channel number.
 * @param {number} layer Layer number.
 * @returns {Promise<number|null>} The current frame index or null on failure.
 */
async function getCurrentFrame(conn, ch, layer) {
  try {
    const res = await conn.do(`CALL ${ch}-${layer} FRAME`);
    const line = String(res).trim();
    const val = parseInt(line, 10);
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Core operations: preload, start, pause, resync

/**
 * Preload all active slots.  For every slot with both `host` and `clip` set,
 * this function loads both the active and standby layers with the selected
 * clip, seeks to frame 0, pauses, hides, and mutes them.  Preloading warms
 * up the file caches on each server so that the initial start is glitch‑free.
 */
async function preloadAll() {
  // Group commands per host to minimise network latency.  For each host we
  // issue a DEFER/RESUME around multiple LOADBG/PAUSE commands.
  const grouped = new Map(); // hostPort -> array of commands
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    // Skip disabled slots entirely.  A slot is considered disabled when the
    // user clears the enabled checkbox in the UI or when `enabled === false`
    // is present in the configuration.  Blank host or missing clip also
    // indicates a slot should be skipped.
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue; // skip if host or clip missing
    const { host, port, channel, clip } = slot;
    const pair = getPair(i);
    const key = `${host}:${port}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ slotIndex: i, channel, clip, pair });
  }
  for (const [key, items] of grouped.entries()) {
    const [host, portStr] = key.split(':');
    const port = parseInt(portStr, 10);
    const conn = getConnection(host, port);
    await defer(conn);
    for (const item of items) {
      const { channel, clip, pair } = item;
      // Preload active layer at frame 0
      await conn.do(`LOADBG ${channel}-${pair.active} "${clip}" SEEK 0 LOOP`);
      await conn.do(`PAUSE ${channel}-${pair.active}`);
      await conn.do(`MIXER ${channel}-${pair.active} OPACITY 0 0`);
      await conn.do(`MIXER ${channel}-${pair.active} VOLUME 1.0 0`);
      // Preload standby layer at frame 0
      await conn.do(`LOADBG ${channel}-${pair.standby} "${clip}" SEEK 0 LOOP`);
      await conn.do(`PAUSE ${channel}-${pair.standby}`);
      await conn.do(`MIXER ${channel}-${pair.standby} OPACITY 0 0`);
      await conn.do(`MIXER ${channel}-${pair.standby} VOLUME 0.0 0`);
    }
    await resume(conn);
  }
}

/**
 * Start playback on all active slots.  This function calculates the start
 * frame for each slot based on its configured timecode and the global fps,
 * loads both layers on that frame, pauses them, then starts the active layer
 * and makes it visible.  It also records the current time as `t0`.
 */
async function startAll() {
  t0 = Date.now();
  // Reset pair layers to ensure active/standby align with baseLayer for each slot
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    pairState.set(i, { active: slot.baseLayer, standby: slot.baseLayer + 10, baseLayer: slot.baseLayer });
  }
  const grouped = new Map();
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue;
    const { host, port, channel, clip, timecode } = slot;
    const pair = getPair(i);
    const startFrame = timecodeToFrames(timecode, config.fps);
    const key = `${host}:${port}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ channel, clip, pair, startFrame });
  }
  for (const [key, items] of grouped.entries()) {
    const [host, portStr] = key.split(':');
    const port = parseInt(portStr, 10);
    const conn = getConnection(host, port);
    await defer(conn);
    for (const item of items) {
      const { channel, clip, pair, startFrame } = item;
      // Load active layer at timecode and park it
      await conn.do(`LOADBG ${channel}-${pair.active} "${clip}" SEEK ${startFrame} LOOP`);
      await conn.do(`PAUSE ${channel}-${pair.active}`);
      // Load standby layer at timecode and park it
      await conn.do(`LOADBG ${channel}-${pair.standby} "${clip}" SEEK ${startFrame} LOOP`);
      await conn.do(`PAUSE ${channel}-${pair.standby}`);
      // Reset visibility and volume
      await conn.do(`MIXER ${channel}-${pair.active} OPACITY 0 0`);
      await conn.do(`MIXER ${channel}-${pair.standby} OPACITY 0 0`);
      await conn.do(`MIXER ${channel}-${pair.active} VOLUME 1.0 0`);
      await conn.do(`MIXER ${channel}-${pair.standby} VOLUME 0.0 0`);
      // Now start the active layer and make it visible
      await conn.do(`PLAY ${channel}-${pair.active}`);
      await conn.do(`MIXER ${channel}-${pair.active} OPACITY 1 0`);
    }
    await resume(conn);
  }
}

/**
 * Pause playback on all active and standby layers.  This stops decoding on
 * both layers but does not reset timecodes.  After pausing you can call
 * `startAll()` again to rearm the start time.
 */
async function pauseAll() {
  const grouped = new Map();
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue;
    const { host, port, channel } = slot;
    const pair = getPair(i);
    const key = `${host}:${port}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ channel, pair });
  }
  for (const [key, items] of grouped.entries()) {
    const [host, portStr] = key.split(':');
    const port = parseInt(portStr, 10);
    const conn = getConnection(host, port);
    await defer(conn);
    for (const item of items) {
      const { channel, pair } = item;
      await conn.do(`PAUSE ${channel}-${pair.active}`);
      await conn.do(`PAUSE ${channel}-${pair.standby}`);
    }
    await resume(conn);
  }
}

/**
 * Perform a resync across all active slots.  The target frame is either
 * computed based on `t0` or passed explicitly when called by the autosync
 * loop.  Standby layers are prepared on that frame and then swapped in via
 * cut or fade transitions.  After the swap the pair roles are swapped.
 *
 * @param {string} mode Either `"cut"` or `"fade"`.  Uses `config.resyncMode` if omitted.
 * @param {number} [tf] The target frame.  If not provided, it will call `targetFrame()`.
 */
async function resyncAll(mode = config.resyncMode, tf = targetFrame()) {
  // Prepare standby layers on the correct frame first
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue;
    const { host, port, channel, clip } = slot;
    const conn = getConnection(host, port);
    const pair = getPair(i);
    // Preload standby on target frame and pause it, invisibly
    await loadAndPause(conn, channel, pair.standby, clip, tf);
  }
  // Now transition each slot
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue;
    const { host, port, channel } = slot;
    const conn = getConnection(host, port);
    const pair = getPair(i);
    let newPair;
    if (mode === 'fade') {
      newPair = await fadeTransition(conn, channel, pair, config.fadeFrames);
    } else {
      newPair = await cutTransition(conn, channel, pair);
    }
    pairState.set(i, newPair);
  }
}

// -----------------------------------------------------------------------------
// Status snapshot and autosync loop

/**
 * Collect a status snapshot.  Queries each slot's active layer for its
 * current frame and computes the drift relative to the expected frame.  Also
 * returns global parameters and the current autosync mode/resync mode.
 *
 * @returns {Promise<Object>} A structured status object for the UI and clients.
 */
async function snapshotStatus() {
  const tf = targetFrame();
  const rows = [];
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    // Skip disabled slots from the status.  We still include slots
    // with missing host/clip if they are enabled to surface misconfigurations,
    // but disabled slots are hidden from the status entirely.
    if (slot.enabled === false) continue;
    if (!slot.host || !slot.clip) continue;
    const pair = getPair(i);
    const conn = getConnection(slot.host, slot.port);
    const current = await getCurrentFrame(conn, slot.channel, pair.active);
    const drift = current != null ? current - tf : null;
    rows.push({
      index: i,
      name: slot.name || `Slot ${i + 1}`,
      host: slot.host,
      port: slot.port,
      channel: slot.channel,
      baseLayer: slot.baseLayer,
      activeLayer: pair.active,
      standbyLayer: pair.standby,
      clip: slot.clip,
      timecode: slot.timecode,
      currentFrame: current,
      targetFrame: tf,
      drift
    });
  }
  return {
    mode: autosyncMode,
    resyncMode: config.resyncMode,
    fadeFrames: config.fadeFrames,
    t0,
    fps: config.fps,
    frames: config.frames,
    autosyncIntervalSec: config.autosyncIntervalSec,
    driftToleranceFrames: config.driftToleranceFrames,
    rows
  };
}

/**
 * Start the automatic resync loop.  This interval checks each slot's drift
 * against the tolerance and triggers `resyncAll` when any slot exceeds it.
 */
function startAutosyncLoop() {
  stopAutosyncLoop();
  autosyncTimer = setInterval(async () => {
    if (autosyncMode !== 'auto') return;
    const status = await snapshotStatus();
    let need = false;
    for (const row of status.rows) {
      if (row.drift == null) continue;
      if (Math.abs(row.drift) > config.driftToleranceFrames) {
        need = true;
        break;
      }
    }
    if (need) {
      await resyncAll(config.resyncMode, status.rows[0]?.targetFrame ?? targetFrame());
    }
    // Broadcast fresh status on each tick
    broadcast({ type: 'status', payload: await snapshotStatus() });
  }, config.autosyncIntervalSec * 1000);
}

/**
 * Stop the automatic resync loop if running.
 */
function stopAutosyncLoop() {
  if (autosyncTimer) {
    clearInterval(autosyncTimer);
    autosyncTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Express server and API endpoints

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Fetch current status (rows, global params, modes)
app.get('/api/status', async (req, res) => {
  res.json(await snapshotStatus());
});

// Fetch current configuration (no sensitive information)
app.get('/api/config', (req, res) => {
  res.json(config);
});

// Update configuration.  Accepts partial updates; missing fields are ignored.
app.post('/api/config', async (req, res) => {
  const body = req.body || {};
  // Only update whitelisted keys to avoid arbitrary injection
  const allowedGlobals = ['fps','frames','autosyncIntervalSec','driftToleranceFrames','resyncMode','fadeFrames'];
  for (const key of allowedGlobals) {
    if (key in body && typeof body[key] !== 'undefined') {
      config[key] = body[key];
    }
  }
  if (Array.isArray(body.slots)) {
    // Replace entire slots array; ensure length stays at most 20
    config.slots = body.slots.slice(0, 20).map((s, idx) => {
      const def = config.slots[idx] || {};
      return { ...def, ...s };
    });
  }
  // Update pairState for any changed baseLayer
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i];
    const pair = pairState.get(i);
    if (!pair || pair.baseLayer !== slot.baseLayer) {
      pairState.set(i, { active: slot.baseLayer, standby: slot.baseLayer + 10, baseLayer: slot.baseLayer });
    }
  }
  await saveConfig(config);
  // Restart autosync loop if interval changed or resyncMode changed
  if (autosyncMode === 'auto') startAutosyncLoop();
  res.json({ ok: true, config });
});

// Preload all clips
app.post('/api/preload', async (req, res) => {
  try {
    await preloadAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start all clips and set t0
app.post('/api/start', async (req, res) => {
  try {
    await startAll();
    res.json({ ok: true, t0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pause all playback
app.post('/api/pause', async (req, res) => {
  try {
    await pauseAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger an immediate resync
app.post('/api/resync', async (req, res) => {
  try {
    const mode = req.body?.mode || config.resyncMode;
    const tf = Number.isFinite(req.body?.frame) ? req.body.frame : targetFrame();
    await resyncAll(mode, tf);
    res.json({ ok: true, frame: tf, mode });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reset the start clock (t0).  Does not affect current playback, but changes targetFrame.
app.post('/api/reset-clock', (req, res) => {
  t0 = Date.now();
  res.json({ ok: true, t0 });
});

// Set the autosync mode: off, manual, auto
app.post('/api/mode', (req, res) => {
  const mode = (req.body?.mode || '').toLowerCase();
  if (!['off','manual','auto'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be off|manual|auto' });
  }
  autosyncMode = mode;
  if (mode === 'auto') startAutosyncLoop(); else stopAutosyncLoop();
  res.json({ ok: true, mode: autosyncMode });
});

// Update global runtime settings (identical to POST /api/config for backwards compatibility)
app.post('/api/settings', async (req, res) => {
  // Delegates to config update
  await app._router.handle({ ...req, method: 'POST', url: '/api/config' }, res, () => {});
});

// -----------------------------------------------------------------------------
// WebSocket server for live updates

const server = app.listen(process.env.PORT || 8080, () => {
  console.log(`Caspar Autosync server listening on port ${process.env.PORT || 8080}`);
});

const wss = new WebSocketServer({ server });

function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

// Send initial status to new clients
wss.on('connection', async (socket) => {
  socket.send(JSON.stringify({ type: 'status', payload: await snapshotStatus() }));
});

// Cleanly handle process termination
process.on('SIGINT', () => {
  console.log('Shutting down...');
  stopAutosyncLoop();
  server.close(() => process.exit(0));
});