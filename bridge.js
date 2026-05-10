'use strict';

// NibePi bridge — standalone replacement for Node-RED.
// Handles: serial ↔ Modbus ↔ MQTT ↔ HA discovery + HTTP config UI.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { fork, exec: cpExec } = require('child_process');
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
const RING_SIZE     = 360;          // 1 h at 10 s interval
const RING_INTERVAL = 10 * 1000;
const ringBuffer    = {};           // address (number) → [{t, v}, …]

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.ico':  'image/x-icon',
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
let config = (() => {
    try   { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
})();

function deepMerge(target, source) {
    for (const k of Object.keys(source)) {
        if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            deepMerge(target[k], source[k]);
        } else {
            target[k] = source[k];
        }
    }
    return target;
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
            cpExec('sudo mount -o remount,ro /', () => cb && cb(null));
        } else {
            cb && cb(null);
        }
    });
    cpExec('sudo mount -o remount,rw /', err => {
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
let pendingAlarmReset = false;
let alarmResetTimer   = null;
let mqttClient;
let mqttConnected = false;
let mqttDiscovered = new Set();

// ── Alarm reset retry ─────────────────────────────────────────────────────────
function startAlarmReset() {
    if (alarmResetTimer) return;
    if (!alarmResetAddr) return;
    const send = () => {
        if (!alarmValue || !alarmResetAddr || !core || !core.connected) {
            clearInterval(alarmResetTimer);
            alarmResetTimer = null;
            return;
        }
        core.send({ type: 'setData', data: buildWriteFrame(alarmResetAddr, 1) });
        log('warn', `Alarm ${alarmValue} reset write → reg ${alarmResetAddr} (auto-retry).`);
    };
    send();
    alarmResetTimer = setInterval(send, 10000);
}

function stopAlarmReset() {
    if (alarmResetTimer) { clearInterval(alarmResetTimer); alarmResetTimer = null; }
}

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
    core = fork(BACKEND_FILE, { detached: true });
    core.send({ start: true, port });
    core.on('message', onBackendMessage);
    core.on('exit', code => {
        log('warn', `Backend exited (code ${code}), restarting in 5s`);
        pumpConnected = false;
        stopAlarmReset();
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
            pendingAlarmReset = true;
            broadcast('status', getStatus());
            // Re-send full register queue to the new backend process
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

    pendingAlarmReset = true;

    // Enqueue all configured registers + alarm register
    if (config.registers) {
        for (const addr of config.registers) addRegular(addr);
    }
    if (alarmRegAddr) addRegular(alarmRegAddr);
}

// ── F-series frame decoder (ported from index.js decodeMessage) ───────────────
function handleFrame(buf, rmuFlag) {
    if (!buf || buf.length < 5) return;
    if (buf[3] === 109) { handleAnnouncement(buf); return; }
    if (!pumpModel) return;
    if (buf[3] !== 104 && buf[3] !== 106 && buf[3] !== 98 && buf[3] !== 96) return;

    // Deferred alarm reset — sent once after the first real data frame
    if (pendingAlarmReset) {
        pendingAlarmReset = false;
        if (alarmResetAddr && core && core.connected) {
            core.send({ type: 'setData', data: buildWriteFrame(alarmResetAddr, 1) });
            log('info', `Deferred alarm reset sent after first data frame (reg ${alarmResetAddr}).`);
        }
    }

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
        const scaled = data / factor;
        const min    = Number(reg.min);
        const max    = Number(reg.max);

        if (min !== 0 || max !== 0) {
            if (scaled > max / factor || scaled < min / factor) {
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
            if ((alarmValue !== 0) !== (prev !== 0)) {
                broadcast('status', getStatus());
                if (alarmValue !== 0) {
                    if (alarmValue !== 251) {
                        log('warn', `Alarm ${alarmValue} active — starting reset retry.`);
                        startAlarmReset();
                    } else {
                        log('warn', 'Alarm 251 (comm loss) active — requires physical display acknowledgment.');
                    }
                } else {
                    log('info', `Alarm cleared (was ${prev}).`);
                    stopAlarmReset();
                }
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

    const mqtt = require('mqtt');
    const opts = {
        port:            Number(port) || 1883,
        clientId:        'nibepi_' + Math.random().toString(16).slice(2, 10),
        keepalive:       60,
        reconnectPeriod: 5000,
        connectTimeout:  30000,
        clean:           true,
    };
    if (user) opts.username = user;
    if (pass) opts.password = pass;

    mqttClient = mqtt.connect('mqtt://' + host, opts);

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

    mqttClient.on('connect', () => {
        // Re-subscribe after broker restart
        mqttClient.subscribe((config.mqtt.topic || '') + '#');
        mqttDiscovered.clear();
    });
}

function publishMqtt(topic, payload, retain = false) {
    if (mqttClient && mqttConnected) {
        mqttClient.publish(topic, String(payload), { retain });
    }
}

function handleMqttSet(address, value) {
    const reg = regMap[address];
    if (!reg) { log('error', `MQTT set: unknown register ${address}`); return; }
    if (reg.mode !== 'R/W') { log('error', `MQTT set: register ${address} is read-only`); return; }

    const stateMap = parseStateMap(reg.info);
    let numValue;
    if (stateMap) {
        const entry = Object.entries(stateMap).find(([, v]) => v === value);
        numValue = entry ? parseInt(entry[0]) : parseInt(value);
    } else {
        numValue = Math.round(parseFloat(value) * (Number(reg.factor) || 1));
    }
    if (isNaN(numValue)) { log('error', `MQTT set: invalid value '${value}' for register ${address}`); return; }

    log('info', `Set register ${address} (${reg.titel}) = ${numValue} raw`);
    if (core && core.connected) core.send({ type: 'setData', data: buildWriteFrame(address, numValue) });
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

function deviceBlock() {
    return {
        identifiers:  ['nibepi'],
        name:         'Nibe Heat Pump',
        model:        pumpModel || (config.system && config.system.pump) || 'unknown',
        manufacturer: 'NIBE',
    };
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
            unit_of_measurement: reg.unit || undefined,
            device: deviceBlock(),
        };
        if (stateMap) {
            const fwd = Object.entries(stateMap).map(([k, v]) => `${k}: '${v}'`).join(', ');
            payload.value_template = `{%- set m = {${fwd}} -%}{{ m.get(value|int, value) }}`;
            delete payload.device_class;
            delete payload.unit_of_measurement;
        }
    }

    // Strip undefined fields
    for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k]; }

    publishMqtt(`homeassistant/${component}/${address}/config`, JSON.stringify(payload), true);
    mqttDiscovered.add(address);
    log('info', `Discovery: ${component} ${address} (${reg.titel})`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function getStatus() {
    return {
        connected:    pumpConnected,
        model:        pumpModel,
        firmware:     pumpFirmware,
        mqttConnected,
        readonly:     !!(config.system && config.system.readonly),
        version:      VERSION,
        alarm:        alarmValue,
        canReset:     alarmResetAddr !== null && alarmValue !== 251,
        isCommLoss:   alarmValue === 251,
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

function respond(res, status, data) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const urlObj   = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Static UI files ───────────────────────────────────────────────────────
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const filePath = pathname === '/'
            ? path.join(UI_DIR, 'index.html')
            : path.join(UI_DIR, pathname);
        if (!filePath.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
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
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(':\n\n');
        eventSseClients.add(res);
        sendSse(res, 'status', getStatus());
        if (Object.keys(ringBuffer).length > 0) sendSse(res, 'history', ringBuffer);
        req.on('close', () => eventSseClients.delete(res));
        return;
    }

    // ── SSE: log stream ───────────────────────────────────────────────────────
    if (pathname === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(':\n\n');
        logSseClients.add(res);
        for (const line of logBuffer) sendSse(res, 'log', line);
        req.on('close', () => logSseClients.delete(res));
        return;
    }

    // ── REST API ──────────────────────────────────────────────────────────────
    try {
        if (pathname === '/api/alarms' && req.method === 'GET') {
            fs.readFile(ALARMS_FILE, (err, data) => {
                if (err) respond(res, 404, { error: 'Alarm list not found' });
                else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data); }
            });

        } else if (pathname === '/api/config' && req.method === 'GET') {
            respond(res, 200, config);

        } else if (pathname === '/api/config' && req.method === 'POST') {
            const body = await readBody(req);
            const prevMqttEnable = config.mqtt && config.mqtt.enable;
            deepMerge(config, body);
            scheduleConfigSave();
            const newMqttEnable = config.mqtt && config.mqtt.enable;
            if (newMqttEnable && (!mqttConnected || !prevMqttEnable)) startMqtt();
            else if (!newMqttEnable && mqttClient) { try { mqttClient.end(true); } catch {} mqttConnected = false; }
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
            respond(res, 200, { ok: true });

        } else if (pathname === '/api/alarm/reset' && req.method === 'POST') {
            if (!core || !core.connected) {
                respond(res, 409, { error: 'Pump not connected' }); return;
            }
            if (!alarmResetAddr || alarmValue === 251) {
                respond(res, 409, { error: 'No alarm reset register available' }); return;
            }
            core.send({ type: 'setData', data: buildWriteFrame(alarmResetAddr, 1) });
            log('warn', `Alarm ${alarmValue} reset manually triggered → reg ${alarmResetAddr}.`);
            startAlarmReset();
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
                cpExec('sudo systemctl restart bridge', err => {
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
            const cmd = readonly ? 'sudo mount -o remount,ro /' : 'sudo mount -o remount,rw /';
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
                if (body.user) { opts.username = body.user; opts.password = body.pass || ''; }
                const tc = mqttLib.connect(url, opts);
                let done = false;
                const finish = (ok, msg) => { if (done) return; done = true; tc.end(true); respond(res, 200, { ok, error: msg }); };
                tc.on('connect', () => finish(true));
                tc.on('error',   e  => finish(false, e.message));
                setTimeout(()       => finish(false, 'Timeout'), 6000);
            }).catch(err => respond(res, 500, { error: err.message }));

        } else if (pathname === '/api/version' && req.method === 'GET') {
            respond(res, 200, { current: VERSION });

        } else if (pathname === '/api/version/check' && req.method === 'GET') {
            checkLatestRelease((err, info) => {
                if (err) { respond(res, 502, { error: err.message }); return; }
                respond(res, 200, info);
            });

        } else if (pathname === '/api/update' && req.method === 'POST') {
            const { url, version: nextVer } = await readBody(req);
            if (!url) { respond(res, 400, { error: 'Missing url' }); return; }
            respond(res, 200, { ok: true });
            log('info', `OTA update to ${nextVer || '?'} from ${url}`);
            const script = [
                'set -e',
                'sudo mount -o remount,rw /',
                'rm -rf /tmp/nibepi-ota /tmp/nibepi-ota.tar.gz',
                `wget -qO /tmp/nibepi-ota.tar.gz "${url}"`,
                'mkdir -p /tmp/nibepi-ota',
                'tar -xf /tmp/nibepi-ota.tar.gz -C /tmp/nibepi-ota --strip-components=1',
                'D=/tmp/nibepi-ota',
                'cp "$D/bridge.js"    /opt/nibepi/bridge.js',
                'cp "$D/backend.js"   /opt/nibepi/backend.js',
                'cp "$D/package.json" /opt/nibepi/package.json',
                'sudo chmod -R u+w /opt/nibepi/ui /opt/nibepi/lib /opt/nibepi/models 2>/dev/null || true',
                'sudo rm -rf /opt/nibepi/ui /opt/nibepi/lib /opt/nibepi/models',
                'sudo cp -r "$D/ui"        /opt/nibepi/ui',
                'sudo cp -r "$D/lib"       /opt/nibepi/lib',
                'sudo cp -r "$D/models"    /opt/nibepi/models',
                'sudo cp "$D/patches/bridge.service" /etc/systemd/system/bridge.service',
                // Cleanup steps are best-effort — don't let them abort before the restart
                'set +e',
                'sudo systemctl daemon-reload',
                'sudo mount -o remount,ro /',
                'rm -rf /tmp/nibepi-ota /tmp/nibepi-ota.tar.gz',
                'set -e',
                'sudo systemctl restart bridge',
            ].join('\n');
            try { fs.unlinkSync('/tmp/nibepi-ota.sh'); } catch(e) {}
            fs.writeFileSync('/tmp/nibepi-ota.sh', script, { mode: 0o755 });
            // Detach so the script survives bridge.js being killed by systemctl restart
            cpExec('nohup bash /tmp/nibepi-ota.sh > /tmp/nibepi-ota.log 2>&1 &');

        } else {
            respond(res, 404, { error: 'Not found' });
        }
    } catch(e) {
        log('error', `API ${pathname}: ${e.message}`);
        respond(res, 500, { error: e.message });
    }
});

// ── Ring buffer sampler ───────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const addr of Object.keys(activeValues)) {
        const a = Number(addr);
        if (!ringBuffer[a]) ringBuffer[a] = [];
        ringBuffer[a].push({ t: now, v: activeValues[a].data });
        if (ringBuffer[a].length > RING_SIZE) ringBuffer[a].shift();
    }
}, RING_INTERVAL);

// ── GitHub release check ──────────────────────────────────────────────────────
let _cachedRelease = null;
let _cacheTime     = 0;

function checkLatestRelease(cb) {
    if (_cachedRelease && Date.now() - _cacheTime < 3_600_000) {
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

process.on('uncaughtException',  err => log('error', `Uncaught: ${err.message}`));
process.on('unhandledRejection', err => log('error', `Unhandled: ${err}`));
// Prevent bridge from being accidentally killed if backend.js sends SIGUSR2
// to a recycled PID that happens to be ours.
process.on('SIGUSR2', () => log('warn', 'SIGUSR2 received and ignored (stale PID file guard).'));
