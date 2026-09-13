'use strict';

// NibePi bridge — standalone replacement for Node-RED.
// Handles: serial ↔ Modbus ↔ MQTT ↔ HA discovery + HTTP config UI.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net    = require('net');
const { fork, execFile, exec: cpExec } = require('child_process');
const { EventEmitter } = require('events');

// ── Constants ─────────────────────────────────────────────────────────────────
const CONFIG_FILE  = '/etc/nibepi/config.json';
const MODELS_FILE  = path.join(__dirname, 'lib/models.json');
const ALARMS_FILE  = path.join(__dirname, 'lib/alarms.json');
const BACKEND_FILE = path.join(__dirname, 'backend.js');
const UI_DIR       = path.join(__dirname, 'ui');
const HTTP_PORT    = Number(process.env.PORT) || 1880;
const LOG_BUFFER   = 500;
const GITHUB_REPO  = 'JustChr/nibepi';

const VERSION = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
    catch { return '0.0.0'; }
})();

// ── Ring buffer ───────────────────────────────────────────────────────────────
const RING_SIZE     = 360;          // max points per register; compacts (halves) rather than dropping oldest
const RING_INTERVAL = 10 * 1000;
const ringBuffer    = {};           // address (number) → [{t, v}, …]

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.ico':  'image/x-icon',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
};

const DEFAULT_CONFIG = {
    version: '1.1', registers: [],
    connection: { enable: 'serial', series: 'fSeries' },
    serial:     { port: '/dev/ttyAMA0' },
    mqtt:       { enable: false, host: '127.0.0.1', port: '1883', user: '', pass: '',
                  topic: 'nibe/modbus/', discovery: false },
    system:     { readonly: true },
    log:        { level: 'warn' },
    ui:         { lang: 'en' },
};

// ── Config ────────────────────────────────────────────────────────────────────
let setupDone = fs.existsSync(CONFIG_FILE);

let config = (() => {
    try   { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
})();

// JSON.parse turns "__proto__" into an ordinary own key, so a request body
// carrying one used to walk straight into Object.prototype: {"__proto__":
// {"enable":true}} set `enable` on every object in the process.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
    for (const k of Object.keys(source)) {
        if (UNSAFE_KEYS.has(k)) continue;
        if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            deepMerge(target[k], source[k]);
        } else {
            target[k] = source[k];
        }
    }
    return target;
}

// ── Secrets ───────────────────────────────────────────────────────────────────
// The web login password is kept only as a scrypt hash. The MQTT password
// cannot be — the bridge has to present it to the broker — so it stays in
// config.json but, like the hash, never leaves through the API except in the
// explicit backup export.
const SCRYPT_N    = 1 << 14;
// N is stored with the hash and scrypt's memory grows with it, so only sane
// powers of two are accepted: a restored backup naming N = 2^24 would otherwise
// have the Pi try to allocate gigabytes on the next login.
const HASH_FORMAT = /^scrypt\$(1024|2048|4096|8192|16384|32768|65536)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;
const scryptOpts  = N => ({ N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 });

function hashPassword(pass) {
    const salt = crypto.randomBytes(16);
    const key  = crypto.scryptSync(String(pass), salt, 32, scryptOpts(SCRYPT_N));
    return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(pass, stored) {
    return new Promise(resolve => {
        const m = HASH_FORMAT.exec(stored || '');
        if (!m) return resolve(false);
        const N    = Number(m[1]);
        const want = Buffer.from(m[3], 'base64');
        crypto.scrypt(String(pass), Buffer.from(m[2], 'base64'), want.length, scryptOpts(N), (err, key) =>
            resolve(!err && crypto.timingSafeEqual(key, want)));
    });
}

// Basic Auth resends the credentials with every request, and a page load makes
// dozens, so a header that verified once is remembered (by digest, never in
// clear) instead of paying scrypt each time. The stored hash is part of the
// digest, so changing the password retires every remembered header at once.
const AUTH_CACHE_MS = 12 * 3600 * 1000;
const authCache     = new Map();   // digest → expiry
let authVerifying   = null;        // one scrypt at a time
let authFailUntil   = 0;           // no new attempt before this after a failure

/** On a single-core Pi Zero scrypt competes with the serial backend for the
 *  CPU, so wrong guesses are throttled to one a second. A browser that already
 *  logged in stays served from the cache while that throttle is active. */
async function checkBasicAuth(hdr, authCfg) {
    if (!authCfg.user || !authCfg.hash || !hdr.startsWith('Basic ')) return false;
    const digest = crypto.createHash('sha256').update(`${authCfg.hash}\0${hdr}`).digest('base64');
    for (;;) {
        const exp = authCache.get(digest);
        if (exp && exp > Date.now()) return true;
        if (Date.now() < authFailUntil) return false;
        if (!authVerifying) break;
        await authVerifying;
    }
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    if (colon === -1) return false;
    // scrypt runs whether or not the user name matched, so a wrong name
    // answers no faster than a wrong password.
    const userOk = safeEqual(decoded.slice(0, colon), authCfg.user);
    authVerifying = verifyPassword(decoded.slice(colon + 1), authCfg.hash);
    let passOk;
    try { passOk = await authVerifying; } finally { authVerifying = null; }
    if (userOk && passOk) {
        if (authCache.size >= 32) authCache.clear();
        authCache.set(digest, Date.now() + AUTH_CACHE_MS);
        return true;
    }
    authFailUntil = Date.now() + 1000;
    return false;
}

/** Config as the API shows it: each secret replaced by whether one is set. */
function publicConfig() {
    const c = JSON.parse(JSON.stringify(config));
    if (c.auth) { c.auth.hasPass = !!c.auth.hash; delete c.auth.hash; delete c.auth.pass; }
    if (c.mqtt) { c.mqtt.hasPass = !!c.mqtt.pass; c.mqtt.pass = ''; }
    return c;
}

/** Merge a settings change from the API into config, applying the rules for
 *  secrets the UI never gets to see. Returns an error message, or null once
 *  merged. `fromImport` accepts a stored hash, which only a backup carries. */
function applyConfigPatch(body, { fromImport = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object';

    const a = body.auth;
    if (a && typeof a === 'object') {
        if (typeof a.pass === 'string' && a.pass !== '') {
            a.hash = hashPassword(a.pass);
        } else if (!(fromImport && typeof a.hash === 'string' && HASH_FORMAT.test(a.hash))) {
            delete a.hash;   // an empty field means "unchanged"; a hash is never taken from the UI
        }
        delete a.pass;
        delete a.hasPass;
        const next = { ...(config.auth || {}), ...a };
        // Enabling auth with no complete credentials would lock everyone out
        // for good — the only way back would be editing config.json over SSH.
        if (next.enable && (!next.user || !next.hash)) return 'Authentication needs a username and a password';
    }

    const m = body.mqtt;
    if (m && typeof m === 'object') {
        delete m.hasPass;
        // Same rule: the stored password is never sent to the UI, so an empty
        // field keeps it. Clearing the username clears it for real — MQTT has
        // no password without a username.
        const user = m.user !== undefined ? m.user : (config.mqtt || {}).user;
        if (!user) m.pass = '';
        else if (m.pass === '' || m.pass === undefined) delete m.pass;
    }

    deepMerge(config, body);
    return null;
}

/** Configs written before 1.8.0 keep the web password in clear text. */
function migrateSecrets() {
    const a = config.auth;
    if (!a || !('pass' in a)) return false;
    if (a.pass && !a.hash) a.hash = hashPassword(a.pass);
    delete a.pass;
    return true;
}

let saveTimer;
function scheduleConfigSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistConfig, 2000);
}

