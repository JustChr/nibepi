/*
 * nibepi-flow-card — live hydraulic schematic for NIBE heat pumps
 * Part of the NibePi project (https://github.com/JustChr/nibepi) · MIT
 *
 * Drawn the way the pump's own documentation draws it: a single-line hydraulic
 * schematic with NIBE's component designations (EB100, EP14, GP1, GP2, QN10) and
 * sensor tags (BT2, BT3, BT6, BT7, BT10, BT11, BT50) annotating the measuring
 * points, the borehole below a hatched ground line, and the refrigerant circuit
 * — evaporator, compressor, condenser, expansion valve — inside the machine
 * outline, so the drawing shows how the heat actually gets from the ground to
 * the radiators.
 *
 * The schematic exists in two hand-drawn geometries rather than one that
 * squashes: LANDSCAPE for a wide card, and PORTRAIT — same circuit, same tags,
 * ground at the bottom and the house at the top — for a phone. A ResizeObserver
 * on the card's own box picks one, so a narrow dashboard column on a big screen
 * gets the portrait drawing too. Landscape takes over at `wide_at` px of card
 * content width (900 by default); `layout: wide` or `layout: tall` pins one
 * geometry and ignores the measurement entirely. Nothing scrolls sideways:
 * portrait lands at roughly 1:1 on the narrowest iPhone still in service, and
 * landscape scales to fit whatever width it is given.
 *
 * The alarm code table below is generated from lib/alarms.json — do not hand-edit
 * it. After changing lib/alarms.json, regenerate with:
 *     node homeassistant/gen-alarms.js
 */

const CARD_VERSION = '3.2.0';

// Card content width, in px, at which the landscape sheet takes over. The
// landscape drawing is 1040 units wide, so below this it renders at under ~0.87×
// and its 10.5 px captions start to get tight; override with `wide_at`.
const WIDE_AT = 900;
const NARROW_AT = 640;

const ALARM_TABLE = "1:Sensor fault BT1|2:Sensor fault BT2|3:Sensor fault BT3|6:Sensor fault BT6|7:Sensor fault BT7|10:Sensor fault BT10|11:Sensor fault BT11|12:Sensor fault BT12|16:Sensor fault BT16|20:Sensor fault BT20 (AZ1)|21:Sensor fault BT21 (AZ1)|22:Sensor fault DEW-BT6|25:Sensor fault BT25|26:Sensor fault AZ1-BT26|27:Sensor fault BP8|28:Sensor fault BT71|29:Sensor fault BT29|31:Sensor fault BT63|32:Sensor fault BS1|33:Sensor fault EP30-BT53|34:Sensor fault EP30-BT53 (solar)|35:Sensor fault EM1-BT52|37:Sensor fault EP21-BT2|38:Sensor fault EP22-BT2|39:Sensor fault EP23-BT2|40:Sensor fault EQ1-BT64|41:Compressor phase 1 missing|42:Compressor phase 2 missing|43:Faulty phase sequence|44:Overheated softstart|45:Phase fault|50:High pressure alarm|54:Motor protection alarm|55:Hot gas alarm|56:Incorrect serial number|57:Incorrect firmware|58:Pressure switch|60:Low HTF out|63:Low air flow|64:Low exhaust air temperature|65:High condensation water level|66:High condensation water level (container)|67:Antifreeze protection supply air|69:Non-calibrated air flow sensor|70:Perm. com. error input card|71:Perm. com. error base card|72:Perm. com. error softstart card|73:Perm. com. error heating system 2|74:Perm. com. error heating system 3|75:Perm. com. error base card (AA26)|76:Perm. com. error heating system 4|77:Perm. com. error additive with shunt|78:Perm. com. error pool|79:Perm. com. error FLM|83:Unsuccessful defrosting|86:Perm. com. error SAM 40|87:Perm. com. error step controlled additive|88:Perm. com. error Solar|89:Perm. com. error HPAC|90:Perm. com. fault groundwater pump|91:Perm. com. error HWC|92:Perm. com. error DEW|93:Perm. com. error 2-pipes cooling|94:Perm. com. error PCD4|95:Perm. com. error FJVM|96:Perm. com. room unit zone 1|97:Perm. com. room unit zone 2|98:Perm. com. room unit zone 3|99:Perm. com. room unit zone 4|100:Perm. com. error inverter|101:Sensor fault BT1 (temp.)|102:Sensor fault BT2 (temp.)|103:Sensor fault BT3 (temp.)|104:Sensor fault BT4 (temp.)|105:Sensor fault BT5 (temp.)|106:Sensor fault BT6 (temp.)|107:Sensor fault BT7 (temp.)|108:Sensor fault BT8 (temp.)|109:Sensor fault BT9 (temp.)|110:Sensor fault BT10 (temp.)|111:Sensor fault BT11 (temp.)|112:Sensor fault BT12 (temp.)|113:Sensor fault BT13 (temp.)|114:Sensor fault BT14 (temp.)|115:Sensor fault BT15 (temp.)|116:Sensor fault BT16 (temp.)|117:Sensor fault BT17 (temp.)|118:Sensor fault BT18 (temp.)|119:Sensor fault BT19 (temp.)|120:Sensor fault BT20 (temp.)|140:Compressor phase 1 missing (temp.)|141:Compressor phase 2 missing (temp.)|142:Compressor phase 3 missing (temp.)|145:Temporary general phase fault|150:High condensor out|155:Hot gas alarm (temp.)|158:Low defrost temperature|159:High evaporator temperature|160:Low HTF out (temp.)|161:High HTF in|162:High condensor out (temp.)|163:High condensor in|164:Low exhaust air temperature (temp.)|166:Electrical anode incorrect|170:Com. error input card|171:Com. error base card|172:Com. error softstart card|173:Com. error heating system 2|174:Com. error heating system 3|175:Start-up of softstart card|176:Com. error heating system 4|177:Com. error addition with mixing valve|178:Com. error pool|179:Com. error FLM|180:Freeze protection|181:Failed periodic increase|182:Load monitor activated|183:Defrosting|184:Filter alarm|185:Anti-freeze supply air|187:Com. error step controlled additional heat|188:Com. fault solar|189:Com. error HPAC|190:Com. error ground water pump|191:Com. error HWC|192:Com. error 2 pipe cooling|193:Com. error DEW|194:Com. error PCD4|195:Com. error FJVM|196:Com. room unit zone 1|197:Com. room unit zone 2|198:Com. room unit zone 3|199:Com. room unit zone 4|200:Com. error inverter|201:Inverter alarm|202:Inverter fault|203:Inverter error type I (perm.)|204:Inverter error type II (perm.)|205:Inverter error type III (perm.)|206:Perm. com. error HW-comfort|207:Com. error HW-comfort|208:Com. error Acc-EB1|209:Com. error ACC-EPxx|213:Inverter error type I (temp.)|214:Inverter error type II (temp.)|215:Inverter error type III (temp.)|216:Inverter alarm type II|220:High pressure alarm (outdoor unit)|221:Low pressure alarm (outdoor unit)|222:Motor protection alarm (outdoor unit)|223:Communication alarm (outdoor unit)|224:Fan error (outdoor unit)|225:Flow/return error (outdoor unit)|227:Sensor fault (outdoor unit)|228:Defrost fault (outdoor unit)|229:Short compressor operation times|230:Hot gas alarm (outdoor unit)|231:Phase sequence error (outdoor unit)|232:Low evaporation (outdoor unit)|236:Sensor fault AZ2-BT20|237:Sensor fault AZ2-BT21|238:Sensor fault AZ2-BT26|239:Sensor fault AZ3-BT20|240:Sensor fault AZ3-BT21|241:Sensor fault AZ3-BT26|242:Sensor fault AZ4-BT20|243:Sensor fault AZ4-BT21|244:Sensor fault AZ4-BT26|245:Com. error FLM 2|247:Com. error FLM 4|248:Communication fault (display/base card)|250:Com. error ACC-SMS 40|251:Com. error ACC Modbus 40|252:Com. error slave|253:Sensor fault QZ1-BT70|255:Motor protection alarm, brine pump|257:Com. error ACS45|258:Sensor fault EQ1-BT57|259:Sensor fault EQ1-BT75|261:Temperature deviation heat exchanger sensor|262:Overheat power transistor|263:Incorrect voltage from inverter|264:Com. error inverter circuit board|265:Continuous error on power transistor|266:Low refrigerant amount|267:Inverter fault, boot failure|268:Overcurrent, inverter A/F module|270:Compressor preheating active|271:Cold outdoor air (EB101)|272:Hot outdoor air (EB101)|273:HW-start/stop reset to factory settings|274:Compressor phase overloaded|275:Compressor phase overloaded (longtime)|277:Sensor fault MHI exchanger|278:Sensor fault MHI ambient air|279:Sensor fault MHI discharge|280:Sensor fault MHI suction|281:Sensor fault MHI LP|282:Com. error ACC-EQ1 (temp.)|283:Com. error ACC-EQ1 (perm.)|290:Fan alarm|291:Charge pump alarm|294:Not compatible heat pump|299:Wrong version PCA Base|301:Com. error slave 1|302:Com. error slave 2|303:Com. error slave 3|304:Com. error slave 4|305:Com. error slave 5|306:Com. error slave 6|307:Com. error slave 7|308:Com. error slave 8|325:Temperature limiter alarm (defrost element)|326:Fault in EB16 (defrost failed)|340:Anti-freeze supply air (BT22)|351:Uncertain sensor accuracy (brine)|352:Uncertain sensor accuracy (HM BT2/BT3)|353:Uncertain sensor accuracy (HM BT3/BT12)|354:Uncertain sensor accuracy, slave EB101|355:Uncertain sensor accuracy (BT3/BT63)|356:Failed sensor calibration|372:Perm. com. error pool 2|403:Sensor fault on EB101 (MHI-EMMY)|404:Sensor fault on EB101 (MHI-EMMY, type 2)|412:Sensor fault on EB101-BT12|415:Sensor fault on EB101-BT15|420:Inverter alarm type II (temp. comm)|421:Inverter alarm type II (perm. comm)|422:Inverter alarm type II (ext. input)|423:Inverter alarm type II (ext. input, perm.)|425:Triggered pressure switch|426:Inverter alarm type III (temp.)|427:Inverter alarm type III (perm.)|428:Inverter alarm type III (internal, temp.)|429:Inverter alarm type II (internal, perm.)|430:Inverter alarm type I (phase too high)|431:Inverter alarm type I (phase too high, perm.)|432:Inverter alarm type I (phase too low)|433:Inverter alarm type I (phase too low, perm.)|434:Inverter alarm type I (phase missing)|435:Inverter alarm type I (phase missing, perm.)|436:Inverter alarm type II (internal fault)|437:Inverter alarm type II (internal fault, perm.)|438:Inverter alarm type II (overtemperature)|439:Inverter alarm type II (overtemperature, perm.)|440:Inverter alarm type II (power in too high)|441:Inverter alarm type II (power in, perm.)|442:Inverter alarm type II (max temp)|443:Inverter alarm type II (max temp, perm.)|444:Inverter alarm type II (internal)|445:Inverter alarm type II (internal, perm.)|446:Inverter alarm type II (phase missing)|447:Inverter alarm type II (phase missing, perm.)|448:Inverter alarm type II (below min speed)|449:Inverter alarm type II (below min speed, perm.)|452:Inverter alarm type II (power out too high)|453:Inverter alarm type II (power out, perm.)|454:Inverter alarm type II (high output)|455:Inverter alarm type II (high output, perm.)|460:Inverter alarm type II (1-phase power in)|461:Inverter alarm type II (1-phase, perm.)|995:External alarm (AUX input)|996:External addition heat blocked|997:External compressor blocked|998:Display/machine restart";

