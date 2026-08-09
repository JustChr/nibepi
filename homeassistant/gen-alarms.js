#!/usr/bin/env node
/*
 * Regenerates the alarm code tables that the Home Assistant integration needs,
 * from the single source of truth in lib/alarms.json:
 *
 *   1. the ALARM_TABLE constant in nibepi-card.js  (compact "code:text|..." string)
 *   2. the "names" dict in packages/nibepi.yaml     (Jinja dict, between markers)
 *
 * Run from anywhere after editing lib/alarms.json:
 *     node homeassistant/gen-alarms.js
 */
const fs   = require('fs');
const path = require('path');

const root   = path.resolve(__dirname, '..');
const alarms = require(path.join(root, 'lib', 'alarms.json'));

const cardFile = path.join(__dirname, 'nibepi-card.js');
const pkgFile  = path.join(__dirname, 'packages', 'nibepi.yaml');

// Straight apostrophes would terminate the Jinja string literals, and "|" and ":"
// are the card table's separators. Normalise all three out of the alarm texts.
const clean = text => String(text).replace(/[|:]/g, '/').replace(/'/g, '’').trim();

const entries = Object.entries(alarms)
    .map(([code, text]) => [Number(code), clean(text)])
    .filter(([code]) => Number.isFinite(code))
    .sort((a, b) => a[0] - b[0]);

// ── 1. the card ─────────────────────────────────────────────────────────────
{
    const table   = entries.map(([c, t]) => `${c}:${t}`).join('|');
    const literal = JSON.stringify(table);
    const re      = /^const ALARM_TABLE = (?:'[^']*'|"(?:[^"\\]|\\.)*");$/m;

    let src = fs.readFileSync(cardFile, 'utf8');
    if (!re.test(src)) {
        console.error(`gen-alarms: ALARM_TABLE declaration not found in ${path.basename(cardFile)}`);
        process.exit(1);
    }
    src = src.replace(re, `const ALARM_TABLE = ${literal};`);
    fs.writeFileSync(cardFile, src);
    console.log(`gen-alarms: nibepi-card.js  ← ${entries.length} codes (${table.length} chars)`);
}

// ── 2. the package ──────────────────────────────────────────────────────────
{
    const BEGIN = '{# GENERATED-ALARM-MAP-BEGIN #}';
    const END   = '{# GENERATED-ALARM-MAP-END #}';
    const dict  = entries.map(([c, t]) => `${c}: '${t}'`).join(', ');

    let src = fs.readFileSync(pkgFile, 'utf8');
    const i = src.indexOf(BEGIN);
    const j = src.indexOf(END);
    if (i < 0 || j < 0 || j < i) {
        console.error(`gen-alarms: alarm map markers not found in ${path.basename(pkgFile)}`);
        process.exit(1);
    }
    // Preserve the indentation the marker sits at, so the YAML block scalar stays valid.
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const indent    = src.slice(lineStart, i);

    src = src.slice(0, i + BEGIN.length)
        + `\n${indent}{% set names = {${dict}} %}\n${indent}`
        + src.slice(j);
    fs.writeFileSync(pkgFile, src);
    console.log(`gen-alarms: packages/nibepi.yaml ← ${entries.length} codes (${dict.length} chars)`);
}