function persistConfig(cb) {
    const data = JSON.stringify(config, null, 2);
    const write = () => fs.writeFile(CONFIG_FILE, data, err => {
        if (err) { log('error', `Config save failed: ${err.message}`); return cb && cb(err); }
        log('info', 'Config saved.');
        if (config.system && config.system.readonly) {
            cpExec('sudo -n mount -o remount,ro /', () => cb && cb(null));
        } else {
            cb && cb(null);
        }
    });
    cpExec('sudo -n mount -o remount,rw /', err => {
        if (err) fs.writeFile(CONFIG_FILE, data, err2 => cb && cb(err2 || null));
        else write();
    });
}

// ── Logging ───────────────────────────────────────────────────────────────────
const logBuffer     = [];
const logSseClients = new Set();

const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

function logLevel() {
    const cfg = config.log || {};
    // Migrate old { enable, debug } format
    if (cfg.level === undefined) {
        if (!cfg.enable)  return 'off';
        return cfg.debug  ? 'debug' : 'info';
    }
    return cfg.level;
}

function log(level, msg) {
    if ((LOG_LEVELS[level] || 0) > (LOG_LEVELS[logLevel()] || 0)) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
    console.log(line);
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER) logBuffer.shift();
    for (const res of logSseClients) sendSse(res, 'log', line);
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
const eventSseClients = new Set();
// Each stream holds a socket and a slot in every broadcast for as long as it
// stays open. A few browser tabs is normal; hundreds is someone exhausting a
// Pi Zero on purpose.
const MAX_SSE_CLIENTS = 16;

