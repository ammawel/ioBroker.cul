'use strict';
const EventEmitter = require('events');

/**
 * CUL Library für Node.js 20/22
 * Unterstützt SerialPort v13 und Netzwerk-Verbindungen (CUNO)
 */
class Cul extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        
        // Validierung des Transports
        if (!this.options.transport) {
            throw new Error('No transport/port provided to Cul constructor');
        }

        this.port = this.options.transport;
        this.buffer = '';
        this.isReady = false;

        this._setup();
    }

    /**
     * Setzt die Event-Listener für den Hardware-Port
     */
    _setup() {
        // Datenempfang und Buffer-Handling
        this.port.on('data', (data) => {
            this.buffer += data.toString();
            const lines = this.buffer.split(/\r?\n/);
            this.buffer = lines.pop(); // Rest im Buffer behalten
            lines.forEach(line => {
                if (line.length > 0) {
                    this._parse(line);
                }
            });
        });

        // Fehlerweiterleitung an den Adapter
        this.port.on('error', (err) => {
            this.emit('error', err);
        });

        // Initialisierung je nach Verbindungsart
        if (this.options.connectionMode === 'serial') {
            if (this.port.isOpen) {
                this._init();
            } else {
                this.port.on('open', () => this._init());
            }
        } else {
            // Für Telnet/CUNO
            if (this.port.writable) {
                this._init();
            } else {
                this.port.on('connect', () => this._init());
            }
        }
    }

    /**
     * Sendet den Initialisierungsbefehl an den Stick
     */
    _init() {
        const cmd = this.options.initCmd || 'X21';
        this.write(cmd);
        this.isReady = true;
        this.emit('ready');
    }

    /**
     * Schreibt Daten an den CUL (fügt Linebreak hinzu)
     */
    write(data) {
        if (this.port) {
            try {
                this.port.write(data + '\r\n');
            } catch (e) {
                this.emit('error', 'Write failed: ' + e.message);
            }
        }
    }

    /**
     * Sendet strukturierte Befehle (z.B. FS20)
     */
    cmd(protocol, housecode, address, value) {
        if (protocol === 'FS20') {
            // Format: F + Housecode + Address + Value
            this.write(`F${housecode}${address}${value}`);
        } else {
            // Fallback für experimentelle/andere Protokolle
            this.write(`${protocol}${housecode}${address}${value}`);
        }
    }

    /**
     * Schließt die Verbindung sauber
     */
    close() {
        if (this.port) {
            this.isReady = false;
            try {
                if (typeof this.port.close === 'function') {
                    this.port.close();
                } else if (typeof this.port.destroy === 'function') {
                    this.port.destroy();
                }
            } catch (e) {
                // Ignore close errors
            }
        }
    }

    /**
     * Parser-Logik für eingehende Datenpakete
     * @param {string} line Rohdaten vom Stick
     */
    _parse(line) {
        const raw = line.trim();
        let obj = null;

        // 1. FS20 Protokoll (Startet oft mit F)
        if (raw.startsWith('F') && raw.length >= 9) {
            obj = {
                protocol: 'FS20',
                address: raw.substring(1, 7),
                device: 'FS20',
                data: {
                    cmd: raw.substring(7, 9),
                    state: raw.substring(7, 9)
                }
            };
        } 
        // 2. HMS (Startet oft mit H)
        else if (raw.startsWith('H') && raw.length >= 10) {
            obj = {
                protocol: 'HMS',
                address: raw.substring(1, 5),
                device: 'HMS',
                data: {
                    type: raw.substring(5, 7),
                    value: raw.substring(7)
                }
            };
        }
        // 3. Andere/Unbekannte Protokolle
        else {
            obj = {
                protocol: 'UNKNOWN',
                address: '0000',
                data: {
                    raw: raw
                }
            };
        }

        // RSSI Wert extrahieren (falls vorhanden, am Ende der Zeile)
        if (this.options.rssi && raw.length > 2) {
            // Viele CULs hängen ein Byte für die Signalstärke an
            const rssiHex = raw.slice(-2);
            if (!isNaN(parseInt(rssiHex, 16))) {
                obj.data.rssi = (parseInt(rssiHex, 16) / 2) - 74; // Standard CUL RSSI Formel
            }
        }

        // Daten an main.js übergeben
        this.emit('data', raw, obj);
    }
}

module.exports = Cul;