const ALARMS = (() => {
    const out = {};
    if (ALARM_TABLE.startsWith('__')) return out;
    for (const part of ALARM_TABLE.split('|')) {
        const i = part.indexOf(':');
        if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    }
    return out;
})();

const LABELS = {
    en: {
        heatpump: 'Heat pump', outdoor: 'Outdoor', avg: 'avg', idle: 'Idle', alarm: 'Alarm',
        cGround: 'Ground loop', cEvap: 'Evaporator', cCompressor: 'Compressor',
        cCond: 'Condenser', cValve: 'Expansion valve', cValveShort: 'Exp. valve',
        cHeating: 'Heating system', cHotwater: 'Hot water',
        sHeat: 'Heat output', sPower: 'Electrical input', sCop: 'COP', sCopToday: 'COP today',
        demand: 'House heat demand', demandUnit: 'DM',
        demandStart: 'Compressor starts at {n} DM',
        demandNone: 'No heat demand — supply is at or above target',
        demandNote: 'Degree minutes accumulate how far the supply temperature sits below its '
            + 'calculated target. The higher the number, the more heat the house is short of.',
        demandSatisfied: 'Below the start threshold',
        demandCalling: 'Above the start threshold',
        gHeating: 'Heating circuit', gHotwater: 'Hot water', gBrine: 'Ground loop',
        gCompressor: 'Compressor', gAdd: 'Immersion heater', gPower: 'Electrical',
        gEnergy: 'Energy', gSignals: 'Control signals',
        supply: 'Supply', return: 'Return', dt_actual: 'ΔT actual', dt_set: 'ΔT set point',
        supply_calc: 'Calculated supply', flow: 'Flow', supply_pump: 'Heat medium pump',
        curve: 'Heat curve', curve_offset: 'Curve offset', use_room_sensor: 'Room sensor',
        room: 'Room', room_set: 'Room set point',
        hw_top: 'Tank top', hw_load: 'Charge temperature', hw_mode: 'Comfort mode',
        hw_temporary: 'Temporary increase',
        brine_in: 'Brine in', brine_out: 'Brine out', brine_pump: 'Brine pump',
        compressor_hz: 'Frequency', compressor_request: 'Frequency requested',
        compressor_state: 'State', compressor_starts: 'Starts',
        runtime_compressor: 'Run hours', runtime_compressor_hw: 'Run hours, hot water',
        add_power: 'Power', add_state: 'Active steps', runtime_add: 'Run hours',
        power_in: 'Compressor input', current_l1: 'Current L1', current_l2: 'Current L2',
        current_l3: 'Current L3',
        energy_heating_today: 'Heating produced today', energy_hw_today: 'Hot water produced today',
        energy_electric_today: 'Electricity used today', cop_today: 'COP today', cop_month: 'COP this month',
        prio: 'Priority', smart_home_mode: 'Smart home mode', sg_ready: 'SG Ready',
        holiday: 'Holiday mode', degree_minutes: 'Degree minutes',
        prioMap: { 10: 'Off', 20: 'Hot water', 30: 'Heating', 40: 'Pool', 41: 'Pool 2', 50: 'Transfer', 60: 'Cooling' },
        cprMap: { 20: 'Stopped', 40: 'Starting', 60: 'Running', 100: 'Stopping' },
    },
    de: {
        heatpump: 'Wärmepumpe', outdoor: 'Außen', avg: 'Mittel', idle: 'Bereitschaft', alarm: 'Alarm',
        cGround: 'Erdsonde', cEvap: 'Verdampfer', cCompressor: 'Verdichter',
        cCond: 'Kondensator', cValve: 'Expansionsventil', cValveShort: 'Exp.ventil',
        cHeating: 'Heizsystem', cHotwater: 'Warmwasser',
        sHeat: 'Wärmeleistung', sPower: 'Stromaufnahme', sCop: 'COP', sCopToday: 'COP heute',
        demand: 'Wärmebedarf des Hauses', demandUnit: 'GM',
        demandStart: 'Verdichter startet bei {n} GM',
        demandNone: 'Kein Wärmebedarf — Vorlauf liegt auf oder über dem Sollwert',
        demandNote: 'Gradminuten summieren, wie weit der Vorlauf unter seinem berechneten '
            + 'Sollwert liegt. Je höher der Wert, desto mehr Wärme fehlt dem Haus.',
        demandSatisfied: 'Unter der Startschwelle',
        demandCalling: 'Über der Startschwelle',
        gHeating: 'Heizkreis', gHotwater: 'Warmwasser', gBrine: 'Sole',
        gCompressor: 'Verdichter', gAdd: 'Zusatzheizung', gPower: 'Elektrik',
        gEnergy: 'Energie', gSignals: 'Steuersignale',
        supply: 'Vorlauf', return: 'Rücklauf', dt_actual: 'ΔT ist', dt_set: 'ΔT soll',
        supply_calc: 'Berechneter Vorlauf', flow: 'Durchfluss', supply_pump: 'Heizungspumpe',
        curve: 'Heizkurve', curve_offset: 'Kurvenoffset', use_room_sensor: 'Raumfühler',
        room: 'Raum', room_set: 'Raum Soll',
        hw_top: 'Speicher oben', hw_load: 'Ladetemperatur', hw_mode: 'Komfortmodus',
        hw_temporary: 'Temporäre Erhöhung',
        brine_in: 'Sole ein', brine_out: 'Sole aus', brine_pump: 'Solepumpe',
        compressor_hz: 'Frequenz', compressor_request: 'Frequenz angefordert',
        compressor_state: 'Status', compressor_starts: 'Starts',
        runtime_compressor: 'Betriebsstunden', runtime_compressor_hw: 'Betriebsstunden Warmwasser',
        add_power: 'Leistung', add_state: 'Aktive Stufen', runtime_add: 'Betriebsstunden',
        power_in: 'Verdichteraufnahme', current_l1: 'Strom L1', current_l2: 'Strom L2',
        current_l3: 'Strom L3',
        energy_heating_today: 'Heizung erzeugt heute', energy_hw_today: 'Warmwasser erzeugt heute',
        energy_electric_today: 'Strom verbraucht heute', cop_today: 'COP heute', cop_month: 'COP Monat',
        prio: 'Priorität', smart_home_mode: 'Smart-Home-Modus', sg_ready: 'SG Ready',
        holiday: 'Urlaubsmodus', degree_minutes: 'Gradminuten',
        prioMap: { 10: 'Aus', 20: 'Warmwasser', 30: 'Heizung', 40: 'Pool', 41: 'Pool 2', 50: 'Transfer', 60: 'Kühlung' },
        cprMap: { 20: 'Gestoppt', 40: 'Startet', 60: 'Läuft', 100: 'Stoppt' },
    },
};

