'use strict';
const EventEmitter = require('events');

/**
 * CUL Library - Optimierte Version für Node.js 20/22
 * Fokus: Zuverlässiger Empfang von Funk-Telegrammen (Fernbedienungen)
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
        // Empfang von Datenstücken (Chunks) vom SerialPort
        this.port.on('data', (chunk) => {
            if (!chunk) return;
            
            // Konvertierung des Buffers in Text (UTF-8)
            this.buffer += chunk.toString('utf-8');
            
            // Suche nach JEDEM möglichen Trennzeichen (\n oder \r)
            // Fernbedienungen senden oft nur \r, weshalb split('\n') oft versagt
            let pos;
            while ((pos = this.findFirstBreak(this.buffer)) >= 0) {
                const line = this.buffer.substring(0, pos).trim();
                this.buffer = this.buffer.substring(pos + 1);
                
                if (line.length > 0) {
                    // Telegramm parsen (FS20, HMS etc.)
                    const parsed = this._parse(line);
                    
                    // WICHTIG: Das 'data' Event schickt die Rohdaten an die main.js
                    // Dort wird adapter.setState('info.rawData', line, true) ausgeführt
                    this.emit('data', line, parsed);
                }
            }
        });

        this.port.on('error', (err) => {
            this.emit('error', err);
        });

        // Initialisierungs-Logik für Serial oder Netzwerk
        if (this.options.connectionMode === 'serial') {
            if (this.port.isOpen) {
                // Kurze Verzögerung für stabilen USB-Handshake
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
     * Hilfsfunktion: Findet den ersten Zeilenumbruch (\n oder \r)
     */
    findFirstBreak(str) {
        const n = str.indexOf('\n');
        const r = str.indexOf('\r');
        if (n === -1) return r;
        if (r === -1) return n;
        return Math.min(n, r);
    }

    /**
     * Initialisiert den Stick (Version abfragen + Empfang aktivieren)
     */
    _init() {
        // Test-Kommando senden
        this.write('V'); 
        
        // Empfang einschalten (X21 oder benutzerdefiniertes Kommando)
        setTimeout(() => {
            const cmd = this.options.initCmd || 'X21';
            this.write(cmd);
            this.emit('ready');
        }, 200);
    }

    /**
     * Schreibt Daten an den CUL und fügt das nötige Zeilenende hinzu
     */
    write(data) {
        if (this.port && (this.port.isOpen || this.port.writable)) {
            try {
                this.port.write(data + '\r\n', (err) => {
                    if (err) this.emit('error', 'Write Error: ' + err.message);
                });
            } catch (e) {
                this.emit('error', 'Write Exception: ' + e.message);
            }
        }
    }

    /**
     * Sendet einen Protokoll-Befehl (z.B. FS20)
     */
    cmd(protocol, housecode, address, value) {
        if (protocol === 'FS20') {
            this.write(`F${housecode}${address}${value}`);
        } else {
            this.write(`${protocol}${housecode}${address}${value}`);
        }
    }

    /**
     * Schließt die Verbindung sauber
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
     * Einfacher Parser für bekannte Protokolle
     */
    _parse(line) {
        const raw = line.trim();
        let obj = {
            protocol: 'unknown',
            address: '0000',
            data: { raw: raw }
        };

        // FS20 Protokoll (z.B. F12340101)
        if (raw.match(/^F[A-F0-9]{8}/)) {
            obj.protocol = 'FS20';
            obj.address = raw.substring(1, 7);
            obj.device = 'FS20';
            obj.data = {
                cmd: raw.substring(7, 9),
                state: raw.substring(7, 9)
            };
        }
        // HMS Protokoll (z.B. H1234...)
        else if (raw.startsWith('H') && raw.length >= 10) {
            obj.protocol = 'HMS';
            obj.address = raw.substring(1, 5);
            obj.device = 'HMS';
            obj.data = { type: raw.substring(5, 7), val: raw.substring(7) };
        }

        // RSSI Signalstärke-Auswertung
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