function sendSse(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function broadcast(event, data) {
    for (const res of eventSseClients) sendSse(res, event, data);
}

// ── Model ─────────────────────────────────────────────────────────────────────
const models     = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
let allRegisters = [];
let regMap       = {};       // address (number) → register object
let activeValues = {};       // address → { data, raw_data, timestamp }

function loadModel(pump) {
    if (!pump || !models[pump]) { log('warn', `Unknown pump model: ${pump}`); return; }
    const modelFile = path.join(__dirname, models[pump].replace(/^\.\//, ''));
    try {
        allRegisters = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
        regMap = {};
        for (const r of allRegisters) regMap[Number(r.register)] = r;
        const alarmReg   = allRegisters.find(r => r.titel === 'Alarm'       || r.titel === 'A-larm');
        const alarmRstReg = allRegisters.find(r => r.titel === 'Alarm Reset');
        alarmRegAddr     = alarmReg    ? Number(alarmReg.register)    : null;
        alarmResetAddr   = alarmRstReg ? Number(alarmRstReg.register) : null;
        alarmValue = 0;
        log('info', `Model ${pump} loaded: ${allRegisters.length} registers${alarmRegAddr ? `, alarm register ${alarmRegAddr}` : ''}.`);
    } catch(e) {
        log('error', `Failed to load model ${pump}: ${e.message}`);
    }
}

// ── State ─────────────────────────────────────────────────────────────────────
let core;
let pumpModel     = (config.system && config.system.pump)     || '';
let pumpFirmware  = (config.system && config.system.firmware) || '';
let pumpConnected     = false;
let alarmRegAddr      = null;
let alarmResetAddr    = null;
let alarmValue        = 0;
const alarmHistory    = [];
const MAX_ALARM_HIST  = 50;
let mqttClient;
let mqttConnected = false;
let mqttDiscovered = new Set();

// ── CRC & Modbus frame helpers ────────────────────────────────────────────────
function calcCRC(data) {
    let crc = 0;
    for (let i = 0; i < data[2] + 5; i++) crc ^= data[i];
    return crc;
}

function buildReadFrame(address) {
    const d = [0xc0, 0x69, 0x02, address & 0xFF, (address >> 8) & 0xFF, 0];
    d[5] = calcCRC(d);
    return d;
}

function buildWriteFrame(address, value) {
    const d = [0xc0, 0x6b, 0x06,
        address & 0xFF, (address >> 8) & 0xFF,
        value & 0xFF, (value >> 8) & 0xFF,
        (value >> 16) & 0xFF, (value >> 24) & 0xFF, 0];
    d[9] = calcCRC(d);
    return d;
}

// ── Register queue ────────────────────────────────────────────────────────────
const regQueue = [];

function addRegular(address) {
    address = Number(address);
    if (!regMap[address]) return;
    const frame = buildReadFrame(address);
    const key   = frame.toString();
    if (regQueue.find(f => f.toString() === key)) return;
    regQueue.push(frame);
    if (core && core.connected) core.send({ type: 'regRegister', data: regQueue });
    log('info', `Register ${address} added to poll queue.`);
}

function removeRegular(address) {
    address = Number(address);
    const frame = buildReadFrame(address);
    const key   = frame.toString();
    const idx   = regQueue.findIndex(f => f.toString() === key);
    if (idx === -1) return;
    regQueue.splice(idx, 1);
    if (core && core.connected) core.send({ type: 'regRegister', data: regQueue });
    log('info', `Register ${address} removed from poll queue.`);
}

// ── Backend spawn ─────────────────────────────────────────────────────────────
function spawnBackend() {
    if (core) { try { core.kill(); } catch {} }
    const port = (config.serial && config.serial.port) || '/dev/ttyAMA0';
    log('info', `Spawning backend on ${port}`);
    // MALLOC_ARENA_MAX caps glibc malloc arenas (default 8×cores = up to 32 on the
    // 4-core Pi). Fewer arenas let freed chunks consolidate and be trimmed back to
    // the OS instead of ratcheting the brk heap upward — the main cause of the slow
    // backend RSS growth, which lives in glibc's [heap], not the V8 heap.
    // --expose-gc lets the backend collect dead serial Buffers explicitly: its JS
    // heap is so small (~3 MB) that V8 never runs an old-gen GC on its own, letting
    // external Buffer backing stores pile up for days (see backend.js).
    core = fork(BACKEND_FILE, {
        detached: true,
        execArgv: ['--max-old-space-size=48', '--expose-gc'],
        env: { ...process.env, MALLOC_ARENA_MAX: '2' },
    });
    core.send({ start: true, port });
    core.send({ type: 'debug', data: logLevel() === 'debug' });
    core.on('message', onBackendMessage);
    core.on('exit', code => {
        log('warn', `Backend exited (code ${code}), restarting in 5s`);
        pumpConnected = false;
        broadcast('status', getStatus());
        setTimeout(spawnBackend, 5000);
    });
    core.on('error', err => log('error', `Backend error: ${err.message}`));
}

function onBackendMessage(m) {
    if (m.type === 'data') {
        handleFrame(m.data, m.rmu);
    } else if (m.type === 'fault') {
        log('error', `Pump fault: ${JSON.stringify(m.data)}`);
        broadcast('fault', m.data);
    } else if (m.type === 'log') {
        if (config.log && config.log.debug) {
            const text = Array.isArray(m.data) ? m.data.join(',') : m.data;
            log('debug', `[backend][${m.kind}] ${text}`);
        }
    }
}

// ── Announcement / pump model detection ──────────────────────────────────────
function handleAnnouncement(buf) {
    if (pumpModel) {
        if (!pumpConnected) {
            pumpConnected = true;
            broadcast('status', getStatus());
            log('info', `Pump reconnected (${pumpModel}) — restored full register poll queue (${regQueue.length} entries).`);
            if (core && core.connected && regQueue.length > 0) {
                core.send({ type: 'regRegister', data: regQueue });
            }
        }
        return;
    }
    const modelLength = buf[4] + 5;
    let parts = Buffer.from(buf).slice(8, modelLength).toString().split(' ');
    if (parts[0] === 'VVM' || parts[0] === 'SMO') parts[0] = parts[0] + (parts[1] || '');
    const model = parts[0].split('-')[0].replace(',', '');
    if (!model) return;

    pumpModel    = model;
    pumpFirmware = String((buf[6] * 256) + buf[7]);
    if (!config.system) config.system = {};
    config.system.pump     = model;
    config.system.firmware = pumpFirmware;
    scheduleConfigSave();
    loadModel(model);

    pumpConnected = true;
    broadcast('status', getStatus());
    log('info', `Pump: ${model} firmware ${pumpFirmware}`);

    // Enqueue all configured registers + alarm register
    if (config.registers) {
        for (const addr of config.registers) addRegular(addr);
    }
    if (alarmRegAddr) addRegular(alarmRegAddr);
}

// ── F-series frame decoder (ported from index.js decodeMessage) ───────────────
// Each register's option values, parsed once per model rather than on every
// frame. Keyed by the model's register objects, so loading a model starts fresh.
const optionCache = new WeakMap();
function listedOptions(reg) {
    if (!optionCache.has(reg)) {
        const map = parseStateMap(reg.info);
        optionCache.set(reg, map ? new Set(Object.keys(map).map(Number)) : null);
    }
    return optionCache.get(reg);
}

function handleFrame(buf, rmuFlag) {
    if (!buf || buf.length < 5) return;
    if (buf[3] === 109) { handleAnnouncement(buf); return; }
    if (!pumpModel) return;
    if (buf[3] !== 104 && buf[3] !== 106 && buf[3] !== 98 && buf[3] !== 96) return;

    const timeNow = Date.now();

    for (let i = 5; i < buf.length - 3; i++) {
        const address = (buf[i + 1] * 256 + buf[i]);
        const reg     = regMap[address];
        if (!reg) { i += 3; continue; }

        let data;
        if (reg.size === 's32' || reg.size === 'u32') {
            if (buf[3] === 104) {
                data = buf[i+2] | buf[i+3]<<8 | buf[i+6]<<16 | buf[i+7]<<24;
                i += 7;
            } else {
                data = buf[i+4] | buf[i+5]<<8 | buf[i+2]<<16 | buf[i+3]<<24;
                i += 5;
            }
            if (reg.size === 's32' && data >= 2147483647) data -= 4294967294;
            if (reg.size === 'u32') data = data >>> 0;
        } else {
            data = (buf[i+3] & 0xFF) << 8 | (buf[i+2] & 0xFF);
            i += 3;
            if (reg.size === 's16' && data >= 32768) data -= 65536;
            if (reg.size === 's8') {
                if (data > 128 && data < 32768) data -= 256;
                else if (data >= 32768) data -= 65536;
            }
        }

        if (data === -32768) {
            log('error', `Register ${address} sensor fault (0x8000)`);
            continue;
        }

        const factor = Number(reg.factor) || 1;
        // `factor` may be fractional — 43141 counts in units of 10 W, so 0.1 —
        // and a fractional divisor can leave float dust that String() would put
        // on MQTT verbatim (7 / 0.3 is 23.333333333333336). The divisors in use
        // happen to be exact over the register range; this keeps the next one
        // that isn't from leaking a 17-digit state into Home Assistant.
        const scaled = Math.round((data / factor) * 1e6) / 1e6;
        const min    = Number(reg.min);
        const max    = Number(reg.max);

        if (min !== 0 || max !== 0) {
            // A value the register lists as one of its options is valid whatever
            // min/max say. Some model exports get that range wrong — 47139 lists
            // 40=Auto under a max of 30, 47382 lists 0=Off under a min of 1 — and
            // the pump does report those values, so a brine pump in Auto never
            // reached Home Assistant and the High brine alarm switch could never
            // show Off. Writes, the UI editor and HA discovery already go by the
            // options rather than the range.
            const options = listedOptions(reg);
            if (!(options && options.has(data)) && (scaled > max / factor || scaled < min / factor)) {
                log('error', `Register ${address} out of range: ${scaled}`);
                continue;
            }
        } else if (reg.unit === '°C' && (scaled < -100 || scaled > 350)) {
            log('error', `Register ${address} implausible temp: ${scaled}°C`);
            continue;
        }

        activeValues[address] = { data: scaled, raw_data: scaled, timestamp: timeNow };

        const topic = (config.mqtt && config.mqtt.topic) + address;
        publishMqtt(topic,         String(scaled));
        publishMqtt(topic + '/raw', String(scaled));

        broadcast('value', { register: address, value: scaled, unit: reg.unit, titel: reg.titel });

        if (address === alarmRegAddr) {
            const prev = alarmValue;
            alarmValue = scaled;
            if (scaled !== prev) {
                if (scaled !== 0) {
                    alarmHistory.push({ code: scaled, start: Date.now(), end: null });
                    if (alarmHistory.length > MAX_ALARM_HIST) alarmHistory.shift();
                    log('warn', `Alarm ${scaled} active (reg ${alarmRegAddr}).`);
                } else {
                    const last = [...alarmHistory].reverse().find(e => e.code === prev && !e.end);
                    if (last) last.end = Date.now();
                    log('warn',  `Alarm cleared (was ${prev}, reg ${alarmRegAddr}).`);
                }
                broadcast('status', getStatus());
            }
        }

        const inConfig = (config.registers || []).some(r => Number(r) === address);
        if (config.mqtt && config.mqtt.discovery && inConfig && !mqttDiscovered.has(address)) {
            publishDiscovery(reg);
        }

        log('debug', `${address} (${reg.titel}): ${scaled} ${reg.unit}`);
    }

    // After first full data frame, push register queue if it was empty
    if (regQueue.length === 0 && buf[3] === 104) {
        if (config.registers) for (const addr of config.registers) addRegular(addr);
        if (alarmRegAddr) addRegular(alarmRegAddr);
    }
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
function startMqtt() {
    if (mqttClient) { try { mqttClient.end(true); } catch {} }
    const { host, port, user, pass, topic } = config.mqtt;
    if (!host) return;

    const mqtt    = require('mqtt');
    const useTls  = !!(config.mqtt.tls);
    const opts = {
        port:            Number(port) || (useTls ? 8883 : 1883),
        clientId:        'nibepi_' + Math.random().toString(16).slice(2, 10),
        keepalive:       60,
        reconnectPeriod: 5000,
        connectTimeout:  30000,
        clean:           true,
        queueQoSZero:    false,
    };
    if (user) opts.username = user;
    if (pass) opts.password = pass;
    if (useTls) {
        opts.rejectUnauthorized = true;
        const caFile = config.mqtt.tlsCaFile;
        if (caFile) {
            try { opts.ca = fs.readFileSync(caFile); }
            catch(e) { log('error', `MQTT TLS: CA file load failed: ${e.message}`); }
        }
    }

    mqttClient = mqtt.connect((useTls ? 'mqtts' : 'mqtt') + '://' + host, opts);

    mqttClient.on('connect', () => {
        mqttConnected = true;
        log('info', 'MQTT broker connected.');
        mqttClient.subscribe((config.mqtt.topic || '') + '#');
        mqttDiscovered.clear(); // re-publish discovery after reconnect
        broadcast('status', getStatus());
    });

    mqttClient.on('close', () => {
        mqttConnected = false;
        log('warn', 'MQTT broker disconnected.');
        broadcast('status', getStatus());
    });

    mqttClient.on('error', err => log('error', `MQTT: ${err.message}`));

    mqttClient.on('message', (incomingTopic, message) => {
        const sub = (config.mqtt && config.mqtt.topic) || '';
        if (!incomingTopic.startsWith(sub)) return;
        const parts = incomingTopic.slice(sub.length).split('/');
        if (parts[1] === 'set') handleMqttSet(Number(parts[0]), message.toString());
    });
}

function publishMqtt(topic, payload, retain = false) {
    if (mqttClient && mqttConnected) {
        mqttClient.publish(topic, String(payload), { retain });
    }
}

const SIZE_BOUNDS = {
    u8:  [0, 255],           s8:  [-128, 127],
    u16: [0, 65535],         s16: [-32768, 32767],
    u32: [0, 4294967295],    s32: [-2147483648, 2147483647],
};

/** The raw integer to write for a requested value, or why it is refused.
 *  These are the limits the web UI's editor has always applied — the listed
 *  options of a state map, else the model's min/max, else the register type's
 *  range — enforced here because MQTT and plain HTTP clients never went
 *  through that editor and could put any number on the bus. */
function rawWriteValue(reg, value) {
    const text  = String(value).trim();
    const shown = text.length > 40 ? text.slice(0, 40) + '…' : text;
    const stateMap = parseStateMap(reg.info);
    if (stateMap) {
        const entry = Object.entries(stateMap).find(([, label]) => label === text);
        const key   = entry ? entry[0] : text;
        if (!/^\d+$/.test(key) || !(key in stateMap)) {
            return { error: `'${shown}' is not an option (${Object.entries(stateMap).map(([k, v]) => `${k}=${v}`).join(', ')})` };
        }
        return { raw: Number(key) };
    }
    if (!/^-?\d+(\.\d+)?$/.test(text)) return { error: `'${shown}' is not a number` };
    const factor = Number(reg.factor) || 1;
    const raw    = Math.round(Number(text) * factor);
    let lo = Number(reg.min);
    let hi = Number(reg.max);
    // 0/0 means the model gives no range. Min above max (or missing) is a
    // broken model entry; the type range is the only honest limit for either.
    if ((lo === 0 && hi === 0) || !(lo <= hi)) [lo, hi] = SIZE_BOUNDS[reg.size] || [-Infinity, Infinity];
    if (raw < lo || raw > hi) return { error: `${shown} is outside ${lo / factor} … ${hi / factor}` };
    return { raw };
}

/** Write a register from MQTT or the HTTP API. Returns an error message, or
 *  null once the write is queued. */
function handleMqttSet(address, value) {
    const refuse = msg => { log('error', `Set register ${address} refused: ${msg}`); return msg; };
    const reg = regMap[address];
    if (!reg) return refuse('unknown register');
    if (reg.mode !== 'R/W') return refuse('register is read-only');
    const { raw, error } = rawWriteValue(reg, value);
    if (error) return refuse(error);

    log('info', `Set register ${address} (${reg.titel}) = ${raw} raw`);
    if (core && core.connected) core.send({ type: 'setData', data: buildWriteFrame(address, raw) });
    return null;
}

// ── HA MQTT Discovery ─────────────────────────────────────────────────────────
function parseStateMap(info) {
    if (!info) return null;
    if (/binary encoded|bitmap|\bBit\d+=|\bb\d+:/i.test(info)) return null;
    const parts = info.split(/(?=\b\d+=)/);
    const pairs = {};
    for (const part of parts) {
        const m = part.match(/^(\d+)=(.+)/);
        if (!m) continue;
        const num   = parseInt(m[1]);
        const label = m[2].replace(/,\s*$/, '').trim();
        if (label && !(num in pairs)) pairs[num] = label;
    }
    return Object.keys(pairs).length >= 2 ? pairs : null;
}

function unitToDeviceClass(unit) {
    if (unit === '°C')  return 'temperature';
    if (unit === 'kW' || unit === 'W')  return 'power';
    if (unit === 'kWh') return 'energy';
    if (unit === 'A')   return 'current';
    if (unit === 'V')   return 'voltage';
    return undefined;
}

/** Home Assistant needs a state_class before it treats a sensor as a number.
 *  Without one the entity is drawn as a timeline of strings rather than a graph,
 *  is kept out of long-term statistics, and is refused by utility_meter and the
 *  Energy dashboard — which is why registers with no unit, such as the heat
 *  medium dT pair or the compressor start counter, arrive in HA as text. */
function stateClassFor(reg) {
    if (reg.unit === 'kWh' || reg.unit === 'h') return 'total_increasing';
    if (/\bstarts\b/i.test(reg.titel || '')) return 'total_increasing';
    return 'measurement';
}

function deviceBlock() {
    return {
        identifiers:  ['nibepi'],
        name:         'Nibe Heat Pump',
        model:        pumpModel || (config.system && config.system.pump) || 'unknown',
        manufacturer: 'NIBE',
    };
}

/** Every component a register can be published as. Which one it lands on is
 *  derived from the model file, so a register can move between them — a corrected
 *  `info` that now parses as "0=Off 1=On" turns a number into a switch. The old
 *  config is retained on the broker, and HA keeps honouring it: without clearing
 *  it the register would own two entities for good, the stale one stuck at
 *  whatever it last read. */
const HA_COMPONENTS = ['sensor', 'number', 'switch', 'select'];

/** Retract the retained configs a register is no longer published under. An
 *  empty payload is how HA is told an entity is gone; sending it to a topic that
 *  was never used is a no-op. */
function clearStaleDiscovery(address, keep) {
    for (const c of HA_COMPONENTS) {
        if (c !== keep) publishMqtt(`homeassistant/${c}/${address}/config`, '', true);
    }
}

function publishDiscovery(reg) {
    if (!mqttClient || !mqttConnected) return;
    const address  = Number(reg.register);
    const topic    = (config.mqtt.topic || '') + address;
    const stateMap = parseStateMap(reg.info);
    let component, payload;

    if (reg.mode === 'R/W') {
        if (stateMap) {
            const keys     = Object.keys(stateMap).map(Number).sort((a, b) => a - b);
            const isBinary = keys.length === 2 && keys[0] === 0 && keys[1] === 1;
            if (isBinary) {
                component = 'switch';
                payload   = {
                    name: `Nibe ${reg.titel}`, unique_id: `nibepi_${address}`,
                    state_topic: topic, command_topic: topic + '/set',
                    payload_on: '1', payload_off: '0', state_on: '1', state_off: '0',
                    device: deviceBlock(),
                };
            } else {
                component = 'select';
                const fwd = Object.entries(stateMap).map(([k, v]) => `${k}: '${v}'`).join(', ');
                const rev = Object.entries(stateMap).map(([k, v]) => `'${v}': ${k}`).join(', ');
                payload = {
                    name: `Nibe ${reg.titel}`, unique_id: `nibepi_${address}`,
                    state_topic: topic, command_topic: topic + '/set',
                    options: keys.map(k => stateMap[k]),
                    value_template:   `{%- set m = {${fwd}} -%}{{ m.get(value|int, value) }}`,
                    command_template: `{%- set m = {${rev}} -%}{{ m.get(value, value) }}`,
                    device: deviceBlock(),
                };
            }
        } else {
            component = 'number';
            const factor = Number(reg.factor) || 1;
            const step   = factor > 1 ? Math.round((1 / factor) * 1000) / 1000 : 1;
            const min    = Number(reg.min);
            const max    = Number(reg.max);
            payload = {
                name: `Nibe ${reg.titel}`, unique_id: `nibepi_${address}`,
                state_topic: topic, command_topic: topic + '/set',
                step, device_class: unitToDeviceClass(reg.unit),
                unit_of_measurement: reg.unit || undefined,
                device: deviceBlock(),
            };
            if (min !== 0 || max !== 0) { payload.min = min / factor; payload.max = max / factor; }
        }
    } else {
        component = 'sensor';
        payload = {
            name: `Nibe ${reg.titel}`, unique_id: `nibepi_${address}`,
            state_topic: topic,
            device_class: unitToDeviceClass(reg.unit),
            state_class: stateClassFor(reg),
            unit_of_measurement: reg.unit || undefined,
            device: deviceBlock(),
        };
        if (stateMap) {
            const fwd = Object.entries(stateMap).map(([k, v]) => `${k}: '${v}'`).join(', ');
            payload.value_template = `{%- set m = {${fwd}} -%}{{ m.get(value|int, value) }}`;
            delete payload.device_class;
            delete payload.state_class;
            delete payload.unit_of_measurement;
        }
    }

    // Strip undefined fields
    for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k]; }

    // The live config first, then the retraction of the others: the new entity
    // exists before the old one goes, so a register that changes component never
    // disappears from a dashboard even momentarily.
    publishMqtt(`homeassistant/${component}/${address}/config`, JSON.stringify(payload), true);
    clearStaleDiscovery(address, component);
    mqttDiscovered.add(address);
    log('info', `Discovery: ${component} ${address} (${reg.titel})`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function getStatus() {
    return {
        connected:            pumpConnected,
        model:                pumpModel,
        firmware:             pumpFirmware,
        mqttConnected,
        readonly:             !!(config.system && config.system.readonly),
        version:              VERSION,
        alarm:                alarmValue,
        canReset:             alarmResetAddr !== null && alarmValue !== 0,
        updateAvailable:      !!(_cachedRelease && _cachedRelease.newer),
        latestVersion:        (_cachedRelease && _cachedRelease.newer) ? _cachedRelease.latest : null,
        authEnabled:          !!(config.auth && config.auth.enable),
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        req.on('error', reject);
    });
}

/** True when a browser reports the request as coming from another site.
 *  Sec-Fetch-Site is the browser's own verdict and survives a reverse proxy that
 *  rewrites Host; Origin is the fallback for browsers without it. Requests with
 *  neither come from curl and the like, which are not a cross-site vector. */
function isCrossSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site !== 'same-origin' && site !== 'none';
    const origin = req.headers.origin;
    if (!origin) return false;
    try   { return new URL(origin).host !== req.headers.host; }
    catch { return true; }   // "null" from sandboxed frames, or garbage
}

/** Compare without leaking, through timing, how much of a guess was right.
 *  Hashing first gives timingSafeEqual the equal lengths it insists on. */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// A web page can point a host name of its own at the Pi's LAN address (DNS
// rebinding) and then reach the API as if it were same-origin, which walks
// straight past the cross-site check. Its requests still carry that foreign
// name in Host, so while authentication is off only names that can belong to
// this network are served. With authentication on the rebound page has no
// credentials, so there is nothing left to guard. An IP address always works.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.fritz.box'];

function isLocalHost(hostHeader) {
    if (!hostHeader) return true;   // HTTP/1.0 tools; every browser sends Host
    const h = String(hostHeader).toLowerCase();
    if (h.startsWith('[')) return net.isIPv6(h.slice(1, h.indexOf(']')));
    const host = h.replace(/:\d+$/, '').replace(/\.$/, '');
    if (net.isIP(host) || !host.includes('.')) return true;   // 10.0.0.81, nibepi, localhost
    if (LOCAL_SUFFIXES.some(s => host.endsWith(s))) return true;
    const extra = config.http && config.http.allowedHosts;
    return Array.isArray(extra) && extra.some(e => String(e).toLowerCase() === host);
}

// Before setup has run no credentials exist, so nothing can be protected yet;
// until then only what the wizard itself calls is served.
const SETUP_API = new Set(['/api/serial-ports', '/api/models', '/api/setup/complete']);

function respond(res, status, data) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const urlObj   = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    // No CORS headers. Only the UI served from this origin talks to the API;
    // `Access-Control-Allow-Origin: *` let any web page opened in a browser on
    // the LAN read the config, passwords included, straight off the Pi.

    // ── Cross-site request refusal ────────────────────────────────────────────
    // Without CORS another site can still *send* a POST here: a form or a
    // no-cors fetch needs no preflight, and readBody parses the body whatever
    // its Content-Type. That was enough to change pump settings from any page
    // someone on the LAN happened to visit.
    if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSite(req)) {
        respond(res, 403, { error: 'Cross-site request refused' });
        return;
    }

    // ── First-time setup redirect ─────────────────────────────────────────────
    if (!(config.auth && config.auth.enable) && !isLocalHost(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('NibePi does not answer to this host name while authentication is off. '
              + 'Open it by IP address, or add the name to http.allowedHosts in /etc/nibepi/config.json.');
        return;
    }

    if (!setupDone && pathname.startsWith('/api/') && !SETUP_API.has(pathname)) {
        respond(res, 403, { error: 'Finish the setup wizard first' });
        return;
    }

    if (!setupDone && pathname !== '/setup' && !pathname.startsWith('/api/') && !pathname.startsWith('/lang/')) {
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return;
    }

    // ── HTTP Basic Auth ───────────────────────────────────────────────────────
    const authCfg = config.auth || {};
    if (authCfg.enable) {
        const ok = await checkBasicAuth(req.headers['authorization'] || '', authCfg);
        if (!ok) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NibePi"' });
            res.end('Unauthorized');
            return;
        }
    }

    // ── Static UI files ───────────────────────────────────────────────────────
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const filePath = pathname === '/'
            ? path.join(UI_DIR, 'index.html')
            : pathname === '/setup'
                ? path.join(UI_DIR, 'setup.html')
                : path.join(UI_DIR, pathname);
        // The separator matters: a bare prefix test would also admit a sibling
        // such as /opt/nibepi/ui-old.
        if (!filePath.startsWith(UI_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            const ct = MIME[path.extname(filePath)] || 'application/octet-stream';
            const headers = { 'Content-Type': ct };
            if (ct === 'text/html') headers['Cache-Control'] = 'no-store';
            res.writeHead(200, headers);
            res.end(data);
        });
        return;
    }

    // ── SSE: live register values + status ────────────────────────────────────
    if (pathname === '/api/events') {
        if (eventSseClients.size >= MAX_SSE_CLIENTS) { respond(res, 503, { error: 'Too many live connections' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(':\n\n');
        eventSseClients.add(res);
        sendSse(res, 'status', getStatus());
        req.on('close', () => eventSseClients.delete(res));
        return;
    }

    // ── SSE: log stream ───────────────────────────────────────────────────────
    if (pathname === '/api/logs') {
        if (logSseClients.size >= MAX_SSE_CLIENTS) { respond(res, 503, { error: 'Too many live connections' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(':\n\n');
        logSseClients.add(res);
        for (const line of logBuffer) sendSse(res, 'log', line);
        req.on('close', () => logSseClients.delete(res));
        return;
    }

    // ── REST API ──────────────────────────────────────────────────────────────
    try {
        if (pathname === '/api/setup/complete' && req.method === 'POST') {
            // The wizard runs once; afterwards settings change through /api/config.
            if (setupDone) { respond(res, 409, { error: 'Setup has already been completed' }); return; }
            const body = await readBody(req);
            const err  = applyConfigPatch(body);
            if (err) { respond(res, 400, { error: err }); return; }
            setupDone = true;
            persistConfig(err => {
                if (err) { respond(res, 500, { error: err.message }); return; }
                if (config.mqtt && config.mqtt.enable) startMqtt();
                respond(res, 200, { ok: true });
            });

        } else if (pathname.startsWith('/api/history/') && req.method === 'GET') {
            const addr = Number(pathname.slice('/api/history/'.length));
            respond(res, 200, ringBuffer[addr] || []);

        } else if (pathname === '/api/alarms' && req.method === 'GET') {
            fs.readFile(ALARMS_FILE, (err, data) => {
                if (err) respond(res, 404, { error: 'Alarm list not found' });
                else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data); }
            });

        } else if (pathname === '/api/alarms/history' && req.method === 'GET') {
            respond(res, 200, alarmHistory);

        } else if (pathname === '/api/config' && req.method === 'GET') {
            respond(res, 200, publicConfig());

        } else if (pathname === '/api/config/export' && req.method === 'GET') {
            // The one place secrets leave in full — the MQTT password and the
            // login hash — because a restore has to bring them back.
            const data = JSON.stringify(config, null, 2);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Disposition': 'attachment; filename="nibepi-config.json"',
            });
            res.end(data);

        } else if (pathname === '/api/config/import' && req.method === 'POST') {
            const body = await readBody(req);
            const err  = applyConfigPatch(body, { fromImport: true });
            if (err) { respond(res, 400, { error: err }); return; }
            scheduleConfigSave();
            if (config.mqtt && config.mqtt.enable) startMqtt();
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/config' && req.method === 'POST') {
            const body = await readBody(req);
            const prevMqttEnable = config.mqtt && config.mqtt.enable;
            const err = applyConfigPatch(body);
            if (err) { respond(res, 400, { error: err }); return; }
            scheduleConfigSave();
            const newMqttEnable = config.mqtt && config.mqtt.enable;
            if (newMqttEnable && (!mqttConnected || !prevMqttEnable)) startMqtt();
            else if (!newMqttEnable && mqttClient) { try { mqttClient.end(true); } catch {} mqttConnected = false; }
            if (core && core.connected) core.send({ type: 'debug', data: logLevel() === 'debug' });
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/registers' && req.method === 'GET') {
            const active = new Set((config.registers || []).map(Number));
            respond(res, 200, allRegisters.map(r => ({
                ...r,
                active: active.has(Number(r.register)),
                value:  activeValues[Number(r.register)] ? activeValues[Number(r.register)].data : null,
            })));

        } else if (pathname === '/api/register/add' && req.method === 'POST') {
            const { register: addr } = await readBody(req);
            if (!config.registers) config.registers = [];
            const n = Number(addr);
            if (!config.registers.some(r => Number(r) === n)) {
                config.registers.push(String(n));
                scheduleConfigSave();
                if (pumpConnected) addRegular(n);
                else log('info', `Register ${n} queued (pump not yet connected).`);
            }
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/register/remove' && req.method === 'POST') {
            const { register: addr } = await readBody(req);
            const n = Number(addr);
            config.registers = (config.registers || []).filter(r => Number(r) !== n);
            scheduleConfigSave();
            removeRegular(n);
            // Nothing polls it now, so its entity would sit in HA at the last
            // value it happened to read. Retract every component it could have
            // been published under and let HA remove it.
            clearStaleDiscovery(n, null);
            mqttDiscovered.delete(n);
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/register/set' && req.method === 'POST') {
            const { register: addr, value } = await readBody(req);
            const reg = regMap[Number(addr)];
            if (!reg)                          { respond(res, 404, { error: `Unknown register ${addr}` }); return; }
            if (reg.mode !== 'R/W')            { respond(res, 400, { error: 'Register is read-only' }); return; }
            if (!core || !core.connected)      { respond(res, 409, { error: 'Pump not connected' }); return; }
            const err = handleMqttSet(Number(addr), String(value));
            if (err) { respond(res, 400, { error: err }); return; }
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/alarm/reset' && req.method === 'POST') {
            if (!core || !core.connected) {
                respond(res, 409, { error: 'Pump not connected' }); return;
            }
            if (!alarmResetAddr || !alarmValue) {
                respond(res, 409, { error: 'No active alarm' }); return;
            }
            // The reset register is edge-triggered: the pump acts on the 0 → 1
            // transition, so a bare 1 does nothing while it is still latched at 1.
            // The backend drains its send queue with pop(), so hand over the 1
            // first and the 0 second to get 0 → 1 on the wire.
            const frame1 = buildWriteFrame(alarmResetAddr, 1);
            const frame0 = buildWriteFrame(alarmResetAddr, 0);
            core.send({ type: 'setData', data: frame1 });
            core.send({ type: 'setData', data: frame0 });
            const hex = f => f.map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
            log('warn', `Alarm ${alarmValue} reset triggered → reg ${alarmResetAddr} (0 → 1 edge).`);
            log('info', `Alarm ${alarmValue} reset frames: 0=[${hex(frame0)}] 1=[${hex(frame1)}]`);
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/logs/clear' && req.method === 'POST') {
            logBuffer.length = 0;
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/status' && req.method === 'GET') {
            respond(res, 200, getStatus());

        } else if (pathname === '/api/restart' && req.method === 'POST') {
            respond(res, 200, { ok: true });
            log('info', 'Restart requested via UI.');
            setTimeout(() => {
                cpExec('sudo -n systemctl restart bridge', err => {
                    if (err) { log('warn', 'systemctl failed, using process.exit(0)'); process.exit(0); }
                });
            }, 500);

        } else if (pathname === '/api/fsmode' && req.method === 'GET') {
            cpExec('findmnt -n -o OPTIONS /', (err, stdout) => {
                const readonly = !err && /\bro\b/.test(stdout.split(',')[0]);
                respond(res, 200, { readonly });
            });

        } else if (pathname === '/api/fsmode' && req.method === 'POST') {
            const { readonly } = await readBody(req);
            const cmd = readonly ? 'sudo -n mount -o remount,ro /' : 'sudo -n mount -o remount,rw /';
            cpExec(cmd, err => {
                if (err) { respond(res, 500, { error: err.message }); return; }
                if (!config.system) config.system = {};
                config.system.readonly = !!readonly;
                scheduleConfigSave();
                broadcast('status', getStatus());
                respond(res, 200, { ok: true, readonly: !!readonly });
            });

        } else if (pathname === '/api/models' && req.method === 'GET') {
            respond(res, 200, Object.keys(models));

        } else if (pathname === '/api/serial-ports' && req.method === 'GET') {
            const { SerialPort } = require('serialport');
            SerialPort.list().then(ports => {
                const RS485 = ['ttyAMA', 'ttyUSB', 'ttyACM'];
                const out = ports
                    .map(p => ({
                        path:      p.path,
                        desc:      p.manufacturer || p.pnpId || '',
                        suggested: RS485.some(h => p.path.includes(h)),
                    }))
                    .sort((a, b) => (b.suggested ? 1 : 0) - (a.suggested ? 1 : 0));
                respond(res, 200, { ports: out });
            }).catch(err => respond(res, 500, { error: err.message }));

        } else if (pathname === '/api/serial-test' && req.method === 'POST') {
            readBody(req).then(body => {
                const port = body && body.port;
                if (!port) { respond(res, 400, { error: 'Missing port' }); return; }
                const { SerialPort } = require('serialport');
                const sp = new SerialPort({ path: port, baudRate: 9600, autoOpen: false });
                sp.open(err => {
                    if (!err) { sp.close(() => respond(res, 200, { ok: true })); return; }
                    // EBUSY means the backend already owns this port — that's fine
                    if (err.code === 'EBUSY' || err.message.includes('busy')) {
                        respond(res, 200, { ok: true, note: 'Port ist belegt — aktive Verbindung läuft' });
                    } else {
                        respond(res, 200, { ok: false, error: err.message });
                    }
                });
            }).catch(err => respond(res, 500, { error: err.message }));

        } else if (pathname === '/api/mqtt-scan' && req.method === 'GET') {
            cpExec("ip route show default 2>/dev/null | awk '/default/{print $3;exit}'", (_, gw) => {
                const net = require('net');
                const candidates = ['homeassistant.local', (gw || '').trim(), '127.0.0.1']
                    .filter((h, i, a) => h && a.indexOf(h) === i);
                let pending = candidates.length;
                const found = [];
                if (!pending) { respond(res, 200, { hosts: [] }); return; }
                candidates.forEach(host => {
                    const s = new net.Socket();
                    s.setTimeout(1500);
                    s.connect(1883, host, () => { found.push(host); s.destroy(); if (!--pending) respond(res, 200, { hosts: found }); });
                    s.on('error',   () => { if (!--pending) respond(res, 200, { hosts: found }); });
                    s.on('timeout', () => { s.destroy(); if (!--pending) respond(res, 200, { hosts: found }); });
                });
            });

        } else if (pathname === '/api/mqtt-test' && req.method === 'POST') {
            readBody(req).then(body => {
                if (!body || !body.host) { respond(res, 400, { error: 'Missing host' }); return; }
                const mqttLib = require('mqtt');
                const url = `mqtt://${body.host}:${body.port || 1883}`;
                const opts = { connectTimeout: 5000, reconnectPeriod: 0 };
                // The UI never holds the stored password, so an empty field
                // means the saved one — but only against the broker it was
                // saved for, or this would hand it to any host a request names.
                const saved = config.mqtt || {};
                let pass = body.pass || '';
                if (!pass && body.user && body.user === saved.user && String(body.host) === String(saved.host)) {
                    pass = saved.pass || '';
                }
                if (body.user) { opts.username = body.user; opts.password = pass; }
                const tc = mqttLib.connect(url, opts);
                let done = false;
                const finish = (ok, msg) => { if (done) return; done = true; tc.end(true); respond(res, 200, { ok, error: msg }); };
                tc.on('connect', () => finish(true));
                tc.on('error',   e  => finish(false, e.message));
                setTimeout(()       => finish(false, 'Timeout'), 6000);
            }).catch(err => respond(res, 500, { error: err.message }));

        } else if (pathname === '/api/memhistory' && req.method === 'GET') {
            const cur = { t: Date.now(), bridge: process.memoryUsage().rss, backend: backendRss() };
            respond(res, 200, { history: memHistory, current: cur });

        } else if (pathname === '/api/version' && req.method === 'GET') {
            respond(res, 200, { current: VERSION });

        } else if (pathname === '/api/version/check' && req.method === 'GET') {
            checkLatestRelease((err, info) => {
                if (err) { respond(res, 502, { error: err.message }); return; }
                respond(res, 200, info);
            }, true);

        } else if (pathname === '/api/update' && req.method === 'POST') {
            // The bridge can only ask for "the latest release". Installing is
            // nibepi-update.service's job: it runs as root, looks the release
            // up itself and takes no input, so nothing in this request reaches
            // a root shell. This route once took a download URL from the body
            // and spliced it into one (issue #1). The version is compared only
            // so that a release published after the user clicked is not
            // installed unseen.
            const body = await readBody(req).catch(() => null) || {};
            checkLatestRelease((err, rel) => {
                if (err) { respond(res, 502, { error: `Release check failed: ${err.message}` }); return; }
                if (!RELEASE_TAG.test(rel.tag)) {
                    respond(res, 502, { error: `Refusing release with unexpected tag '${rel.tag}'` });
                    return;
                }
                if (body.version && body.version !== rel.latest) {
                    respond(res, 409, { error: `Latest release is ${rel.latest}, not ${body.version}` });
                    return;
                }
                execFile('systemctl', ['show', '--property=ActiveState', '--value', UPDATE_UNIT], (_, state) => {
                    // A oneshot unit stays "activating" for as long as it runs.
                    if (/^(activating|active)$/.test(String(state || '').trim())) {
                        respond(res, 409, { error: 'An update is already running' });
                        return;
                    }
                    execFile('sudo', ['-n', 'systemctl', 'start', '--no-block', UPDATE_UNIT], startErr => {
                        if (startErr) {
                            log('error', `Could not start ${UPDATE_UNIT}: ${String(startErr.message).trim()}`);
                            respond(res, 500, { error: 'The updater is not installed. Run setup.sh once over SSH.' });
                            return;
                        }
                        log('info', `Update to ${rel.latest} started; follow it with: journalctl -u ${UPDATE_UNIT} -f`);
                        respond(res, 200, { ok: true, version: rel.latest });
                    });
                });
            }, true);

        } else {
            respond(res, 404, { error: 'Not found' });
        }
    } catch(e) {
        log('error', `API ${pathname}: ${e.message}`);
        respond(res, 500, { error: e.message });
    }
});