// Prio arrives as text when NibePi could parse the register's state map, and as a
// bare number when it could not. Normalise both to the numeric code.
const PRIO_TEXT = {
    off: 10, 'hot water': 20, heat: 30, pool: 40, 'pool 2': 41, transfer: 50, cooling: 60,
};

// ── schematic geometry ───────────────────────────────────────────────────────
// Two hand-drawn layouts of the same circuit. Both use the same pipe keys, the
// same temperature source per pipe and the same driving pump, so one paint pass
// serves either. `temp` names the entity whose value colours that pipe; `pump` is
// which circulation pump sets its dash speed; `branch` marks the legs that dim
// when Prio has selected the other consumer.
const LAYOUTS = {
    // ── landscape: ground on the left, house on the right ────────────────────
    wide: {
        viewBox: '0 0 1040 500',
        pipes: {
            brine_flow: {
                d: 'M114 378 A22 22 0 0 1 70 378 V162 H280',
                temp: 'brine_in', pump: 'brine', arrows: [[70, 300, -90], [242, 162, 0]],
            },
            brine_ret: {
                d: 'M280 202 H114 V378',
                temp: 'brine_out', pump: 'brine', arrows: [[198, 202, 180], [114, 300, 90]],
            },
            hm_sup: { d: 'M572 162 H700', temp: 'supply', pump: 'hm', arrows: [[686, 162, 0]] },
            heat_sup: {
                d: 'M725 162 H802 V140 H852', temp: 'supply', pump: 'hm',
                arrows: [[836, 140, 0]], branch: 'heating',
            },
            heat_ret: {
                d: 'M990 190 H1015 V470 H616 V202 H572', temp: 'return', pump: 'hm',
                arrows: [[1015, 340, 90], [700, 470, 180]], branch: 'heating',
            },
            hw_sup: {
                d: 'M712 175 V344 H872', temp: 'supply', pump: 'hm',
                arrows: [[712, 290, 90]], branch: 'hotwater',
            },
            hw_ret: {
                d: 'M872 404 H812 V470 H616 V202 H572', temp: 'return', pump: 'hm',
                arrows: [[812, 440, 90]], branch: 'hotwater',
            },
        },
        refrigerant: [
            { id: 'ref1', d: 'M306 152 V134 H401', arrows: [[368, 134, 0]] },
            { id: 'ref2', d: 'M453 134 H548 V152', arrows: [[502, 134, 0]] },
            { id: 'ref3', d: 'M548 214 V320 H443', arrows: [[548, 278, 90]] },
            { id: 'ref4', d: 'M411 320 H306 V214', arrows: [[360, 320, 180]] },
        ],
    },

    // ── portrait: ground at the bottom, house at the top, trunks up the sides ──
    tall: {
        viewBox: '0 0 340 1010',
        pipes: {
            brine_flow: {
                d: 'M210 960 A30 30 0 0 1 150 960 V812 H180 V766',
                temp: 'brine_in', pump: 'brine', arrows: [[150, 900, -90], [180, 790, -90]],
            },
            brine_ret: {
                d: 'M200 766 V812 H210 V960',
                temp: 'brine_out', pump: 'brine', arrows: [[210, 900, 90]],
            },
            hm_sup: {
                d: 'M200 482 V440 H310 V412', temp: 'supply', pump: 'hm',
                arrows: [[288, 440, 0]],
            },
            heat_sup: {
                d: 'M310 388 V66 H286', temp: 'supply', pump: 'hm',
                arrows: [[310, 150, -90]], branch: 'heating',
            },
            heat_ret: {
                d: 'M54 66 H30 V440 H180 V482', temp: 'return', pump: 'hm',
                arrows: [[30, 140, 90]], branch: 'heating',
            },
            hw_sup: {
                d: 'M298 400 V230 H250', temp: 'supply', pump: 'hm',
                arrows: [[298, 320, -90]], branch: 'hotwater',
            },
            hw_ret: {
                d: 'M90 302 H30 V440 H180 V482', temp: 'return', pump: 'hm',
                arrows: [[30, 380, 90]], branch: 'hotwater',
            },
        },
        refrigerant: [
            { id: 'ref1', d: 'M74 748 H286', arrows: [[254, 748, 0]] },
            { id: 'ref2', d: 'M286 748 V500', arrows: [[286, 700, -90]] },
            { id: 'ref3', d: 'M286 500 H74', arrows: [[110, 500, 180]] },
            { id: 'ref4', d: 'M74 500 V748', arrows: [[74, 560, 90]] },
        ],
    },
};

const VARIANTS = ['wide', 'tall'];

// Detail groups, rendered in order. A group disappears when none of its entities
// resolve, so an unconfigured register costs nothing.
const GROUPS = [
    ['gHeating', ['supply', 'return', 'dt_actual', 'dt_set', 'supply_calc', 'flow',
        'supply_pump', 'room', 'room_set', 'curve', 'curve_offset', 'use_room_sensor']],
    ['gHotwater', ['hw_top', 'hw_load', 'hw_mode', 'hw_temporary', 'runtime_compressor_hw']],
    ['gBrine', ['brine_in', 'brine_out', 'brine_pump']],
    ['gCompressor', ['compressor_hz', 'compressor_request', 'compressor_state',
        'compressor_starts', 'runtime_compressor', 'degree_minutes']],
    ['gAdd', ['add_power', 'add_state', 'runtime_add']],
    ['gPower', ['power_in', 'current_l1', 'current_l2', 'current_l3']],
    ['gEnergy', ['energy_heating_today', 'energy_hw_today', 'energy_electric_today',
        'cop_today', 'cop_month']],
    ['gSignals', ['prio', 'smart_home_mode', 'sg_ready', 'holiday']],
];

const TEMP_STOPS = [
    [-25, [31, 78, 121]], [-5, [47, 128, 201]], [8, [79, 176, 224]],
    [20, [79, 191, 139]], [32, [224, 178, 60]], [45, [224, 123, 57]], [65, [210, 76, 60]],
];

