/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

// Nutzt die lokale gepatchte Version in ./lib/cul.js
const Main = process.env.DEBUG ? require('./lib/debugCul.js') : require('./lib/cul.js');
const adapterName = require('./package.json').name.split('.').pop();
const utils = require('@iobroker/adapter-core');
const { SerialPort } = require('serialport');
const Net = require('net');

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
            adapter.log.debug(`State Change ${id}, State: ${JSON.stringify(state)}`);
            const oAddr = id.split('.');
            if (oAddr.length < 5) return;

            const sHousecode = oAddr[3].substring(0, 4);
            const sAddress = oAddr[3].substring(4, 6);

            if (oAddr[2] === 'FS20' || adapter.config.experimental === true || adapter.config.experimental === 'true') {
                if (oAddr[4] === 'cmdRaw' && cul) {
                    sendCommand({ protocol: oAddr[2], housecode: sHousecode, address: sAddress, command: state.val });
                }
            }
        }
    });

    adapter.on('unload', callback => {
        if (connectTimeout) clearTimeout(connectTimeout);
        if (cul) cul.close();
        callback();
    });

    adapter.on('ready', () => {
        adapter.setState('info.connection', false, true);
        main(); // Startet die Objekt-Initialisierung und dann connect()
    });

    adapter.on('message', async (obj) => {
        if (!obj || !obj.command) return;
        switch (obj.command) {
            case 'listUart':
            case 'listUart5':
                if (obj.callback) {
                    try {
                        const ports = await SerialPort.list();
                        ports.push({ "path": "/dev/ttyUSB_CUL" });
                        
                        if (obj.command === 'listUart5' && obj.message && obj.message.experimental) {
                            const dirSerial = '/dev/serial/by-id';
                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({
                                label: `${dirSerial}/${item.pnpId || item.path}${item.manufacturer ? ` [${item.manufacturer}]` : ''}`,
                                value: `${dirSerial}/${item.pnpId || item.path}`
                            })), obj.callback);
                        } else {
                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({
                                label: item.path,
                                value: item.path
                            })), obj.callback);
                        }
                    } catch (err) {
                        adapter.sendTo(obj.from, obj.command, [], obj.callback);
                    }
                }
                break;
            case 'send':
                sendCommand(obj.message);
                break;
            case 'sendraw':
                sendRaw(obj.message);
                break;
        }
    });

    return adapter;
}

function sendCommand(o) {
    if (cul) {
        adapter.log.info(`Sending: ${o.protocol} ${o.housecode}${o.address} CMD: ${o.command}`);
        cul.cmd(o.protocol, o.housecode, o.address, o.command);
    }
}

function sendRaw(o) {
    if (cul) cul.write(o.command);
}

const tasks = [];
function processTasks() {
    if (!tasks.length) return;
    const task = tasks.shift();
    if (task.type === 'state') {
        adapter.setForeignState(task.id, task.val, true, () => setImmediate(processTasks));
    } else if (task.type === 'object') {
        adapter.getForeignObject(task.id, (err, obj) => {
            if (!obj) {
                adapter.setForeignObject(task.id, task.obj, () => {
                    adapter.log.info(`object ${task.id} created`);
                    setImmediate(processTasks);
                });
            } else {
                setImmediate(processTasks);
            }
        });
    }
}

function handleDeviceMessage(obj) {
    const id = obj.protocol + '.' + obj.address;
    const fullId = adapter.namespace + '.' + id;

    if (!objects[fullId]) {
        const tmp = JSON.parse(JSON.stringify(obj));
        delete tmp.data;
        const newDevice = {
            _id: fullId,
            type: 'device',
            common: { name: (obj.device ? obj.device + ' ' : '') + obj.address },
            native: tmp
        };
        for (const _state in obj.data) {
            if (!obj.data.hasOwnProperty(_state)) continue;
            let common = metaRoles[obj.device + '_' + _state] || metaRoles[_state] || metaRoles['undefined'];
            common = JSON.parse(JSON.stringify(common));
            common.name = _state + ' ' + (obj.device ? obj.device + ' ' : '') + id;

            const newState = {
                _id: `${fullId}.${_state}`,
                type: 'state',
                common: common,
                native: {}
            };
            objects[newState._id] = newState;
            tasks.push({ type: 'object', id: newState._id, obj: newState });
        }
        objects[fullId] = newDevice;
        tasks.push({ type: 'object', id: newDevice._id, obj: newDevice });
    }
    setStates(obj);
}

