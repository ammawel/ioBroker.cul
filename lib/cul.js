/* jshint strict:true */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

/**
 * CUL/COC / culfw Node.js module (Patched for SerialPort v13)
 * https://github.com/hobbyquaker/cul
 */

const { EventEmitter } = require('events');
const { ReadlineParser } = require('@serialport/parser-readline'); // Wichtig: Muss installiert sein!

const protocol = {
    em: require('./em.js'),
    fs20: require('./fs20.js'),
    hms: require('./hms.js'),
    moritz: require('./moritz.js'),
    uniroll: require('./uniroll.js'),
    ws: require('./ws.js'),
    fht: require('./fht.js'),
    esa: require('./esa.js')
};

const commands = {
    F: 'FS20', T: 'FHT', E: 'EM', W: 'WS', H: 'HMS', S: 'ESA',
    R: 'Hoermann', A: 'AskSin', V: 'MORITZ', Z: 'MORITZ',
    o: 'Obis', t: 'TX', U: 'Uniroll', K: 'WS'
};

class Cul extends EventEmitter {
    constructor(options) {
        super();
        const that = this;
        this.options = options || {};
        this.options.initCmd = this.options.initCmd || 'X21';
        this.options.parse = (this.options.parse !== false);
        this.options.rssi = (this.options.rssi !== false);

        if (typeof this.options.transport === 'object') {
            this.port = this.options.transport;
        } else {
            // Port-Initialisierung muss im main.js erfolgen und hier übergeben werden
            throw new Error('No transport/port provided to Cul constructor');
        }

        // SerialPort v13 Parser Setup
        const parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

        parser.on('data', (data) => {
            that.parse(data);
        });

        this.port.on('open', () => {
            if (that.options.initCmd) {
                that.write(that.options.initCmd);
            }
            that.emit('ready');
        });

        this.port.on('error', (err) => {
            that.emit('error', err);
        });
    }

    write(data, callback) {
        if (this.port && this.port.isOpen) {
            this.port.write(data + '\r\n', (err) => {
                if (callback) callback(err);
            });
        } else {
            if (callback) callback(new Error('Port is not open'));
        }
    }

    cmd() {
        const args = Array.from(arguments);
        let callback;
        if (typeof args[args.length - 1] === 'function') {
            callback = args.pop();
        }

        let c = args.shift();
        if (commands[c.toUpperCase()]) {
            c = commands[c.toUpperCase()].toLowerCase();
        }

        if (protocol[c] && typeof protocol[c].cmd === 'function') {
            const message = protocol[c].cmd.apply(null, args);
            if (message) {
                this.write(message, callback);
                return true;
            }
            if (typeof callback === 'function') callback(`cmd ${c} failed`);
            return false;
        }

        if (typeof callback === 'function') callback(`cmd ${c} not implemented`);
        return false;
    }

    parse(data) {
        if (!data) return;
        data = data.toString().trim();

        let message = {};
        let command;
        let p;
        let rssi;

        if (this.options.parse) {
            command = data[0];
            if (commands[command]) {
                p = commands[command].toLowerCase();
                if (protocol[p] && typeof protocol[p].parse === 'function') {
                    message = protocol[p].parse(data) || {};
                }
            }

            // Sicherer RSSI Check (Daten müssen lang genug sein)
            if (this.options.rssi && data.length >= 2) {
                rssi = Number.parseInt(data.slice(-2), 16);
                if (!isNaN(rssi)) {
                    message.rssi = (rssi >= 128 ? (((rssi - 256) / 2) - 74) : ((rssi / 2) - 74));
                }
            }
        }

        this.emit('data', data, message);
    }
}

module.exports = Cul;