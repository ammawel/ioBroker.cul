'use strict';
const EventEmitter = require('events');

/**
 * CUL Library - Optimierte Version für Node.js 20/22
 * Fokus: Sofortige Weitergabe von Empfangsdaten an die main.js
 */
class Cul extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        
        if (!this.options.transport) {
            throw new Error('No transport provided to Cul constructor');
        }

        this.port = this.options.transport;
        this.buffer = '';
        this._setup();
    }

    /**
     * Setzt die Event-Listener für den Hardware-Port
     */
    _setup() {
        // Der "Staubsauger"-Modus für den Datenempfang
        this.port.on('data', (chunk) => {
            if (!chunk) return;
            
            // Konvertierung des Buffers in Text (UTF-8)
            this.buffer += chunk.toString('utf-8');
            
            // Suche nach JEDEM möglichen Trennzeichen (\n oder \r)
            // Dies ist entscheidend für Fernbedienungen, die oft kein \n senden
            let pos;
            while ((pos = this.findFirstBreak(this.buffer)) >= 0) {
                const line = this.buffer.substring(0, pos).trim();
                this.buffer = this.buffer.substring(pos + 1);
                
                if (line.length > 0) {
                    // Telegramm parsen
                    const parsed = this._parse(line);
                    
                    // EVENT AN MAIN.JS FEUERN:
                    // Das triggert in der main.js: adapter.setState('info.rawData', raw, true)
                    this.emit('data', line, parsed);
                }
            }
        });

        this.port.on('error', (err) => {
            this.emit('error', err);
        });

        // Initialisierungs-Logik
        if (this.options.connectionMode === 'serial') {
            if (this.port.isOpen) {
                // Verzögerung hilft dem CH340 Chip, stabil zu werden
                setTimeout(() => this._init(), 500); 
            } else {
                this.port.on('open', () => setTimeout(() => this._init(), 500));
            }
        } else {
            this.port.on('connect', () => this._init());
            if (this.port.writable) this._init();
        }
    }

    /**
     * Hilfsfunktion zum Finden von Zeilenumbrüchen
     */
    findFirstBreak(str) {
        const n = str.indexOf('\n');
        const r = str.indexOf('\r');
        if (n === -1) return r;
        if (r === -1) return n;
        return Math.min(n, r);
    }

    /**
     * Sendet Initialisierungsbefehle an den Stick
     */
    _init() {
        // Versionsabfrage als Test
        this.write('V'); 
        
        // Empfang aktivieren (X21)
        setTimeout(() => {
            const cmd = this.options.initCmd || 'X21';
            this.write(cmd);
            this.emit('ready');
        }, 200);
    }

    /**
     * Schreibt Rohdaten an den CUL
     */
    write(data) {
        if (this.port && (this.port.isOpen || this.port.writable)) {
            try {
                // Fügt \r\n hinzu, damit der Stick den Befehl erkennt
                this.port.write(data + '\r\n', (err) => {
                    if (err) this.emit('error', 'Write Error: ' + err.message);
                });
            } catch (e) {
                this.emit('error', 'Write Exception: ' + e.message);
            }
        }
    }

    /**
     * Sendet FS20/SlowRF Befehle
     */
    cmd(protocol, housecode, address, value) {
        if (protocol === 'FS20') {
            this.write(`F${housecode}${address}${value}`);
        } else {
            this.write(`${protocol}${housecode}${address}${value}`);
        }
    }

    /**
     * Hardware-Verbindung sauber schließen
     */
    close() {
        if (this.port) {
            try {
                if (typeof this.port.close === 'function') this.port.close();
                else if (typeof this.port.destroy === 'function') this.port.destroy();
            } catch (e) {}
        }
    }

    /**
     * Parser für eingehende Telegramme
     */
    _parse(line) {
        const raw = line.trim();
        let obj = {
            protocol: 'unknown',
            address: '0000',
            data: { raw: raw }
        };

        // FS20 (z.B. F12340101)
        if (raw.match(/^F[A-F0-9]{8}/)) {
            obj.protocol = 'FS20';
            obj.address = raw.substring(1, 7);
            obj.device = 'FS20';
            obj.data = {
                cmd: raw.substring(7, 9),
                state: raw.substring(7, 9)
            };
        }
        // HMS (z.B. H1234...)
        else if (raw.startsWith('H') && raw.length >= 10) {
            obj.protocol = 'HMS';
            obj.address = raw.substring(1, 5);
            obj.device = 'HMS';
            obj.data = { type: raw.substring(5, 7), val: raw.substring(7) };
        }

        // RSSI am Ende extrahieren
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