// ── OTA update ────────────────────────────────────────────────────────────────
// Release tags are plain semver. The updater refuses anything else on its own;
// checking here too gives the UI a clear answer instead of a silent no-op.
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const UPDATE_UNIT = 'nibepi-update.service';

// ── Ring buffer sampler ───────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const addr of Object.keys(activeValues)) {
        const a = Number(addr);
        if (!ringBuffer[a]) ringBuffer[a] = [];
        ringBuffer[a].push({ t: now, v: activeValues[a].data });
        if (ringBuffer[a].length > RING_SIZE) {
            // Two-tier compaction: keep last 30 min verbatim + time-uniform history
            // Avoids the exponential-gap bug where buf[0] becomes isolated over many cycles.
            const buf     = ringBuffer[a];
            const nRecent = Math.floor(RING_SIZE / 2);  // 180 pts — last ~30 min at 10 s
            const nHist   = Math.ceil(RING_SIZE / 4);   // 90 pts — uniform over full history
            const recent  = buf.slice(-nRecent);
            const old     = buf.slice(0, buf.length - nRecent);
            const hist    = [];
            if (old.length > 0) {
                const tOldMin = old[0].t;
                const tOldMax = old[old.length - 1].t;
                const count   = Math.min(nHist, old.length);
                const tSpan   = tOldMax - tOldMin;
                let j = 0;
                for (let k = 0; k < count; k++) {
                    const tTarget = tSpan > 0 ? tOldMin + k * tSpan / (count - 1) : tOldMin;
                    while (j < old.length - 1 &&
                           Math.abs(old[j + 1].t - tTarget) < Math.abs(old[j].t - tTarget)) j++;
                    hist.push(old[j]);
                }
            }
            ringBuffer[a] = hist.concat(recent);
        }
    }
}, RING_INTERVAL);