function setStates(obj) {
    const id = obj.protocol + '.' + obj.address;
    const isStart = !tasks.length;
    for (const state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) continue;
        const oid = `${adapter.namespace}.${id}.${state}`;
        let val = obj.data[state];
        const meta = objects[oid];
        if (meta && meta.common) {
            if (meta.common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (meta.common.type === 'number') {
                if (val === 'on' || val === 'true' || val === true) val = 1;
                if (val === 'off' || val === 'false' || val === false) val = 0;
                val = parseFloat(val);
            }
        }
        tasks.push({ type: 'state', id: oid, val: val });
    }
    if (isStart) processTasks();
}

function connect() {
    if (connectTimeout) clearTimeout(connectTimeout);
    let transport;
    const isSerial = adapter.config.type !== 'cuno';

    if (isSerial) {
        const portPath = adapter.config.serialport || '/dev/ttyACM0';
        const baudRate = parseInt(adapter.config.baudrate, 10) || 38400;
        
        adapter.log.info(`Öffne Serialport ${portPath} mit ${baudRate} Baud`);
        
        transport = new SerialPort({
            path: portPath,
            baudRate: baudRate,
            autoOpen: true,
            lock: false,
            hupcl: false 
        });

        transport.on('open', () => {
            adapter.log.info('Physikalischer Serialport wurde erfolgreich geöffnet');
            // DTR/RTS setzen für stabilen Datenfluss bei nanoCULs
            transport.set({ dtr: true, rts: true }, (err) => {
                if (err) adapter.log.warn('Fehler beim Setzen der Port-Signale: ' + err.message);
            });
        });

        transport.on('error', (err) => {
            adapter.log.error('Physikalischer Serialport Fehler: ' + err.message);
        });

    } else {
        adapter.log.info(`Verbinde mit CUNO/Netzwerk: ${adapter.config.ip}:${adapter.config.port}`);
        transport = Net.createConnection(adapter.config.port, adapter.config.ip);
    }

    cul = new Main({
        transport: transport,
        connectionMode: isSerial ? 'serial' : 'telnet',
        mode: adapter.config.mode || 'SlowRF',
        initCmd: adapter.config.initCmd || 'X21',
        parse: true,
        rssi: true
    });

    cul.on('ready', () => {
        adapter.log.info('CUL connected and ready (Handshake erfolgreich)');
        adapter.setState('info.connection', true, true);
    });

    cul.on('data', (raw, obj) => {
        adapter.log.debug(`DATA-EVENT ausgelöst: ${raw}`);
    
        // Schreibt Rohdaten (inkl. Echos) in den Datenpunkt
        adapter.setState('info.rawData', raw, true); 

        if (obj && obj.protocol && obj.protocol !== 'unknown') {
            handleDeviceMessage(obj);
        }
    });   
    
    cul.on('error', err => {
        adapter.log.error('CUL Logik-Fehler: ' + err);
        adapter.setState('info.connection', false, true);
        if (!connectTimeout) connectTimeout = setTimeout(connect, 10000);
    });
}

function main() {
    adapter.getForeignObject('cul.meta.roles', (err, res) => {
        if (res && res.native) metaRoles = res.native;
        
        adapter.getObjectView('system', 'device', { startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999' }, (err, res) => {
            if (res) res.rows.forEach(row => objects[row.id] = row.value);
            
            adapter.getObjectView('system', 'state', { startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999' }, (err, res) => {
                if (res) res.rows.forEach(row => objects[row.id] = row.value);
                connect();
                adapter.subscribeStates('*');
            });
        });
    });
}

startAdapter();
