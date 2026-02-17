/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

// Nutze die lokale gepatchte Version statt dem veralteten npm-Modul
const Cul = process.env.DEBUG ? require('./lib/debugCul.js') : require('./lib/cul.js');
const adapterName = require('./package.json').name.split('.').pop();
const utils = require('@iobroker/adapter-core');
const { SerialPort } = require('serialport');

let cul;
const objects = {};
let metaRoles = {};
let connectTimeout;

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, { name: adapterName });
    adapter = new utils.Adapter(options);

    adapter.on('stateChange', (id, state) => {
        if (state && !state.ack) {
            const oAddr = id.split('.');
            if (oAddr.length < 5) return;

            const protocol = oAddr[2];
            const address = oAddr[3];
            const cmd = oAddr[4];

            if (cul) {
                adapter.log.info(`Sending to CUL: ${protocol} ${address} ${cmd} ${state.val}`);
                // Die cul.cmd Methode erwartet Protokoll, Adresse, Kommando und Wert
                cul.cmd(protocol, address, cmd, state.val);
            }
        }
    });

    adapter.on('ready', () => {
        main();
    });

    adapter.on('unload', (callback) => {
        if (connectTimeout) clearTimeout(connectTimeout);
        if (cul && cul.port && cul.port.isOpen) {
            cul.port.close(() => {
                adapter.log.info('Serialport closed.');
                callback();
            });
        } else {
            callback();
        }
    });

    return adapter;
}

function connect() {
    if (connectTimeout) clearTimeout(connectTimeout);

    const portName = adapter.config.serialport || '/dev/ttyACM0';
    const baudRate = parseInt(adapter.config.baudrate, 10) || 9600;

    adapter.log.info(`Connecting to CUL on ${portName} with ${baudRate} baud`);

    const port = new SerialPort({
        path: portName,
        baudRate: baudRate,
        autoOpen: false
    });

    port.open((err) => {
        if (err) {
            adapter.log.error(`Cannot open port ${portName}: ${err.message}`);
            adapter.setState('info.connection', false, true);
            connectTimeout = setTimeout(connect, 30000);
            return;
        }

        cul = new Cul({
            transport: port,
            initCmd: adapter.config.initCmd || 'X21',
            parse: true,
            rssi: true
        });

        cul.on('ready', () => {
            adapter.log.info('CUL connected and initialized');
            adapter.setState('info.connection', true, true);
        });

        cul.on('data', (raw, msg) => {
            adapter.log.debug(`CUL raw: ${raw} parsed: ${JSON.stringify(msg)}`);
            if (msg && msg.protocol) {
                handleDeviceMessage(msg);
            }
        });

        cul.on('error', (err) => {
            adapter.log.error(`CUL Error: ${err}`);
            adapter.setState('info.connection', false, true);
        });
    });
}

function handleDeviceMessage(msg) {
    const deviceId = `${msg.protocol}.${msg.address}`;
    const fullDeviceId = `${adapter.namespace}.${deviceId}`;

    // Wenn das Gerät noch nicht bekannt ist, legen wir es an
    if (!objects[fullDeviceId]) {
        adapter.log.info(`New device detected: ${deviceId}`);
        
        const deviceObj = {
            _id: deviceId,
            type: 'device',
            common: {
                name: `${msg.protocol} device ${msg.address}`
            },
            native: {
                protocol: msg.protocol,
                address: msg.address
            }
        };

        adapter.setObjectNotExists(deviceId, deviceObj, (err) => {
            if (!err) {
                objects[fullDeviceId] = deviceObj;
                updateStates(deviceId, msg);
            }
        });
    } else {
        updateStates(deviceId, msg);
    }
}

function updateStates(deviceId, msg) {
    // Alle Felder aus der geparsten Nachricht als States anlegen/aktualisieren
    for (const key in msg) {
        if (key === 'protocol' || key === 'address') continue;

        const stateId = `${deviceId}.${key}`;
        const fullStateId = `${adapter.namespace}.${stateId}`;
        let val = msg[key];

        // Falls der State noch nicht im Cache ist, Metadaten aus io-package oder Default holen
        if (!objects[fullStateId]) {
            const role = metaRoles[key] || 'state';
            const common = {
                name: key,
                role: role,
                type: typeof val,
                read: true,
                write: true
            };

            // Typ-Korrekturen basierend auf dem Wert
            if (key === 'rssi') {
                common.type = 'number';
                common.role = 'value.rssi';
                common.unit = 'dBm';
            }

            adapter.setObjectNotExists(stateId, {
                type: 'state',
                common: common,
                native: {}
            }, (err) => {
                if (!err) {
                    objects[fullStateId] = true;
                    adapter.setState(stateId, val, true);
                }
            });
        } else {
            adapter.setState(stateId, val, true);
        }
    }
}

function main() {
    // Lade Rollen-Metadaten für automatische State-Erstellung
    adapter.getForeignObject('cul.meta.roles', (err, res) => {
        if (res && res.native) {
            metaRoles = res.native;
        }

        // Bestehende Objekte in den Cache laden, um unnötige setObjects zu vermeiden
        adapter.getForeignObjects(`${adapter.namespace}.*`, (err, list) => {
            for (const id in list) {
                objects[id] = list[id];
            }
            
            adapter.setState('info.connection', false, true);
            adapter.subscribeStates('*');
            connect();
        });
    });
}

if (require.main === module) {
    startAdapter();
} else {
    module.exports = startAdapter;
}