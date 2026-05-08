#!/usr/bin/env node
// Clears stale HA MQTT discovery entries for R/W registers that have been
// migrated to number/switch/select entities. Run once after upgrading.
//
// Usage: node clear_sensor_discovery.js

const fs = require('fs');
const mqtt = require('/home/pi/.node-red/node_modules/mqtt');

const CONFIG_FILE = '/etc/nibepi/config.json';
const NIBEPI_DIR = '/home/pi/.node-red/node_modules/nibepi';

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch(e) {
    console.error('Could not read config: ' + e.message);
    process.exit(1);
}

const models = JSON.parse(fs.readFileSync(NIBEPI_DIR + '/lib/models.json', 'utf8'));

const candidates = [
    config.connection && config.connection.series,
    config.system && config.system.pump,
    config.tcp && config.tcp.pump,
];
const series = candidates.find(s => s && models[s]);
if (!series) {
    console.error('Could not determine pump model from config. Tried: ' + candidates.filter(Boolean).join(', '));
    process.exit(1);
}

const modelRelPath = models[series];

const modelFile = NIBEPI_DIR + '/lib/' + modelRelPath.replace(/^\.\//, '');
const registers = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
const rwRegisters = registers.filter(r => r.mode === 'R/W');

function parseStateMap(info) {
    if (!info) return null;
    const parts = info.split(/(?=\b\d+=)/);
    const pairs = {};
    for (const part of parts) {
        const m = part.match(/^(\d+)=(.+)/);
        if (!m) continue;
        const num = parseInt(m[1]);
        const label = m[2].replace(/,\s*$/, '').trim();
        if (label && !(num in pairs)) pairs[num] = label;
    }
    return Object.keys(pairs).length >= 2 ? pairs : null;
}

function componentFor(reg) {
    const stateMap = parseStateMap(reg.info);
    if (stateMap) {
        const keys = Object.keys(stateMap).map(Number).sort((a,b) => a-b);
        return (keys.length === 2 && keys[0] === 0 && keys[1] === 1) ? 'switch' : 'select';
    }
    return 'number';
}

// For each R/W register, clear the old `sensor` topic and also any previously
// published stale component topic if it differs from the current component.
const staleComponents = ['sensor', 'number', 'switch', 'select'];
const topics = [];
for (const reg of rwRegisters) {
    const current = componentFor(reg);
    for (const comp of staleComponents) {
        if (comp !== current) {
            topics.push('homeassistant/' + comp + '/' + reg.register + '/config');
        }
    }
}

console.log(`Series: ${series} — clearing ${topics.length} stale discovery topics...`);

const mqttOpts = { clean: true };
if (config.mqtt.user) mqttOpts.username = config.mqtt.user;
if (config.mqtt.pass) mqttOpts.password = config.mqtt.pass;

const client = mqtt.connect('mqtt://' + config.mqtt.host + ':' + config.mqtt.port, mqttOpts);

client.on('connect', () => {
    let pending = topics.length;
    for (const topic of topics) {
        client.publish(topic, '', { retain: true }, (err) => {
            if (err) console.error('Failed: ' + topic + ' — ' + err.message);
            if (--pending === 0) {
                console.log('Done.');
                client.end();
            }
        });
    }
});

client.on('error', (err) => {
    console.error('MQTT connection error: ' + err.message);
    process.exit(1);
});