// ── Memory history ────────────────────────────────────────────────────────────
const memHistory    = [];
const MEM_RING_SIZE = 336;       // 14 days × 24 h
const MEM_INTERVAL  = 3_600_000; // 1 h

// Read the backend's RSS straight from the live child PID we hold a handle to.
// Earlier this read /tmp/nibepi_backend.pid, but that file is written once at
// backend startup and never refreshed — so when systemd-tmpfiles sweeps /tmp
// (or a handover removed it), backend RSS silently stuck at 0 forever while the
// backend kept running. core.pid always points at the current live backend.
function backendRss() {
    try {
        if (!core || !core.pid) return 0;
        const status = fs.readFileSync(`/proc/${core.pid}/status`, 'utf8');
        const m      = status.match(/VmRSS:\s*(\d+)/);
        return m ? parseInt(m[1]) * 1024 : 0;
    } catch { return 0; }
}

function sampleMemory() {
    memHistory.push({ t: Date.now(), bridge: process.memoryUsage().rss, backend: backendRss() });
    if (memHistory.length > MEM_RING_SIZE) memHistory.shift();
}

sampleMemory();
setInterval(sampleMemory, MEM_INTERVAL);

// ── GitHub release check ──────────────────────────────────────────────────────
let _cachedRelease = null;
let _cacheTime     = 0;

