/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

// Nutzt die lokale gepatchte lib (cul.js), die wir zuvor besprochen haben
const Main = process.env.DEBUG ? require('./lib/debugCul.js') : require('./lib/cul.js');
const adapterName = require('./package.json').name.split('.').pop();
const utils = require('@iobroker/adapter-core');
const { SerialPort } = require('serialport');
const Net = require('net');

let cul;
const objects = {};
let metaRoles = {};
let connectTimeout;
let checkConnectionTimer;
let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, { name: adapterName });
    adapter = new utils.Adapter(options);

    adapter.on('stateChange', (id, state) => {
        if (state && !state.ack) {
            adapter.log.debug(`State Change ${id}, State: ${JSON.stringify(state)}`);
            const oAddr = id.split('.');
            if (oAddr.length < 5) {
                adapter.log.error('Invalid id used');
                return;
            }

            const sHousecode = oAddr[3].substring(0, 4);
            const sAddress = oAddr[3].substring(4, 6);

            if (oAddr[2] === 'FS20' || adapter.config.experimental === true || adapter.config.experimental === 'true') {
                switch (oAddr[4]) {
                    case 'cmdRaw':
                        sendCommand({ protocol: oAddr[2], housecode: sHousecode, address: sAddress, command: state.val });
                        break;
                    default:
                        adapter.log.error(`Write of State ${oAddr[4]} currently not implemented`);
                        break;
                }
            } else {
                adapter.log.error('Only FS20 Devices are tested. Support: https://github.com/ioBroker/ioBroker.cul');
            }
        }
    });

    adapter.on('unload', callback => {
        if (connectTimeout) clearTimeout(connectTimeout);
        if (checkConnectionTimer) clearTimeout(checkConnectionTimer);
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
        checkPort(err => {
            if (!err || process.env.DEBUG) {
                main();
            } else {
                adapter.log.error(`Cannot open port: ${err}`);
            }
        });
    });

    adapter.on('message', obj => {
        if (!obj || !obj.command) return;

        switch (obj.command) {
            case 'listUart':
            case 'listUart5':
                if (obj.callback) {
                    SerialPort.list().then(ports => {
                        // Deine manuelle Ergänzung aus dem Original
                        ports.push({ "path": "/dev/ttyUSB_CUL" });
                        adapter.log.info(`List of ports: ${JSON.stringify(ports)}`);

                        if (obj.command === 'listUart5' && obj.message && obj.message.experimental) {
                            const dirSerial = '/dev/serial/by-id';
                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({
                                label: `${dirSerial}/${item.pnpId || item.path}${item.manufacturer ? ` [${item.manufacturer}]` : ''}`,
                                value: `${dirSerial}/${item.pnpId || item.path}`
                            })), obj.callback);
                        } else {
                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({
                                label: item.path || item.comName,
                                value: item.path || item.comName
                            })), obj.callback);
                        }
                    }).catch(err => {
                        adapter.log.error(`Can not get Serial port list: ${err}`);
                        adapter.sendTo(obj.from, obj.command, [], obj.callback);
                    });
                }
                break;

            case 'send':
                sendCommand(obj.message);
                break;

            case 'sendraw':
                sendRaw(obj.message);
                break;

            default:
                adapter.log.error('No such command: ' + obj.command);
                break;
        }
    });

    return adapter;
}

function sendCommand(o) {
    if (cul) {
        adapter.log.info(`Send command: Housecode: ${o.housecode}; address: ${o.address}; command: ${o.command}`);
        cul.cmd(o.protocol, o.housecode, o.address, o.command);
    }
}

function sendRaw(o) {
    if (cul) {
        adapter.log.info('Send RAW command: ' + o.command);
        cul.write(o.command);
    }
}

function checkConnection(host, port, timeout, callback) {
    timeout = timeout || 10000;
    const socket = Net.createConnection(port, host, () => {
        if (checkConnectionTimer) clearTimeout(checkConnectionTimer);
        socket.end();
        callback(null);
    });

    checkConnectionTimer = setTimeout(() => {
        socket.end();
        callback('Timeout');
    }, timeout);

    socket.on('error', err => {
        if (checkConnectionTimer) clearTimeout(checkConnectionTimer);
        socket.end();
        callback(err);
    });
}

function checkPort(callback) {
    if (adapter.config.type === 'cuno') {
        checkConnection(adapter.config.ip, adapter.config.port, 10000, callback);
    } else {
        if (!adapter.config.serialport) return callback('Port is not selected');
        
        const sPort = new SerialPort({
            path: adapter.config.serialport,
            baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
            autoOpen: false
        });

        sPort.open(err => {
            if (sPort.isOpen) sPort.close();
            callback(err);
        });
    }
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

function setStates(obj) {
    const id = obj.protocol + '.' + obj.address;
    const isStart = !tasks.length;

    for (const state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) continue;
        const oid = `${adapter.namespace}.${id}.${state}`;
        let val = obj.data[state];
        
        // Typ-Konvertierung aus dem Original
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

function connect(callback) {
    const options = {
        connectionMode: adapter.config.type === 'cuno' ? 'telnet' : 'serial',
        serialport: adapter.config.serialport || '/dev/ttyACM0',
        mode: adapter.config.mode || 'SlowRF',
        baudrate: parseInt(adapter.config.baudrate, 10) || 9600,
        scc: adapter.config.type === 'scc',
        coc: adapter.config.type === 'coc',
        host: adapter.config.ip,
        port: adapter.config.port,
        debug: true,
        logger: adapter.log.debug
    };

    cul = new Main(options);

    cul.on('close', () => {
        adapter.setState('info.connection', false, true);
        if (!connectTimeout) {
            connectTimeout = setTimeout(() => {
                connectTimeout = null;
                connect();
            }, 10000);
        }
    });

    cul.on('ready', () => {
        adapter.setState('info.connection', true, true);
        if (typeof callback === 'function') callback();
    });

    cul.on('error', err => adapter.log.error('Error on Cul connection: ' + err));

    cul.on('data', (raw, obj) => {
        adapter.log.debug(`RAW: ${raw}, ${JSON.stringify(obj)}`);
        adapter.setState('info.rawData', raw, true);

        if (!obj || !obj.protocol || (!obj.address && obj.address !== 0)) return;
        
        const id = obj.protocol + '.' + obj.address;
        const isStart = !tasks.length;

        if (!objects[adapter.namespace + '.' + id]) {
            const tmp = JSON.parse(JSON.stringify(obj));
            delete tmp.data;

            const newDevice = {
                _id: adapter.namespace + '.' + id,
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
                    _id: `${adapter.namespace}.${id}.${_state}`,
                    type: 'state',
                    common: common,
                    native: {}
                };
                objects[newState._id] = newState;
                tasks.push({ type: 'object', id: newState._id, obj: newState });
            }
            objects[newDevice._id] = newDevice;
            tasks.push({ type: 'object', id: newDevice._id, obj: newDevice });
        }

        setStates(obj);
        if (isStart) processTasks();
    });
}

function main() {
    adapter.getForeignObject('cul.meta.roles', (err, res) => {
        if (err || !res) {
            adapter.log.error('Object cul.meta.roles missing - reinstall adapter!');
            return;
        }
        metaRoles = res.native;
        
        adapter.getForeignObjects(`${adapter.namespace}.*`, (err, list) => {
            for (const id in list) objects[id] = list[id];
            connect(() => adapter.subscribeStates('*'));
        });
    });
}

if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
