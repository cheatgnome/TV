const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const cron = require('node-cron');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class EPGManager {
    constructor() {
        this.epgData = null;
        this.db = null;
        this.dbPath = path.join(__dirname, 'data', 'epg.db');
        this.lastUpdate = null;
        this.isUpdating = false;
        this.CHUNK_SIZE = 5000;
        this.lastEpgUrl = null;
        this.cronJob = null;
        this.cleanupJob = null;
        this.validateAndSetTimezone();
        this.initializeDatabase();
        this.schedulePeriodicCleanup();
    }

    async initializeDatabase() {
        try {
            // Crea directory data se non esiste
            const dataDir = path.join(__dirname, 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // Inizializza SQL.js
            const SQL = await initSqlJs();

            // Carica database esistente o crea nuovo
            if (fs.existsSync(this.dbPath)) {
                const buffer = fs.readFileSync(this.dbPath);
                this.db = new SQL.Database(buffer);
                console.log('✓ Database EPG caricato da disco');
            } else {
                this.db = new SQL.Database();
                console.log('✓ Nuovo database EPG creato');
            }

            // Crea schema
            this.db.run(`
                CREATE TABLE IF NOT EXISTS programs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel_id TEXT NOT NULL,
                    start_time INTEGER NOT NULL,
                    stop_time INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    category TEXT
                );
                
                CREATE INDEX IF NOT EXISTS idx_channel_time 
                    ON programs(channel_id, start_time, stop_time);
                CREATE INDEX IF NOT EXISTS idx_stop_time 
                    ON programs(stop_time);
                    
                CREATE TABLE IF NOT EXISTS channel_icons (
                    channel_id TEXT PRIMARY KEY,
                    icon_url TEXT NOT NULL
                );
                
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
            `);

            console.log('✓ Schema database EPG inizializzato');
        } catch (error) {
            console.error('❌ Errore inizializzazione database:', error);
        }
    }

    saveDatabase() {
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        } catch (error) {
            console.error('❌ Errore salvataggio database:', error);
        }
    }

    normalizeId(id) {
        return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
    }

    validateAndSetTimezone() {
        const tzRegex = /^[+-]\d{1,2}:\d{2}$/;
        const timeZone = process.env.TIMEZONE_OFFSET || '+2:00';

        if (!tzRegex.test(timeZone)) {
            this.timeZoneOffset = '+2:00';
            return;
        }

        this.timeZoneOffset = timeZone;
        const [hours, minutes] = this.timeZoneOffset.substring(1).split(':');
        this.offsetMinutes = (parseInt(hours) * 60 + parseInt(minutes)) *
            (this.timeZoneOffset.startsWith('+') ? 1 : -1);
    }

    formatDateIT(date) {
        if (!date) return '';
        const localDate = new Date(date.getTime() + (this.offsetMinutes * 60000));
        return localDate.toLocaleString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }).replace(/\./g, ':');
    }

    parseEPGDate(dateString) {
        if (!dateString) return null;
        try {
            const regex = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/;
            const match = dateString.match(regex);

            if (!match) return null;

            const [_, year, month, day, hour, minute, second, timezone] = match;
            const tzHours = timezone.substring(0, 3);
            const tzMinutes = timezone.substring(3);
            const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHours}:${tzMinutes}`;

            const date = new Date(isoString);
            return isNaN(date.getTime()) ? null : date;
        } catch (error) {
            console.error('Errore nel parsing della data EPG:', error);
            return null;
        }
    }

    async initializeEPG(url) {
        // Se l'URL è lo stesso e il database ha dati, skip
        if (this.lastEpgUrl === url && this.isEPGAvailable()) {
            console.log('EPG già inizializzato e valido, skip...');
            return;
        }

        console.log('\\n=== Inizializzazione EPG ===');
        console.log('URL EPG:', url);
        this.lastEpgUrl = url;
        await this.startEPGUpdate(url);

        if (!this.cronJob) {
            console.log('Schedulazione aggiornamento EPG giornaliero alle 3:00');
            this.cronJob = cron.schedule('0 3 * * *', () => {
                console.log('Esecuzione aggiornamento EPG programmato');
                this.startEPGUpdate(this.lastEpgUrl);
            });
        }
        console.log('=== Inizializzazione EPG completata ===\\n');
    }

    cleanupOldPrograms() {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;

        console.log('\\n=== Pulizia Programmi EPG Obsoleti ===');

        const result = this.db.run('DELETE FROM programs WHERE stop_time < ?', [oneHourAgo]);

        console.log(`✓ Rimossi ${result.changes || 0} programmi obsoleti`);

        // Salva database dopo pulizia
        this.saveDatabase();

        const channelsCount = this.db.exec('SELECT COUNT(DISTINCT channel_id) as count FROM programs')[0]?.values[0]?.[0] || 0;
        console.log(`✓ Canali rimanenti con EPG: ${channelsCount}`);
        console.log('=== Pulizia Completata ===\\n');

        return result.changes || 0;
    }

    schedulePeriodicCleanup() {
        if (this.cleanupJob) {
            return;
        }

        this.cleanupJob = cron.schedule('0 */6 * * *', () => {
            console.log('\\n⏰ Esecuzione pulizia periodica EPG programmata...');
            const removed = this.cleanupOldPrograms();
            if (removed > 0) {
                console.log(`✓ Memoria liberata: ~${(removed * 0.5).toFixed(1)} KB stimati`);
            }
        });

        console.log('✓ Pulizia periodica EPG schedulata (ogni 6 ore)');
    }

    async downloadAndProcessEPG(epgUrl) {
        console.log('\\nDownload EPG da:', epgUrl.trim());
        try {
            const response = await axios.get(epgUrl.trim(), {
                responseType: 'arraybuffer',
                timeout: 100000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept-Encoding': 'gzip, deflate, br'
                }
            });

            let xmlString;
            try {
                xmlString = await gunzip(response.data);
                xmlString = xmlString.toString('utf8');
            } catch (gzipError) {
                try {
                    xmlString = zlib.inflateSync(response.data);
                    xmlString = xmlString.toString('utf8');
                } catch (zlibError) {
                    xmlString = response.data.toString('utf8');
                }
            }

            console.log('Inizio parsing XML...');
            const xmlData = await parseStringPromise(xmlString);
            console.log('Parsing XML completato');

            if (!xmlData || !xmlData.tv) {
                throw new Error('Struttura XML EPG non valida');
            }

            await this.processEPGInChunks(xmlData);
        } catch (error) {
            console.error(`❌ Errore EPG: ${error.message}`);
        }
    }

    async processEPGInChunks(data) {
        console.log('Inizio processamento EPG...');

        if (!data.tv) {
            console.error('❌ Errore: Nessun oggetto tv trovato nel file EPG');
            return;
        }

        // Processa icone
        if (data.tv && data.tv.channel) {
            console.log(`Trovati ${data.tv.channel.length} canali nel file EPG`);

            const stmt = this.db.prepare('INSERT OR REPLACE INTO channel_icons (channel_id, icon_url) VALUES (?, ?)');

            for (const channel of data.tv.channel) {
                const id = this.normalizeId(channel.$.id);
                const icon = channel.icon?.[0]?.$?.src;
                if (id && icon) {
                    stmt.run([id, icon]);
                }
            }
            stmt.free();
        }

        if (!data.tv || !data.tv.programme) {
            console.error('❌ Errore: Nessun programma trovato nel file EPG');
            return;
        }

        const programs = data.tv.programme;
        let totalProcessed = 0;

        console.log(`\\nProcessamento di ${programs.length} voci EPG in blocchi di ${this.CHUNK_SIZE}`);

        // Definisci limiti temporali
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        let skippedOld = 0;
        let skippedFuture = 0;

        // Prepara statement
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO programs 
            (channel_id, start_time, stop_time, title, description, category)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (let i = 0; i < programs.length; i += this.CHUNK_SIZE) {
            const chunk = programs.slice(i, i + this.CHUNK_SIZE);

            for (const program of chunk) {
                const channelId = this.normalizeId(program.$.channel);
                const start = this.parseEPGDate(program.$.start);
                const stop = this.parseEPGDate(program.$.stop);

                if (!start || !stop) continue;

                // Salta programmi troppo vecchi
                if (stop < oneHourAgo) {
                    skippedOld++;
                    continue;
                }

                // Salta programmi troppo lontani nel futuro
                if (start > sevenDaysFromNow) {
                    skippedFuture++;
                    continue;
                }

                const title = program.title?.[0]?._ || program.title?.[0]?.$?.text || program.title?.[0] || 'Nessun Titolo';
                const description = program.desc?.[0]?._ || program.desc?.[0]?.$?.text || program.desc?.[0] || '';
                const category = program.category?.[0]?._ || program.category?.[0]?.$?.text || program.category?.[0] || '';

                stmt.run([
                    channelId,
                    start.getTime(),
                    stop.getTime(),
                    title,
                    description,
                    category
                ]);
                totalProcessed++;
            }

            if ((i + this.CHUNK_SIZE) % 50000 === 0) {
                console.log(`Progresso: processate ${i + this.CHUNK_SIZE} voci...`);
            }
        }

        stmt.free();

        // Salva database
        this.saveDatabase();

        console.log('\\nRiepilogo Processamento EPG:');
        console.log(`✓ Totale voci processate: ${totalProcessed}`);
        console.log(`✓ Programmi vecchi saltati: ${skippedOld}`);
        console.log(`✓ Programmi futuri saltati (oltre 7 giorni): ${skippedFuture}`);
        console.log(`✓ Risparmio memoria stimato: ~${((skippedOld + skippedFuture) * 0.5).toFixed(1)} KB`);
    }

    async readExternalFile(url) {
        if (Array.isArray(url)) {
            return url;
        }

        if (url.includes(',')) {
            return url.split(',').map(u => u.trim());
        }

        try {
            console.log('Tentativo lettura file:', url);

            if (url.endsWith('.gz')) {
                console.log('File gzipped EPG trovato');
                return [url];
            }

            const response = await axios.get(url.trim());
            const content = response.data;

            if (typeof content === 'string' &&
                (content.includes('<?xml') || content.includes('<tv'))) {
                console.log('File EPG trovato direttamente');
                return [url];
            }

            const urls = content.split('\n')
                .filter(line => line.trim() !== '' && line.startsWith('http'));

            if (urls.length > 0) {
                console.log('Lista URLs trovata:', urls);
                return urls;
            }

            console.log('Nessun URL trovato, uso URL originale');
            return [url];

        } catch (error) {
            console.error('Errore nella lettura del file:', error);
            return [url];
        }
    }

    async startEPGUpdate(url) {
        if (this.isUpdating) {
            console.log('⚠️  Aggiornamento EPG già in corso, skip...');
            return;
        }

        console.log('\\n=== Inizio Aggiornamento EPG ===');
        const startTime = Date.now();

        try {
            this.isUpdating = true;
            console.log('Inizio lettura URLs EPG...');

            const epgUrls = await this.readExternalFile(url);
            console.log('URLs trovati:', epgUrls);

            // Pulisci database
            this.db.run('DELETE FROM programs');
            this.db.run('DELETE FROM channel_icons');

            for (const epgUrl of epgUrls) {
                console.log('\\nProcesso URL EPG:', epgUrl);
                await this.downloadAndProcessEPG(epgUrl);
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            const channelsCount = this.db.exec('SELECT COUNT(DISTINCT channel_id) as count FROM programs')[0]?.values[0]?.[0] || 0;
            const iconsCount = this.db.exec('SELECT COUNT(*) as count FROM channel_icons')[0]?.values[0]?.[0] || 0;

            console.log(`\\n✓ Aggiornamento EPG completato in ${duration} secondi`);
            console.log(`✓ Totale canali con dati EPG: ${channelsCount}`);
            console.log(`✓ Totale canali con icone: ${iconsCount}`);

            // Esegui pulizia dopo l'aggiornamento
            console.log('\\n🧹 Esecuzione pulizia post-aggiornamento...');
            this.cleanupOldPrograms();

            console.log('=== Aggiornamento EPG Completato ===\\n');

        } catch (error) {
            console.error('❌ Errore dettagliato durante l\'aggiornamento EPG:', error);
            console.error('Stack:', error.stack);
        } finally {
            this.isUpdating = false;
            this.lastUpdate = Date.now();
        }
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.db) return null;
        const normalizedId = this.normalizeId(channelId);
        const now = Date.now();

        try {
            const result = this.db.exec(`
                SELECT title, description, category, start_time, stop_time
                FROM programs
                WHERE channel_id = ? AND start_time <= ? AND stop_time >= ?
                LIMIT 1
            `, [normalizedId, now, now]);

            if (result.length > 0 && result[0].values.length > 0) {
                const row = result[0].values[0];
                return {
                    title: row[0],
                    description: row[1],
                    category: row[2],
                    start: this.formatDateIT(new Date(row[3])),
                    stop: this.formatDateIT(new Date(row[4]))
                };
            }
        } catch (error) {
            console.error('Errore getCurrentProgram:', error);
        }

        return null;
    }

    getUpcomingPrograms(channelId) {
        if (!channelId || !this.db) return [];
        const normalizedId = this.normalizeId(channelId);
        const now = Date.now();

        try {
            const result = this.db.exec(`
                SELECT title, description, category, start_time, stop_time
                FROM programs
                WHERE channel_id = ? AND start_time >= ?
                ORDER BY start_time ASC
                LIMIT 2
            `, [normalizedId, now]);

            if (result.length > 0) {
                return result[0].values.map(row => ({
                    title: row[0],
                    description: row[1],
                    category: row[2],
                    start: this.formatDateIT(new Date(row[3])),
                    stop: this.formatDateIT(new Date(row[4]))
                }));
            }
        } catch (error) {
            console.error('Errore getUpcomingPrograms:', error);
        }

        return [];
    }

    getChannelIcon(channelId) {
        if (!channelId || !this.db) return null;
        const normalizedId = this.normalizeId(channelId);

        try {
            const result = this.db.exec(`
                SELECT icon_url FROM channel_icons WHERE channel_id = ?
            `, [normalizedId]);

            if (result.length > 0 && result[0].values.length > 0) {
                return result[0].values[0][0];
            }
        } catch (error) {
            console.error('Errore getChannelIcon:', error);
        }

        return null;
    }

    needsUpdate() {
        if (!this.lastUpdate) return true;
        return (Date.now() - this.lastUpdate) >= (24 * 60 * 60 * 1000);
    }

    isEPGAvailable() {
        if (!this.db || this.isUpdating) return false;

        try {
            const result = this.db.exec('SELECT COUNT(*) as count FROM programs');
            return result.length > 0 && result[0].values[0][0] > 0;
        } catch {
            return false;
        }
    }

    getStatus() {
        let channelsCount = 0;
        let iconsCount = 0;
        let programsCount = 0;

        if (this.db) {
            try {
                const channelsResult = this.db.exec('SELECT COUNT(DISTINCT channel_id) as count FROM programs');
                channelsCount = channelsResult[0]?.values[0]?.[0] || 0;

                const iconsResult = this.db.exec('SELECT COUNT(*) as count FROM channel_icons');
                iconsCount = iconsResult[0]?.values[0]?.[0] || 0;

                const programsResult = this.db.exec('SELECT COUNT(*) as count FROM programs');
                programsCount = programsResult[0]?.values[0]?.[0] || 0;
            } catch (error) {
                console.error('Errore getStatus:', error);
            }
        }

        return {
            isUpdating: this.isUpdating,
            lastUpdate: this.lastUpdate ? this.formatDateIT(new Date(this.lastUpdate)) : 'Mai',
            channelsCount,
            iconsCount,
            programsCount,
            timezone: this.timeZoneOffset,
            storageType: 'SQLite (Disk)'
        };
    }

    checkMissingEPG(m3uChannels) {
        if (!this.db) return;

        try {
            const result = this.db.exec('SELECT DISTINCT channel_id FROM programs');
            const epgChannels = result[0]?.values.map(row => row[0]) || [];
            const missingEPG = [];

            m3uChannels.forEach(ch => {
                const tvgId = ch.streamInfo?.tvg?.id;
                if (tvgId) {
                    const normalizedTvgId = this.normalizeId(tvgId);
                    if (!epgChannels.some(epgId => this.normalizeId(epgId) === normalizedTvgId)) {
                        missingEPG.push(ch);
                    }
                }
            });

            if (missingEPG.length > 0) {
                console.log('\\n=== Canali M3U senza EPG ===');
                missingEPG.forEach(ch => {
                    console.log(`${ch.streamInfo?.tvg?.id}=`);
                });
                console.log(`✓ Totale canali M3U senza EPG: ${missingEPG.length}`);
                console.log('=============================\\n');
            }
        } catch (error) {
            console.error('Errore checkMissingEPG:', error);
        }
    }
}

module.exports = new EPGManager();
