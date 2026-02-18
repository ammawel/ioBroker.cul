'use strict';
const EventEmitter = require('events');

/**
 * CUL Library - Vollständige Version für Node.js 20/22
 * Fokus auf Empfangsstabilität und rawData-Update
 */
class Cul extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        
        // Validierung: Ohne Transport (SerialPort/Net) kann die Lib nicht arbeiten
        if (!this.options.transport) {
            throw new Error('No transport provided to Cul constructor');
        }

        this.port = this.options.transport;
        this.buffer = '';
        this._setup();
    }

_setup() {
        // Datenempfang vom Stick
        this.port.on('data', (data) => {
            this.buffer += data.toString();
            const lines = this.buffer.split(/\r?\n/);
            this.buffer = lines.pop(); 

            lines.forEach(line => {
                const raw = line.trim();
                if (raw.length > 0) {
                    const parsed = this._parse(raw);
                    this.emit('data', raw, parsed);
                }
            });
        });

        this.port.on('error', (err) => {
            this.emit('error', err);
        });

        // Verbindung initialisieren - GEÄNDERTE LOGIK:
        if (this.options.connectionMode === 'serial') {
            if (this.port.isOpen) {
                // Falls Port schon offen ist, sofort initialisieren
                setTimeout(() => this._init(), 100); 
            } else {
                this.port.on('open', () => this._init());
            }
        } else {
            this.port.on('connect', () => this._init());
            if (this.port.writable) this._init();
        }
    }

    
    _init() {
        // X21 ist der Befehl, der den CUL in den Reporting-Modus versetzt
        this.write(this.options.initCmd || 'X21');
        this.emit('ready');
    }

    write(data) {
        if (this.port) {
            try {
                this.port.write(data + '\r\n');
            } catch (e) {
                this.emit('error', 'Write Error: ' + e.message);
            }
        }
    }

    cmd(protocol, housecode, address, value) {
        if (protocol === 'FS20') {
            this.write(`F${housecode}${address}${value}`);
        } else {
            // Generischer Versand für andere Protokolle
            this.write(`${protocol}${housecode}${address}${value}`);
        }
    }

    close() {
        if (this.port) {
            try {
                if (typeof this.port.close === 'function') this.port.close();
                else if (typeof this.port.destroy === 'function') this.port.destroy();
            } catch (e) {}
        }
    }

    /**
     * Der Parser: Er entscheidet, ob ein Telegramm erkannt wird.
     * Wenn nichts erkannt wird, wird es als 'unknown' markiert, 
     * landet aber trotzdem in info.rawData!
     */
    _parse(line) {
        const raw = line.trim();
        
        // Standard-Objektstruktur
        let obj = {
            protocol: 'unknown',
            address: '0000',
            data: { raw: raw }
        };

        // FS20 Erkennung (z.B. F12340101)
        if (raw.match(/^F[A-F0-9]{8}/)) {
            obj.protocol = 'FS20';
            obj.address = raw.substring(1, 7);
            obj.device = 'FS20';
            obj.data = {
                cmd: raw.substring(7, 9),
                state: raw.substring(7, 9)
            };
        }
        // HMS Erkennung (z.B. H1234...)
        else if (raw.startsWith('H') && raw.length >= 10) {
            obj.protocol = 'HMS';
            obj.address = raw.substring(1, 5);
            obj.device = 'HMS';
            obj.data = {
                type: raw.substring(5, 7),
                val: raw.substring(7)
            };
        }
        // ESA / EM1000
        else if (raw.startsWith('E') && raw.length >= 10) {
            obj.protocol = 'EM';
            obj.address = raw.substring(1, 5);
            obj.data = { val: raw.substring(5) };
        }

        // RSSI (Signalstärke) am Ende der Zeile extrahieren
        if (this.options.rssi && raw.length > 2) {
            const rssiHex = raw.slice(-2);
            const rssiVal = parseInt(rssiHex, 16);
            if (!isNaN(rssiVal)) {
                obj.data.rssi = (rssiVal / 2) - 74;
            }
        }

        return obj;
    }
}

module.exports = Cul;

