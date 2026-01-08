const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cron = require('node-cron');

class PythonResolver {
    constructor() {
        this.scriptPath = path.join(__dirname, 'resolver_script.py');
        this.resolvedLinksCache = new Map();
        this.cacheExpiryTime = 20 * 60 * 1000; // 20 minutes of cache for resolved links
        this.lastExecution = null;
        this.lastError = null;
        this.isRunning = false;
        this.scriptUrl = null;
        this.cronJob = null;
        this.updateInterval = null;
        this.pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        // Crea la directory temp se non esiste
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'));
        }
    }

    /**
     * Download the Python resolver script from the provided URL
     * @param {string} url - Script URL
     * @returns {Promise<boolean>} - true if download succeeded
     */
    async downloadScript(url) {
        try {
            console.log(`\n=== Downloading Python resolver script from ${url} ===`);
            this.scriptUrl = url;
            
            const response = await axios.get(url, { responseType: 'text' });
            fs.writeFileSync(this.scriptPath, response.data);
            
            // Verify that the script contains resolve_link
            if (!response.data.includes('def resolve_link') && !response.data.includes('def resolve_stream')) {
                this.lastError = 'The script must contain a resolve_link or resolve_stream function';
                console.error(`❌ ${this.lastError}`);
                return false;
            }
            
            return true;
        } catch (error) {
            console.error('❌ Error downloading Python resolver script:', error.message);
            this.lastError = `Download error: ${error.message}`;
            return false;
        }
    }

    /**
     * Check resolver script health
     * @returns {Promise<boolean>} - true if script is valid
     */
    async checkScriptHealth() {
        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Python resolver script not found');
            this.lastError = 'Python resolver script not found';
            return false;
        }

        try {
            // Verify that Python is installed
            await execAsync(`${this.pythonCmd} --version`);
            
            // Run the script with --check to verify validity
            const { stdout, stderr } = await execAsync(`${this.pythonCmd} ${this.scriptPath} --check`);
            
            if (stderr && !stderr.includes('resolver_ready')) {
                console.warn('⚠️ Warning during script check:', stderr);
            }
            
            return stdout.includes('resolver_ready') || stderr.includes('resolver_ready');
        } catch (error) {
            console.error('❌ Error checking resolver script:', error.message);
            this.lastError = `Verification error: ${error.message}`;
            return false;
        }
    }


    /**
     * Resolve a URL via the Python script
     * @param {string} url - URL to resolve
     * @param {object} headers - Headers to pass to the script
     * @param {string} channelName - Channel name (for logging)
     * @param {object} proxyConfig - Proxy configuration (optional)
     * @returns {Promise<object>} - Object with resolved URL and headers
     */
    async resolveLink(url, headers = {}, channelName = 'unknown', proxyConfig = null) {
        // Cache check
        const cacheKey = `${url}:${JSON.stringify(headers)}`;
        const cachedResult = this.resolvedLinksCache.get(cacheKey);
        if (cachedResult && (Date.now() - cachedResult.timestamp) < this.cacheExpiryTime) {
            console.log(`✓ Using cached URL for: ${channelName}`);
            return cachedResult.data;
        }
    
        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Python resolver script not found');
            this.lastError = 'Python resolver script not found';
            return null;
        }
    
        if (this.isRunning) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    
        try {
            this.isRunning = true;
            console.log(`\n=== Resolving URL for: ${channelName} ===`);
    
            // Crea un file temporaneo con i parametri di input
            const inputParams = {
                url: url,
                headers: headers,
                channel_name: channelName,
                proxy_config: proxyConfig // Aggiungi la configurazione del proxy
            };
            
            const inputFile = path.join(__dirname, 'temp', `input_${Date.now()}.json`);
            const outputFile = path.join(__dirname, 'temp', `output_${Date.now()}.json`);
            
            fs.writeFileSync(inputFile, JSON.stringify(inputParams, null, 2));
            
            // Run the Python script with parameters
            const cmd = `${this.pythonCmd} ${this.scriptPath} --resolve "${inputFile}" "${outputFile}"`;
            
            const { stdout, stderr } = await execAsync(cmd);
            
            if (stderr) {
                console.warn('⚠️ Warning during resolution:', stderr);
            }
            
            // Leggi il risultato
            if (fs.existsSync(outputFile)) {
                const resultText = fs.readFileSync(outputFile, 'utf8');
                
                try {
                    const result = JSON.parse(resultText);
                    
                    // Salva in cache
                    this.resolvedLinksCache.set(cacheKey, {
                        timestamp: Date.now(),
                        data: result
                    });
                    
                    this.lastExecution = new Date();
                    this.lastError = null;
                    console.log(`✓ URL resolved for ${channelName}`);
    
    
                    // Elimina i file temporanei
                    try {
                        fs.unlinkSync(inputFile);
                        fs.unlinkSync(outputFile);
                    } catch (e) {
                        console.error('Error cleaning temporary files:', e.message);
                    }
                    return result;
                    
                } catch (parseError) {
                    console.error('❌ Error parsing result:', parseError.message);
                    console.error('Result content:', resultText);
                    this.lastError = `Parsing error: ${parseError.message}`;
                    return null;
                }
            } else {
                console.error('❌ Output file not created');
                this.lastError = 'Output file not created';
                return null;
            }
        } catch (error) {
            console.error('❌ Error resolving URL:', error.message);
            if (error.stderr) console.error('Stderr:', error.stderr);
            this.lastError = `Execution error: ${error.message}`;
            return null;
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Schedule automatic script updates
     * @param {string} timeFormat - Time format "HH:MM" or "H:MM"
     * @returns {boolean} - true if scheduling succeeded
     */
    scheduleUpdate(timeFormat) {
        // Stop existing schedules
        this.stopScheduledUpdates();
        
        // Validate time format
        if (!timeFormat || !/^\d{1,2}:\d{2}$/.test(timeFormat)) {
            console.error('❌ [RESOLVER] Invalid time format. Use HH:MM or H:MM');
            this.lastError = 'Invalid time format. Use HH:MM or H:MM';
            return false;
        }
        
        try {
            // Extract hours and minutes
            const [hours, minutes] = timeFormat.split(':').map(Number);
            
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                console.error('❌ [RESOLVER] Invalid time. Hours: 0-23, Minutes: 0-59');
                this.lastError = 'Invalid time. Hours: 0-23, Minutes: 0-59';
                return false;
            }
            
            // Create cron schedule
            let cronExpression;
            
            if (hours === 0) {
                // Run every X minutes
                cronExpression = `*/${minutes} * * * *`;
                console.log(`✓ [RESOLVER] Schedule set: every ${minutes} minutes`);
            } else {
                // Run every X hours
                cronExpression = `${minutes} */${hours} * * *`;
                console.log(`✓ [RESOLVER] Schedule set: every ${hours} hours and ${minutes} minutes`);
            }
            
            this.cronJob = cron.schedule(cronExpression, async () => {
                console.log(`\n=== [RESOLVER] Automatic resolver script update (${new Date().toLocaleString()}) ===`);
                if (this.scriptUrl) {
                    await this.downloadScript(this.scriptUrl);
                }
                // Clear cache after update
                this.resolvedLinksCache.clear();
            });
            
            this.updateInterval = timeFormat;
            console.log(`✓ [RESOLVER] Automatic update configured: ${timeFormat}`);
            return true;
        } catch (error) {
            console.error('❌ [RESOLVER] Scheduling error:', error.message);
            this.lastError = `Scheduling error: ${error.message}`;
            return false;
        }
    }
    
    /**
     * Stop scheduled updates
     */
    stopScheduledUpdates() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            this.updateInterval = null;
            console.log('✓ Automatic updates stopped');
            return true;
        }
        return false;
    }

    /**
     * Clear resolved link cache
     */
    clearCache() {
        this.resolvedLinksCache.clear();
        console.log('✓ Resolved link cache cleared');
        return true;
    }

    /**
     * Create a resolver script template
     * @returns {Promise<boolean>} - true if template created successfully
     */
    async createScriptTemplate() {
        try {
            const templateContent = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# Python resolver for OMG TV
# This script receives a URL and returns the resolved URL

import sys
import json
import os
import requests
import time
from urllib.parse import urlparse, parse_qs

# Global configuration
API_KEY = "la_tua_api_key"
API_SECRET = "il_tuo_secret"
RESOLVER_VERSION = "1.0.0"

def get_token():
    """
    Example function to obtain an authentication token
    """
    # Custom implementation for obtaining the token
    # This is just a simulation
    token = f"token_{int(time.time())}"
    return token

def resolve_link(url, headers=None, channel_name=None):
    """
    Main function that resolves a link
    Parameters:
    - url: URL to resolve
    - headers: dictionary with HTTP headers to use 
    - channel_name: channel name for logging
    
    Returns:
    - A dictionary with the resolved URL and headers to use
    """
    print(f"Resolving URL: {url}")
    print(f"Channel: {channel_name}")
    
    # Parse URL to extract parameters
    parsed_url = urlparse(url)
    params = parse_qs(parsed_url.query)
    
    # Example: add a token to the URL
    token = get_token()
    
    # ESEMPIO 1: Aggiungi token a URL esistente
    if parsed_url.netloc == "example.com":
        resolved_url = f"{url}&token={token}"
    
    # ESEMPIO 2: Chiama API e ottieni URL reale
    elif "api" in parsed_url.netloc:
        try:
            api_response = requests.get(
                f"https://api.example.com/resolve",
                params={"url": url, "key": API_KEY},
                headers=headers
            )
            if api_response.status_code == 200:
                data = api_response.json()
                resolved_url = data.get("stream_url", url)
            else:
                print(f"API error: {api_response.status_code}")
                resolved_url = url
        except Exception as e:
            print(f"API call error: {str(e)}")
            resolved_url = url
    
    # Caso predefinito: restituisci l'URL originale
    else:
        resolved_url = url
    
    # Aggiungi o modifica gli header
    final_headers = headers.copy() if headers else {}
    
    # Puoi aggiungere header specifici
    final_headers["User-Agent"] = final_headers.get("User-Agent", "Mozilla/5.0")
    final_headers["Authorization"] = f"Bearer {token}"
    
    # Restituisci il risultato
    return {
        "resolved_url": resolved_url,
        "headers": final_headers
    }

def main():
    """
    Funzione principale che gestisce i parametri di input
    """
    # Verifica parametri di input
    if len(sys.argv) < 2:
        print("Utilizzo: python3 resolver.py [--check|--resolve input_file output_file]")
        sys.exit(1)
    
    # Check command: verify that the script is valid
    if sys.argv[1] == "--check":
        print("resolver_ready: True")
        sys.exit(0)
    
    # Comando resolve: risolvi un URL
    if sys.argv[1] == "--resolve" and len(sys.argv) >= 4:
        input_file = sys.argv[2]
        output_file = sys.argv[3]
        
        try:
            # Leggi i parametri di input
            with open(input_file, 'r') as f:
                input_data = json.load(f)
            
            url = input_data.get('url', '')
            headers = input_data.get('headers', {})
            channel_name = input_data.get('channel_name', 'unknown')
            
            # Risolvi l'URL
            result = resolve_link(url, headers, channel_name)
            
            # Scrivi il risultato
            with open(output_file, 'w') as f:
                json.dump(result, f, indent=2)
            
            print(f"URL risolto salvato in: {output_file}")
            sys.exit(0)
        except Exception as e:
            print(f"Error: {str(e)}")
            sys.exit(1)
    
    print("Comando non valido")
    sys.exit(1)

if __name__ == "__main__":
    main()
`;
            
            fs.writeFileSync(this.scriptPath, templateContent);
            console.log('✓ Resolver script template created successfully');
            return true;
        } catch (error) {
            console.error('❌ Error creating template:', error.message);
            this.lastError = `Template creation error: ${error.message}`;
            return false;
        }
    }

    /**
     * Restituisce lo stato attuale del resolver
     * @returns {Object} - Lo stato attuale
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            lastExecution: this.lastExecution ? this.formatDate(this.lastExecution) : 'Mai',
            lastError: this.lastError,
            scriptExists: fs.existsSync(this.scriptPath),
            scriptUrl: this.scriptUrl,
            updateInterval: this.updateInterval,
            scheduledUpdates: this.cronJob !== null,
            cacheItems: this.resolvedLinksCache.size,
            resolverVersion: this.getResolverVersion()
        };
    }

    /**
     * Get resolver version from the Python script
     */
    getResolverVersion() {
        try {
            if (fs.existsSync(this.scriptPath)) {
                const content = fs.readFileSync(this.scriptPath, 'utf8');
                const versionMatch = content.match(/RESOLVER_VERSION\s*=\s*["']([^"']+)["']/);
                if (versionMatch && versionMatch[1]) {
                    return versionMatch[1];
                }
            }
            return 'N/A';
        } catch (error) {
            console.error('Error reading version:', error.message);
            return 'Error';
        }
    }

    /**
     * Formatta una data in formato italiano
     * @param {Date} date - La data da formattare
     * @returns {string} - La data formattata
     */
    formatDate(date) {
        return date.toLocaleString('it-IT', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

module.exports = new PythonResolver();
