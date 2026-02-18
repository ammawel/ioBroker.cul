/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

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
                    cul.cmd(oAddr[2], sHousecode, sAddress, state.val);
                }
            }
        }
    });

    adapter.on('unload', callback => {
        if (connectTimeout) clearTimeout(connectTimeout);
        if (cul) {
            try {
                cul.close();
            } catch (e) {
                adapter.log.error(`Cannot close connection: ${e.toString()}`);
            }
        }
        callback();
    });

    adapter.on('ready', () => {
        adapter.setState('info.connection', false, true);
        main();
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
                if (cul) cul.cmd(obj.message.protocol, obj.message.housecode, obj.message.address, obj.message.command);
                break;
            case 'sendraw':
                if (cul) cul.write(obj.message.command);
                break;
        }
    });

    return adapter;
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
                adapter.setForeignObject(task.id, task.obj, (err) => {
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

        if (objects[oid] && objects[oid].common) {
            if (objects[oid].common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (objects[oid].common.type === 'number') {
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
        transport = new SerialPort({
            path: adapter.config.serialport || '/dev/ttyACM0',
            baudRate: parseInt(adapter.config.baudrate, 10) || 38400,
            autoOpen: true,
            lock: false
        });
    } else {
        transport = Net.createConnection(adapter.config.port, adapter.config.ip);
    }

    cul = new Main({
        transport: transport,
        connectionMode: isSerial ? 'serial' : 'telnet',
        mode: adapter.config.mode || 'SlowRF',
        initCmd: adapter.config.initCmd || 'X21',
        parse: true,
        rssi: true,
        debug: true,
        logger: adapter.log.debug
    });

    cul.on('ready', () => {
        adapter.log.info('CUL connected and ready');
        adapter.setState('info.connection', true, true);
    });

    cul.on('data', (raw, obj) => {
        adapter.log.debug(`RAW: ${raw}, ${JSON.stringify(obj)}`);
        adapter.setState('info.rawData', raw, true);
        if (obj && obj.protocol) handleDeviceMessage(obj);
    });

    cul.on('error', err => {
        adapter.log.error('CUL Error: ' + err);
        adapter.setState('info.connection', false, true);
        if (!connectTimeout) connectTimeout = setTimeout(connect, 10000);
    });

    cul.on('close', () => {
        adapter.setState('info.connection', false, true);
        if (!connectTimeout) connectTimeout = setTimeout(connect, 10000);
    });
}

function main() {
    adapter.getForeignObject('cul.meta.roles', (err, res) => {
        if (res && res.native) metaRoles = res.native;
        adapter.getForeignObjects(`${adapter.namespace}.*`, (err, list) => {
            for (const id in list) objects[id] = list[id];
            connect();
            adapter.subscribeStates('*');
        });
    });
}

if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