function checkLatestRelease(cb, force) {
    if (!force && _cachedRelease && Date.now() - _cacheTime < 3_600_000) {
        return cb(null, _cachedRelease);
    }
    const opts = {
        hostname: 'api.github.com',
        path:     `/repos/${GITHUB_REPO}/releases/latest`,
        headers:  { 'User-Agent': 'nibepi-bridge' },
    };
    require('https').get(opts, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
            try {
                const rel  = JSON.parse(body);
                const tag  = rel.tag_name || '';
                const latest = tag.replace(/^v/, '');
                _cachedRelease = {
                    current:    VERSION,
                    latest,
                    tag,
                    url:        rel.tarball_url || '',
                    newer:      latest && latest !== VERSION,
                };
                _cacheTime = Date.now();
                cb(null, _cachedRelease);
            } catch(e) { cb(e); }
        });
    }).on('error', cb);
}

// ── Startup ───────────────────────────────────────────────────────────────────
// Ensure config dir exists
if (!fs.existsSync('/etc/nibepi')) {
    try { fs.mkdirSync('/etc/nibepi', { recursive: true }); } catch {}
}

// Configs written before 1.8.0 hold the web password in clear text.
if (migrateSecrets()) scheduleConfigSave();

// HTTP first — accessible even while pump is offline
server.listen(HTTP_PORT, () => log('info', `NibePi bridge on port ${HTTP_PORT}`));

// Pre-load known model so register table is available immediately
const knownPump = (config.system && config.system.pump) || (config.tcp && config.tcp.pump);
if (knownPump) { pumpModel = knownPump; loadModel(knownPump); }

// Start MQTT
if (config.mqtt && config.mqtt.enable) startMqtt();

// Start serial backend
if (process.env.SKIP_SERIAL) {
    log('warn', 'SKIP_SERIAL set — serial backend not started (test mode).');
} else if (config.connection && config.connection.enable === 'serial') {
    spawnBackend();
}

// Proactive update check: once 30 s after startup, then every 24 h
setTimeout(() => checkLatestRelease(err => { if (!err) broadcast('status', getStatus()); }), 30_000);
setInterval(() => checkLatestRelease(err => { if (!err) broadcast('status', getStatus()); }), 86_400_000);

process.on('uncaughtException',  err => log('error', `Uncaught: ${err.message}`));
process.on('unhandledRejection', err => log('error', `Unhandled: ${err}`));
// Prevent bridge from being accidentally killed if backend.js sends SIGUSR2
// to a recycled PID that happens to be ours.
process.on('SIGUSR2', () => log('warn', 'SIGUSR2 received and ignored (stale PID file guard).'));
