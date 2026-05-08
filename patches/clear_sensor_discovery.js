#!/usr/bin/env node
// Clears stale HA MQTT discovery entries for R/W registers that have been
// migrated from `sensor` to `number` entities. Run once after upgrading.
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

const series = config.connection && config.connection.series;
if (!series) { console.error('No pump series in config.connection.series'); process.exit(1); }

const models = JSON.parse(fs.readFileSync(NIBEPI_DIR + '/lib/models.json', 'utf8'));
const modelRelPath = models[series];
if (!modelRelPath) { console.error('No model file found for series: ' + series); process.exit(1); }

const modelFile = NIBEPI_DIR + '/lib/' + modelRelPath.replace(/^\.\//, '');
const registers = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
const rwRegisters = registers.filter(r => r.mode === 'R/W');

console.log(`Series: ${series} — clearing ${rwRegisters.length} stale sensor discovery topics...`);

const mqttOpts = { clean: true };
if (config.mqtt.user) mqttOpts.username = config.mqtt.user;
if (config.mqtt.pass) mqttOpts.password = config.mqtt.pass;

const client = mqtt.connect('mqtt://' + config.mqtt.host + ':' + config.mqtt.port, mqttOpts);

client.on('connect', () => {
    let pending = rwRegisters.length;
    for (const reg of rwRegisters) {
        const topic = 'homeassistant/sensor/' + reg.register + '/config';
        // Empty retained message removes the discovery entry from HA
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
