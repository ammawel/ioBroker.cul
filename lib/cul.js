'use strict';
const EventEmitter = require('events');

/**
 * CUL Library - Vollständige Version für Node.js 20/22
 * Optimiert für SerialPort v13 und zuverlässigen Fernbedienungs-Empfang
 */
class Cul extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        
        // Validierung des Hardware-Transports
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
        // Datenempfang vom Stick
        this.port.on('data', (chunk) => {
            if (!chunk) return;
            
            // Konvertierung des Buffers in Text
            this.buffer += chunk.toString('utf-8');
            
            // Suche nach Zeilenumbrüchen (\n oder \r)
            let pos;
            while ((pos = this.buffer.indexOf('\n')) >= 0 || (pos = this.buffer.indexOf('\r')) >= 0) {
                const line = this.buffer.substring(0, pos).trim();
                // Rest im Puffer behalten
                this.buffer = this.buffer.substring(pos + 1);
                
                if (line.length > 0) {
                    // Telegramm parsen
                    const parsed = this._parse(line);
                    
                    // Event an main.js feuern (für info.rawData und Logik)
                    this.emit('data', line, parsed);
                }
            }
        });

        this.port.on('error', (err) => {
            this.emit('error', err);
        });

        // Verbindung initialisieren
        if (this.options.connectionMode === 'serial') {
            if (this.port.isOpen) {
                // Kurze Verzögerung, damit der Port nach dem Öffnen bereit für Befehle ist
                setTimeout(() => this._init(), 500); 
            } else {
                this.port.on('open', () => setTimeout(() => this._init(), 500));
            }
        } else {
            // CUNO / Netzwerk
            this.port.on('connect', () => this._init());
            if (this.port.writable) this._init();
        }
    }

    /**
     * Sendet Initialisierungsbefehle an den Stick
     */
    _init() {
        // 'V' fragt die Firmware-Version ab (Test der Kommunikation)
        this.write('V'); 
        
        // Aktiviert den Empfangsmodus (Standard: X21)
        setTimeout(() => {
            const cmd = this.options.initCmd || 'X21';
            this.write(cmd);
            this.emit('ready');
        }, 200);
    }

    /**
     * Schreibt Rohdaten an den CUL (fügt Linebreak hinzu)
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
     * Sendet strukturierte Protokoll-Befehle
     */
    cmd(protocol, housecode, address, value) {
        if (protocol === 'FS20') {
            // Format: F + Housecode + Address + Command
            this.write(`F${housecode}${address}${value}`);
        } else {
            // Generischer Versand
            this.write(`${protocol}${housecode}${address}${value}`);
        }
    }

    /**
     * Schließt die Hardware-Verbindung
     */
    close() {
        if (this.port) {
            try {
                if (typeof this.port.close === 'function') {
                    this.port.close();
                } else if (typeof this.port.destroy === 'function') {
                    this.port.destroy();
                }
            } catch (e) {
                // Fehler beim Schließen ignorieren
            }
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

        // RSSI (Signalstärke) extrahieren, falls konfiguriert
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