function tempColor(v) {
    if (v === null || Number.isNaN(v)) return 'var(--disabled-text-color, #8a8a8a)';
    const s = TEMP_STOPS;
    if (v <= s[0][0]) return `rgb(${s[0][1].join(',')})`;
    if (v >= s[s.length - 1][0]) return `rgb(${s[s.length - 1][1].join(',')})`;
    for (let i = 0; i < s.length - 1; i++) {
        const [a, ca] = s[i], [b, cb] = s[i + 1];
        if (v >= a && v <= b) {
            const t = (v - a) / (b - a);
            return `rgb(${ca.map((x, j) => Math.round(x + (cb[j] - x) * t)).join(',')})`;
        }
    }
    return 'var(--primary-text-color)';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v, d = 1) => (v === null || Number.isNaN(v) ? '–' : v.toFixed(d));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Serpentine tank heat exchanger: `passes` horizontal runs joined by rounded
 *  returns that bulge outward. `fromRight` picks the side the coil starts on, so
 *  it can be attached to whichever side the supply pipe actually arrives from;
 *  with an even number of passes it finishes on the other side, with an odd
 *  number it comes back to the same one. */
function coilPath(xL, xR, yTop, gap, passes, fromRight = true) {
    let x = fromRight ? xR : xL;
    let d = `M${x} ${yTop}`;
    for (let i = 0; i < passes; i++) {
        const y = yTop + i * gap;
        const to = x === xR ? xL : xR;
        d += ` H${to}`;
        if (i < passes - 1) {
            const sweep = to === xR ? 1 : 0;
            d += ` A${gap / 2} ${gap / 2} 0 0 ${sweep} ${to} ${y + gap}`;
        }
        x = to;
    }
    return d;
}

class NibepiFlowCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._built = false;
        this._sig = null;
    }

    static getStubConfig() {
        return {
            type: 'custom:nibepi-flow-card',
            language: 'en',
            entities: {
                outdoor: 'sensor.nibe_heat_pump_nibe_bt1_outdoor_temperature',
                supply: 'sensor.nibe_heat_pump_nibe_bt2_supply_temp_s1',
                return: 'sensor.nibe_heat_pump_nibe_eb100_ep14_bt3_return_temp',
            },
        };
    }

    setConfig(config) {
        if (!config || !config.entities || typeof config.entities !== 'object') {
            throw new Error('nibepi-flow-card: an "entities" map is required');
        }
        this._cfg = Object.assign(
            { language: 'en', title: '', details: true, layout: 'auto', wide_at: WIDE_AT },
            config);
        this._e = config.entities;
        this._t = LABELS[this._cfg.language] || LABELS.en;
        this._built = false;
        this._sig = null;
        if (this.shadowRoot) this.shadowRoot.innerHTML = '';
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._built) this._build();
        this._update();
    }

    getCardSize() { return this._cfg && this._cfg.details === false ? 9 : 15; }

    // ── data helpers ─────────────────────────────────────────────────────────
    _obj(key) {
        const id = this._e[key];
        if (!id || !this._hass) return null;
        const s = this._hass.states[id];
        if (!s || s.state === 'unavailable' || s.state === 'unknown') return null;
        return s;
    }

    _num(key) {
        const s = this._obj(key);
        if (!s) return null;
        const v = parseFloat(s.state);
        return Number.isNaN(v) ? null : v;
    }

    /** State plus its own unit, for the generic detail rows. */
    _display(key) {
        const s = this._obj(key);
        if (!s) return null;
        const unit = s.attributes && s.attributes.unit_of_measurement;
        const n = parseFloat(s.state);
        if (Number.isNaN(n)) return s.state;
        const txt = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
        return unit ? `${txt} ${unit}` : txt;
    }

    _prio() {
        const s = this._obj('prio');
        if (!s) return null;
        const n = parseFloat(s.state);
        if (!Number.isNaN(n)) return n;
        const key = s.state.trim().toLowerCase();
        return key in PRIO_TEXT ? PRIO_TEXT[key] : null;
    }

    _more(entityId) {
        if (!entityId) return;
        this.dispatchEvent(new CustomEvent('hass-more-info', {
            detail: { entityId }, bubbles: true, composed: true,
        }));
    }

    // ── schematic markup ─────────────────────────────────────────────────────
    /** Shared drawing primitives, bound to one variant's id namespace. */
    _kit(v) {
        const L = LAYOUTS[v];
        return {
            pipe: id => `<path class="pipe" id="${v}_p_${id}" d="${L.pipes[id].d}"/>`,
            flow: id => `<path class="flow" id="${v}_f_${id}" d="${L.pipes[id].d}"/>`,
            arrows: (id, list) => list.map(([x, y, r], i) =>
                `<path class="arrow" id="${v}_a_${id}_${i}" d="M -3.4 -3.6 L 4 0 L -3.4 3.6 Z"
                       transform="translate(${x} ${y}) rotate(${r})"/>`).join(''),
            /** NIBE designation in a pill, measured value beside it. */
            tag: (key, code, x, y, hit) => `
              <g class="tag" id="${v}_t_${key}" data-hit="${hit || ''}">
                <rect x="${x}" y="${y}" width="37" height="17" rx="8.5"/>
                <text class="tagtext" x="${x + 18.5}" y="${y + 12.3}" text-anchor="middle">${code}</text>
                <text class="tagval" id="${v}_v_${key}" x="${x + 44}" y="${y + 13.5}">–</text>
              </g>`,
            pump: (key, cx, cy) => `
              <g class="pumpsym hit" id="${v}_pump_${key}" data-hit="${key === 'brine' ? 'brine_pump' : 'supply_pump'}">
                <circle cx="${cx}" cy="${cy}" r="9"/>
                <path d="M${cx - 2.6} ${cy - 3.6} L${cx + 3.6} ${cy} L${cx - 2.6} ${cy + 3.6} Z"/>
              </g>`,
            /** Three-port diverter; the selected outlet fills with the accent. */
            valve: (cx, cy, r, ports) => `
              <g class="valve">
                <circle cx="${cx}" cy="${cy}" r="${r}"/>
                ${ports.stems}
                <path class="port" id="${v}_port_heat" d="${ports.heat}"/>
                <path class="port" id="${v}_port_hw" d="${ports.hw}"/>
              </g>`,
            ring: (cx, cy, r) => `
              <circle class="ring-bg" cx="${cx}" cy="${cy}" r="${r}"/>
              <circle class="ring-fg" id="${v}_ring" cx="${cx}" cy="${cy}" r="${r}"
                      transform="rotate(-90 ${cx} ${cy})"/>`,
            refrigerant: () => L.refrigerant.map(r =>
                `<path class="ref" id="${v}_p_${r.id}" d="${r.d}"/>`).join('')
                + L.refrigerant.map(r =>
                    `<path class="refflow" id="${v}_f_${r.id}" d="${r.d}"/>`).join('')
                + L.refrigerant.map(r => r.arrows.map(([x, y, rot], i) =>
                    `<path class="refarrow" id="${v}_a_${r.id}_${i}" d="M -3 -3.2 L 3.6 0 L -3 3.2 Z"
                           transform="translate(${x} ${y}) rotate(${rot})"/>`).join('')).join(''),
            hatch: (x0, x1, y, step) => {
                const out = [];
                for (let x = x0; x <= x1; x += step) out.push(`M${x} ${y} L${x - 9} ${y + 12}`);
                return out.join(' ');
            },
        };
    }

    _wideMarkup() {
        const t = this._t, k = this._kit('wide'), P = LAYOUTS.wide.pipes;
        const fins = [872, 892, 912, 932, 952, 972].map(x => `M${x} 126 V206`).join(' ');
        return `
      <!-- ground and borehole -->
      <path class="ground" d="M18 252 H244"/>
      <path class="ground" d="${k.hatch(30, 240, 252, 19)}"/>
      <text class="caption" x="150" y="300">${t.cGround}</text>

      ${k.pipe('brine_flow')}${k.pipe('brine_ret')}
      ${k.flow('brine_flow')}${k.flow('brine_ret')}
      ${k.arrows('brine_flow', P.brine_flow.arrows)}
      ${k.arrows('brine_ret', P.brine_ret.arrows)}
      ${k.tag('bt10', 'BT10', 86, 130, 'brine_in')}
      ${k.tag('bt11', 'BT11', 140, 210, 'brine_out')}
      ${k.pump('brine', 178, 162)}
      <text class="pumplabel hit" id="wide_v_gp2" x="178" y="188"
            text-anchor="middle" data-hit="brine_pump">GP2 –</text>

      <!-- machine outline and refrigerant circuit -->
      <rect class="enclosure" x="252" y="96" width="350" height="290" rx="10"/>
      <text class="desig" x="262" y="115">EB100 · EP14</text>
      ${k.refrigerant()}

      <rect class="vessel" x="282" y="152" width="48" height="62" rx="3"/>
      <path class="hx" d="M282 214 L330 152"/>
      <text class="caption" x="306" y="232" text-anchor="middle">${t.cEvap}</text>

      <rect class="vessel" x="524" y="152" width="48" height="62" rx="3"/>
      <path class="hx" d="M524 214 L572 152"/>
      <text class="caption" x="548" y="232" text-anchor="middle">${t.cCond}</text>

      <g class="hit" data-hit="compressor_hz">
        ${k.ring(427, 134, 33)}
        <circle class="vessel" cx="427" cy="134" r="24"/>
        <path class="hx" d="M414 122 V146 M419 123 V145 L438 134 Z"/>
        <text class="cprval" id="wide_v_hz" x="427" y="192" text-anchor="middle">–</text>
        <text class="cprstate" id="wide_v_cprstate" x="427" y="208" text-anchor="middle"></text>
        <text class="caption" x="427" y="228" text-anchor="middle">${t.cCompressor}</text>
      </g>

      <g class="valve"><path d="M411 310 V330 L427 320 Z M443 310 V330 L427 320 Z"/></g>
      <text class="caption" x="427" y="348" text-anchor="middle">${t.cValve}</text>

      <!-- heat medium -->
      ${k.pipe('hm_sup')}${k.flow('hm_sup')}${k.arrows('hm_sup', P.hm_sup.arrows)}
      ${k.tag('bt2', 'BT2', 612, 128, 'supply')}
      ${k.pump('hm', 640, 162)}
      <text class="pumplabel hit" id="wide_v_gp1" x="640" y="188"
            text-anchor="middle" data-hit="supply_pump">GP1 –</text>

      ${k.valve(712, 162, 13, {
            stems: '<path d="M699 162 H725 M712 162 V175"/>',
            heat: 'M718 158 L724.5 162 L718 166 Z',
            hw: 'M708 169 L712 175.5 L716 169 Z',
        })}
      <text class="desig" x="740" y="152">QN10</text>

      <g class="branch" id="wide_br_heating">
        ${k.pipe('heat_sup')}${k.pipe('heat_ret')}
        ${k.flow('heat_sup')}${k.flow('heat_ret')}
        ${k.arrows('heat_sup', P.heat_sup.arrows)}
        ${k.arrows('heat_ret', P.heat_ret.arrows)}
        <rect class="vessel" x="852" y="116" width="138" height="100" rx="5"/>
        <path class="hx" d="${fins}"/>
        <text class="caption" x="921" y="236" text-anchor="middle">${t.cHeating}</text>
        ${k.tag('bt50', 'BT50', 866, 246, 'room')}
      </g>

      <g class="branch" id="wide_br_hotwater">
        ${k.pipe('hw_sup')}${k.pipe('hw_ret')}
        ${k.flow('hw_sup')}${k.flow('hw_ret')}
        ${k.arrows('hw_sup', P.hw_sup.arrows)}
        ${k.arrows('hw_ret', P.hw_ret.arrows)}
        <text class="caption" x="921" y="286" text-anchor="middle">${t.cHotwater}</text>
        <rect class="vessel" x="852" y="296" width="138" height="156" rx="16"/>
        <path class="hx" d="${coilPath(872, 962, 344, 12, 6, false)}"/>
        ${k.tag('bt7', 'BT7', 866, 306, 'hw_top')}
        ${k.tag('bt6', 'BT6', 866, 420, 'hw_load')}
      </g>

      ${k.tag('bt3', 'BT3', 640, 442, 'return')}`;
    }

    _tallMarkup() {
        const t = this._t, k = this._kit('tall'), P = LAYOUTS.tall.pipes;
        const fins = [76, 106, 136, 166, 196, 226].map(x => `M${x} 50 V110`).join(' ');
        return `
      <!-- consumers at the top: the house sits above the ground -->
      <g class="branch" id="tall_br_heating">
        ${k.pipe('heat_sup')}${k.pipe('heat_ret')}
        ${k.flow('heat_sup')}${k.flow('heat_ret')}
        ${k.arrows('heat_sup', P.heat_sup.arrows)}
        ${k.arrows('heat_ret', P.heat_ret.arrows)}
        <rect class="vessel" x="54" y="40" width="232" height="80" rx="5"/>
        <path class="hx" d="${fins}"/>
        <text class="caption" x="54" y="140">${t.cHeating}</text>
        ${k.tag('bt50', 'BT50', 54, 150, 'room')}
      </g>

      <g class="branch" id="tall_br_hotwater">
        ${k.pipe('hw_sup')}${k.pipe('hw_ret')}
        ${k.flow('hw_sup')}${k.flow('hw_ret')}
        ${k.arrows('hw_sup', P.hw_sup.arrows)}
        ${k.arrows('hw_ret', P.hw_ret.arrows)}
        <text class="caption" x="54" y="188">${t.cHotwater}</text>
        <rect class="vessel" x="54" y="196" width="232" height="172" rx="16"/>
        <path class="hx" d="${coilPath(90, 250, 230, 12, 7)}"/>
        ${k.tag('bt7', 'BT7', 72, 206, 'hw_top')}
        ${k.tag('bt6', 'BT6', 72, 320, 'hw_load')}
      </g>

      <!-- diverter and heat medium trunk -->
      ${k.valve(310, 400, 12, {
            stems: '<path d="M310 400 V412 M310 400 V388 M310 400 H298"/>',
            heat: 'M306 384 L310 377.5 L314 384 Z',
            hw: 'M302 396 L295.5 400 L302 404 Z',
        })}
      <text class="desig" x="292" y="424" text-anchor="end">QN10</text>

      ${k.pipe('hm_sup')}${k.flow('hm_sup')}${k.arrows('hm_sup', P.hm_sup.arrows)}
      ${k.tag('bt2', 'BT2', 150, 418, 'supply')}
      ${k.tag('bt3', 'BT3', 44, 396, 'return')}
      ${k.pump('hm', 250, 440)}
      <text class="pumplabel hit" id="tall_v_gp1" x="250" y="462"
            text-anchor="middle" data-hit="supply_pump">GP1 –</text>

      <!-- machine outline and refrigerant circuit -->
      <rect class="enclosure" x="40" y="460" width="290" height="340" rx="10"/>
      <text class="desig" x="48" y="476">EB100 · EP14</text>
      ${k.refrigerant()}

      <rect class="vessel" x="150" y="482" width="80" height="36" rx="3"/>
      <path class="hx" d="M150 518 L230 482"/>
      <text class="caption" x="190" y="538" text-anchor="middle">${t.cCond}</text>

      <rect class="vessel" x="150" y="730" width="80" height="36" rx="3"/>
      <path class="hx" d="M150 766 L230 730"/>
      <text class="caption" x="190" y="722" text-anchor="middle">${t.cEvap}</text>

      <g class="hit" data-hit="compressor_hz">
        ${k.ring(286, 624, 30)}
        <circle class="vessel" cx="286" cy="624" r="21"/>
        <path class="hx" d="M275 614 V634 M279 615 V633 L295 624 Z"/>
        <text class="cprval" id="tall_v_hz" x="240" y="618" text-anchor="end">–</text>
        <text class="cprstate" id="tall_v_cprstate" x="240" y="636" text-anchor="end"></text>
        <text class="caption" x="240" y="654" text-anchor="end">${t.cCompressor}</text>
      </g>

      <g class="valve"><path d="M60 614 V634 L74 624 Z M88 614 V634 L74 624 Z"/></g>
      <text class="caption" x="96" y="600">${t.cValveShort}</text>

      <!-- ground and borehole at the bottom -->
      ${k.pipe('brine_flow')}${k.pipe('brine_ret')}
      ${k.flow('brine_flow')}${k.flow('brine_ret')}
      ${k.arrows('brine_flow', P.brine_flow.arrows)}
      ${k.arrows('brine_ret', P.brine_ret.arrows)}
      ${k.pump('brine', 180, 784)}
      <text class="pumplabel hit" id="tall_v_gp2" x="194" y="788"
            data-hit="brine_pump">GP2 –</text>
      ${k.tag('bt10', 'BT10', 36, 806, 'brine_in')}
      ${k.tag('bt11', 'BT11', 226, 806, 'brine_out')}
      <path class="ground" d="M30 830 H310"/>
      <path class="ground" d="${k.hatch(42, 306, 830, 19)}"/>
      <text class="caption" x="234" y="874">${t.cGround}</text>`;
    }

    // ── DOM ──────────────────────────────────────────────────────────────────
    _build() {
        const t = this._t;

        const stat = (id, label) => `
      <button class="stat" id="k_${id}" type="button">
        <span class="klabel">${label}</span>
        <span class="kval" id="kv_${id}">–</span>
      </button>`;

        this.shadowRoot.innerHTML = `
      <style>
        /* Breakpoints follow the card's own width, not the viewport, because the
           card can sit in a narrow column on a wide screen. A ResizeObserver puts
           .wide / .narrow on the card rather than a container query: a query needs
           an intact container-type on every host that reparents the card, and when
           it silently fails to match there is no way to tell from the outside.
           Both boxes are declared block explicitly: an inline card has no width
           to measure, and the observer would sit at 0 forever. */
        :host { display: block; }
        ha-card { display: block; padding: 16px; }

        /* ── header ─────────────────────────────────────────────────────── */
        .hdr { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
        .title { font-size:1.05rem; font-weight:500; color:var(--primary-text-color); }
        .outdoor {
          font-size:.8rem; color:var(--secondary-text-color); cursor:pointer;
          padding:4px 10px; border-radius:12px; background:var(--secondary-background-color);
        }
        .outdoor b { color:var(--primary-text-color); font-weight:500; }
        .pill {
          margin-left:auto; font-size:.75rem; font-weight:500; letter-spacing:.02em;
          padding:5px 12px; border-radius:14px; white-space:nowrap;
          background:var(--nb-pill, var(--primary-color)); color:#fff;
        }
        .pill.idle { background:var(--secondary-background-color); color:var(--secondary-text-color); }

        .alarm {
          display:none; align-items:center; gap:8px; margin:0 0 16px;
          padding:10px 14px; border-radius:12px; cursor:pointer;
          background:var(--secondary-background-color);
          border-left:4px solid var(--error-color, #d24c3c);
          color:var(--primary-text-color); font-size:.85rem;
        }
        .alarm.on { display:flex; }
        .alarm b { color:var(--error-color, #d24c3c); font-weight:500; }

        /* ── summary row ────────────────────────────────────────────────── */
        .stats {
          display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr));
          gap:8px; margin-bottom:16px;
        }
        .stat {
          appearance:none; text-align:left; font:inherit; cursor:pointer;
          background:var(--secondary-background-color); border:none;
          border-radius:12px; padding:10px 12px;
          display:flex; flex-direction:column; gap:2px;
        }
        .stat.hidden { display:none; }
        .stat:focus-visible { outline:2px solid var(--primary-color); outline-offset:2px; }
        .klabel {
          font-size:.68rem; text-transform:uppercase; letter-spacing:.06em;
          color:var(--secondary-text-color); line-height:1.3;
        }
        .kval {
          font-size:1.35rem; font-weight:500; color:var(--primary-text-color);
          font-variant-numeric:tabular-nums; line-height:1.2;
        }
        .kval small { font-size:.6em; font-weight:400; color:var(--secondary-text-color); margin-left:2px; }

        /* ── the schematic ──────────────────────────────────────────────── */
        /* Portrait is the default, so a card that is measured late — or not at
           all, if ResizeObserver is missing — still shows a drawing that fits
           anywhere. Landscape is switched on by the .wide class. */
        .sheet { margin:0 0 18px; }
        svg.schematic { display:block; height:auto; }
        svg.v-wide { display:none; width:100%; max-width:1400px; margin:0 auto; }
        svg.v-tall { display:block; width:100%; max-width:480px; margin:0 auto; }
        ha-card.wide svg.v-wide { display:block; }
        ha-card.wide svg.v-tall { display:none; }

        .pipe { fill:none; stroke:var(--divider-color); stroke-width:2.4; stroke-linejoin:round; }
        .flow {
          fill:none; stroke-width:4; stroke-linecap:round; stroke-dasharray:0.5 11;
          animation:nb-dash 1.2s linear infinite;
        }
        .flow.off { animation-play-state:paused; opacity:0; }
        @keyframes nb-dash { to { stroke-dashoffset:-11.5; } }
        .arrow { stroke:none; fill:var(--secondary-text-color); }

        .ref { fill:none; stroke:var(--divider-color); stroke-width:1.6; stroke-dasharray:5 4; }
        .refflow {
          fill:none; stroke:var(--nb-refrigerant, #7e57c2); stroke-width:2.2;
          stroke-linecap:round; stroke-dasharray:0.5 8;
          animation:nb-dash-r 1.1s linear infinite;
        }
        .refarrow { stroke:none; fill:var(--nb-refrigerant, #7e57c2); }
        .refflow.off { animation-play-state:paused; opacity:0; }
        @keyframes nb-dash-r { to { stroke-dashoffset:-8.5; } }

        .vessel {
          fill:var(--card-background-color, var(--ha-card-background));
          stroke:var(--primary-text-color); stroke-width:1.8; stroke-linejoin:round;
        }
        .hx { fill:none; stroke:var(--primary-text-color); stroke-width:1.6; }
        .enclosure {
          fill:none; stroke:var(--divider-color); stroke-width:1.4; stroke-dasharray:7 5;
        }
        .ground { fill:none; stroke:var(--secondary-text-color); stroke-width:1.4; opacity:.75; }

        .caption {
          fill:var(--secondary-text-color); font-size:10.5px;
          text-transform:uppercase; letter-spacing:.09em;
        }
        .desig { fill:var(--secondary-text-color); font-size:10.5px; letter-spacing:.06em; }
        .tag rect { fill:var(--secondary-background-color); stroke:none; }
        .tag { cursor:pointer; }
        .tagtext { fill:var(--secondary-text-color); font-size:10.5px; letter-spacing:.04em; }
        .tagval {
          fill:var(--primary-text-color); font-size:17px; font-weight:500;
          font-variant-numeric:tabular-nums;
        }
        .tag:hover .tagval { text-decoration:underline; }

        .pumpsym circle {
          fill:var(--card-background-color, var(--ha-card-background));
          stroke:var(--primary-text-color); stroke-width:1.6;
        }
        .pumpsym path { fill:var(--secondary-text-color); stroke:none; }
        .pumpsym.running path { fill:var(--primary-color); }
        .pumplabel { fill:var(--secondary-text-color); font-size:10.5px; cursor:pointer; }

        .valve path { fill:none; stroke:var(--primary-text-color); stroke-width:1.6; }
        .valve circle {
          fill:var(--card-background-color, var(--ha-card-background));
          stroke:var(--primary-text-color); stroke-width:1.6;
        }
        .port { fill:var(--divider-color); stroke:none; }
        .port.active { fill:var(--primary-color); }

        .cprval {
          fill:var(--primary-text-color); font-size:19px; font-weight:500;
          font-variant-numeric:tabular-nums;
        }
        .cprstate { fill:var(--secondary-text-color); font-size:11px; }
        .ring-bg { fill:none; stroke:var(--divider-color); stroke-width:3.4; }
        .ring-fg {
          fill:none; stroke:var(--primary-color); stroke-width:3.4; stroke-linecap:round;
          transition:stroke-dashoffset .4s ease;
        }
        .branch { transition:opacity .25s ease; }
        .branch.dim { opacity:.3; }
        .hit { cursor:pointer; }

        /* ── heat demand meter ──────────────────────────────────────────── */
        .demand {
          background:var(--secondary-background-color); border-radius:12px;
          padding:12px 14px; margin-bottom:16px; cursor:pointer;
        }
        .demand.hidden { display:none; }
        .drow { display:flex; align-items:baseline; gap:12px; }
        .dlabel {
          font-size:.68rem; text-transform:uppercase; letter-spacing:.06em;
          color:var(--secondary-text-color);
        }
        .dstate { margin-left:auto; font-size:.72rem; color:var(--secondary-text-color); }
        .dval {
          font-size:1.35rem; font-weight:500; color:var(--primary-text-color);
          font-variant-numeric:tabular-nums;
        }
        .dval small { font-size:.6em; font-weight:400; color:var(--secondary-text-color); margin-left:2px; }
        .dtrack {
          position:relative; height:8px; border-radius:4px; margin:9px 0 7px;
          background:var(--divider-color); overflow:hidden;
        }
        .dfill {
          position:absolute; inset:0 auto 0 0; width:0;
          background:var(--primary-color); border-radius:4px;
          transition:width .4s ease, background-color .4s ease;
        }
        .dmark {
          position:absolute; top:-2px; bottom:-2px; width:2px; display:none;
          background:var(--primary-text-color); opacity:.55;
        }
        .dmark.on { display:block; }
        .dfoot { font-size:.72rem; color:var(--secondary-text-color); line-height:1.45; }

        /* ── detail groups ──────────────────────────────────────────────── */
        .groups {
          display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
        }
        .group {
          background:var(--secondary-background-color); border-radius:12px; padding:10px 12px 6px;
        }
        .group.hidden { display:none; }
        .gtitle {
          font-size:.66rem; text-transform:uppercase; letter-spacing:.07em;
          color:var(--secondary-text-color); margin-bottom:6px;
        }
        .row {
          display:flex; align-items:baseline; gap:10px; padding:4px 0; cursor:pointer;
          border-top:1px solid var(--divider-color);
        }
        .row:first-of-type { border-top:none; }
        .row.hidden { display:none; }
        .row .rl { font-size:.8rem; color:var(--secondary-text-color); min-width:0; }
        .row .rv {
          margin-left:auto; font-size:.85rem; font-weight:500;
          color:var(--primary-text-color); font-variant-numeric:tabular-nums;
          text-align:right; white-space:nowrap;
        }
        .row:hover .rv { text-decoration:underline; }

        ha-card.narrow .stats { grid-template-columns:repeat(2,minmax(0,1fr)); }

        @media (prefers-reduced-motion: reduce) {
          .flow, .refflow { animation:none; }
        }
      </style>

      <ha-card>
        <div class="hdr">
          <div class="title">${esc(this._cfg.title || t.heatpump)}</div>
          <div class="outdoor" id="h_outdoor">${t.outdoor} <b id="v_outdoor">–</b><span id="v_outdoor_avg"></span></div>
          <div class="pill" id="pill">–</div>
        </div>

        <div class="alarm" id="alarmbox"><span id="alarmtxt"></span></div>

        <div class="stats">
          ${stat('heat', t.sHeat)}
          ${stat('power', t.sPower)}
          ${stat('cop', t.sCop)}
          ${stat('copToday', t.sCopToday)}
        </div>

        <div class="sheet">
          <svg class="schematic v-wide" viewBox="${LAYOUTS.wide.viewBox}" role="img"
               aria-label="${t.heatpump} — ${t.cGround}, ${t.cCompressor}, ${t.cHeating}, ${t.cHotwater}"
               >${this._wideMarkup()}</svg>
          <svg class="schematic v-tall" viewBox="${LAYOUTS.tall.viewBox}" role="img"
               aria-label="${t.heatpump} — ${t.cGround}, ${t.cCompressor}, ${t.cHeating}, ${t.cHotwater}"
               >${this._tallMarkup()}</svg>
        </div>

        <div class="demand" id="demand">
          <div class="drow">
            <span class="dlabel">${t.demand}</span>
            <span class="dstate" id="d_state"></span>
          </div>
          <div class="drow"><span class="dval" id="d_val">–</span></div>
          <div class="dtrack"><div class="dfill" id="d_fill"></div><div class="dmark" id="d_mark"></div></div>
          <div class="dfoot" id="d_foot"></div>
        </div>

        <div class="groups" id="groups">
          ${GROUPS.map(([gk, keys]) => `
            <div class="group" id="g_${gk}">
              <div class="gtitle">${t[gk]}</div>
              ${keys.map(key => `
                <div class="row" id="r_${key}" data-hit="${key}">
                  <span class="rl">${t[key] || key}</span>
                  <span class="rv" id="rv_${key}">–</span>
                </div>`).join('')}
            </div>`).join('')}
        </div>
      </ha-card>`;

        this.$ = id => this.shadowRoot.getElementById(id);

        if (this._cfg.details === false) this.$('groups').style.display = 'none';

        // one delegated listener for every more-info target
        this.shadowRoot.addEventListener('click', ev => {
            const el = ev.target.closest('[data-hit]');
            if (el && el.dataset.hit) this._more(this._e[el.dataset.hit]);
        });
        for (const [id, key] of [['h_outdoor', 'outdoor'], ['alarmbox', 'alarm'],
            ['demand', 'degree_minutes'], ['k_heat', 'heat_output'], ['k_power', 'power_in'],
            ['k_cop', 'cop'], ['k_copToday', 'cop_today']]) {
            const el = this.$(id);
            if (el) el.addEventListener('click', () => this._more(this._e[key]));
        }

        this._measure();
        this._built = true;
    }

    // ── layout ───────────────────────────────────────────────────────────────
    /** Watch the card's own content box and pick a geometry from it. */
    _measure() {
        const card = this.shadowRoot.querySelector('ha-card');
        if (!card) return;
        this._fit(card.clientWidth - 32);        // pre-layout this is negative; harmless
        // Always rebound: setConfig throws the old ha-card away, and an observer
        // still pointing at it would never fire again.
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (typeof ResizeObserver === 'undefined') return;
        this._ro = new ResizeObserver(entries => {
            const w = entries[entries.length - 1].contentRect.width;
            if (w > 0) this._fit(w);
        });
        this._ro.observe(card);
    }

    _fit(w) {
        const card = this.shadowRoot.querySelector('ha-card');
        if (!card) return;
        const forced = this._cfg.layout;
        const wideAt = Number(this._cfg.wide_at) || WIDE_AT;
        card.classList.toggle('wide',
            forced === 'wide' || (forced !== 'tall' && w >= wideAt));
        card.classList.toggle('narrow', w > 0 && w < NARROW_AT);
    }

    connectedCallback() { if (this._built) this._measure(); }

    disconnectedCallback() {
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }

    // ── render ───────────────────────────────────────────────────────────────
    _update() {
        const sig = Object.keys(this._e).map(k => {
            const s = this._obj(k);
            return s ? s.state : '';
        }).join('|');
        if (sig === this._sig) return;
        this._sig = sig;

        const $ = this.$, t = this._t, n = k => this._num(k);
        const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
        const deg = v => (v === null ? '–' : `${fmt(v)} °C`);
        const pct = v => (v === null ? '–' : `${Math.round(v)} %`);

        const d = {
            outdoor: n('outdoor'), outdoorAvg: n('outdoor_avg'),
            brineIn: n('brine_in'), brineOut: n('brine_out'),
            supply: n('supply'), ret: n('return'),
            hwTop: n('hw_top'), hwLoad: n('hw_load'), room: n('room'),
            hz: n('compressor_hz'), cprState: n('compressor_state'),
            bpump: n('brine_pump'), hpump: n('supply_pump'),
        };
        d.running = d.hz !== null && d.hz > 0;

        // ── header ──────────────────────────────────────────────────────────
        set('v_outdoor', deg(d.outdoor));
        set('v_outdoor_avg', d.outdoorAvg === null ? '' : ` · ${t.avg} ${fmt(d.outdoorAvg)} °C`);

        // ── summary ─────────────────────────────────────────────────────────
        const stat = (id, v, unit, digits = 1) => {
            const hide = v === null;
            $(`k_${id}`).classList.toggle('hidden', hide);
            if (!hide) $(`kv_${id}`).innerHTML = `${fmt(v, digits)}${unit ? `<small>${unit}</small>` : ''}`;
        };
        const powerW = n('power_in'), addKw = n('add_power');
        stat('heat', n('heat_output'), ' kW');
        stat('power', powerW === null ? null : powerW / 1000 + (addKw || 0), ' kW', 2);
        stat('cop', n('cop'), '', 2);
        stat('copToday', n('cop_today'), '', 2);

        // ── prio: pill, diverter, dimming ───────────────────────────────────
        const prio = this._prio();
        d.heating = prio === 30 || prio === 50;
        d.hotwater = prio === 20;
        d.known = prio !== null && (d.heating || d.hotwater);
        const pill = $('pill');
        pill.textContent = prio !== null
            ? (t.prioMap[prio] || String(prio))
            : (d.running ? t.cprMap[60] : t.idle);
        pill.classList.toggle('idle', prio === 10 || prio === null);
        pill.style.setProperty('--nb-pill', d.hotwater ? '#c9622a' : 'var(--primary-color)');

        // dash speed per circuit, from the pump that drives it
        const speed = p => (p === null || p <= 0 ? null : clamp(2.2 - 1.75 * (p / 100), 0.45, 2.4));
        d.bDur = speed(d.bpump);
        d.hDur = speed(d.hpump);
        d.refDur = d.running ? clamp(90 / d.hz, 0.5, 3) : null;

        // both geometries are painted; CSS decides which one is on screen
        for (const v of VARIANTS) this._paintVariant(v, d, deg, pct);

        // ── house heat demand, from the degree minute register ───────────────
        const dm = n('degree_minutes');
        const dmStart = n('dm_start');
        $('demand').classList.toggle('hidden', dm === null);
        if (dm !== null) {
            const demand = Math.max(0, -dm);
            const startAt = dmStart !== null ? Math.abs(dmStart) : 60;
            const scale = Math.max(600, demand * 1.15, startAt * 2);
            $('d_val').innerHTML = `${fmt(demand, 0)}<small>${t.demandUnit}</small>`;
            const fill = $('d_fill');
            fill.style.width = `${clamp((demand / scale) * 100, 0, 100)}%`;
            fill.style.backgroundColor = demand >= startAt ? '#c9622a' : 'var(--primary-color)';
            const mark = $('d_mark');
            mark.classList.toggle('on', startAt < scale);
            mark.style.left = `${clamp((startAt / scale) * 100, 0, 100)}%`;
            set('d_state', demand === 0 ? '' : (demand >= startAt ? t.demandCalling : t.demandSatisfied));
            set('d_foot', demand === 0
                ? t.demandNone
                : `${t.demandStart.replace('{n}', String(Math.round(startAt)))} · ${t.demandNote}`);
        }

        // ── detail rows ─────────────────────────────────────────────────────
        for (const [gk, keys] of GROUPS) {
            let shown = 0;
            for (const key of keys) {
                let text = this._display(key);
                if (key === 'prio' && prio !== null) text = t.prioMap[prio] || text;
                if (key === 'compressor_state' && d.cprState !== null) {
                    text = t.cprMap[d.cprState] || text;
                }
                const row = $(`r_${key}`);
                const hide = text === null;
                row.classList.toggle('hidden', hide);
                if (!hide) { set(`rv_${key}`, text); shown++; }
            }
            $(`g_${gk}`).classList.toggle('hidden', shown === 0);
        }

        // ── alarm ───────────────────────────────────────────────────────────
        const alarm = n('alarm');
        const on = alarm !== null && alarm !== 0;
        $('alarmbox').classList.toggle('on', on);
        if (on) {
            const text = ALARMS[String(alarm)];
            $('alarmtxt').innerHTML = `<b>${t.alarm} ${alarm}</b>${text ? ' · ' + esc(text) : ''}`;
        }
    }

    /** Paint one geometry. Both layouts expose the same ids under their own
     *  prefix, so this runs unchanged for either. */
    _paintVariant(v, d, deg, pct) {
        const $ = this.$, t = this._t;
        const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
        const L = LAYOUTS[v];

        // A sensor tag with nothing behind it — BT7 on an installation that only
        // has BT6, say — is drawn as a permanent "–", so drop the whole pill.
        const tag = (key, value) => {
            const g = $(`${v}_t_${key}`);
            if (g) g.style.display = value === null ? 'none' : '';
            set(`${v}_v_${key}`, deg(value));
        };
        tag('bt10', d.brineIn);
        tag('bt11', d.brineOut);
        tag('bt2', d.supply);
        tag('bt3', d.ret);
        tag('bt7', d.hwTop);
        tag('bt6', d.hwLoad);
        tag('bt50', d.room);
        set(`${v}_v_gp2`, `GP2 ${pct(d.bpump)}`);
        set(`${v}_v_gp1`, `GP1 ${pct(d.hpump)}`);

        set(`${v}_v_hz`, d.hz === null ? '–' : `${fmt(d.hz, 0)} Hz`);
        set(`${v}_v_cprstate`, d.cprState !== null
            ? (t.cprMap[d.cprState] || String(d.cprState))
            : (d.running ? t.cprMap[60] : t.idle));

        const ring = $(`${v}_ring`);
        const r = Number(ring.getAttribute('r'));
        const C = 2 * Math.PI * r;
        const frac = d.hz === null || d.hz <= 0 ? 0 : clamp((d.hz - 20) / 100, 0.02, 1);
        ring.style.strokeDasharray = String(C);
        ring.style.strokeDashoffset = String(C * (1 - frac));

        $(`${v}_br_heating`).classList.toggle('dim', d.known && !d.heating);
        $(`${v}_br_hotwater`).classList.toggle('dim', d.known && !d.hotwater);
        $(`${v}_port_heat`).classList.toggle('active', d.heating);
        $(`${v}_port_hw`).classList.toggle('active', d.hotwater);

        for (const [id, spec] of Object.entries(L.pipes)) {
            const color = tempColor(this._num(spec.temp));
            const dur = spec.pump === 'brine' ? d.bDur : d.hDur;
            const dim = spec.branch === 'heating' ? d.known && !d.heating
                : spec.branch === 'hotwater' ? d.known && !d.hotwater : false;

            const fl = $(`${v}_f_${id}`);
            fl.style.stroke = color;
            fl.classList.toggle('off', dur === null || dim);
            if (dur !== null) fl.style.animationDuration = `${dur}s`;

            const base = $(`${v}_p_${id}`);
            base.style.stroke = dur === null ? 'var(--divider-color)' : color;
            base.style.opacity = dur === null ? '1' : '.35';
            spec.arrows.forEach((_, i) => {
                const a = $(`${v}_a_${id}_${i}`);
                a.style.fill = color;
                a.style.opacity = dur === null ? '.5' : '.9';
            });
        }

        for (const key of ['brine', 'hm']) {
            $(`${v}_pump_${key}`).classList.toggle(
                'running', (key === 'brine' ? d.bDur : d.hDur) !== null);
        }

        for (const ref of L.refrigerant) {
            const fl = $(`${v}_f_${ref.id}`);
            fl.classList.toggle('off', d.refDur === null);
            if (d.refDur !== null) fl.style.animationDuration = `${d.refDur}s`;
            ref.arrows.forEach((_, i) => {
                $(`${v}_a_${ref.id}_${i}`).style.opacity = d.refDur === null ? '.3' : '.75';
            });
        }
    }
}

if (!customElements.get('nibepi-flow-card')) {
    customElements.define('nibepi-flow-card', NibepiFlowCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'nibepi-flow-card',
    name: 'NibePi Flow Card',
    description: 'Live hydraulic schematic for a NIBE heat pump: borehole, refrigerant circuit, heating, hot water and house heat demand.',
    preview: false,
    documentationURL: 'https://github.com/JustChr/nibepi',
});

console.info(`%c NIBEPI-FLOW-CARD %c v${CARD_VERSION} `,
    'color:#fff;background:#0b6e99;font-weight:700',
    'color:#0b6e99;background:#eee');
