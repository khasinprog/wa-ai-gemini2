const fs = require('fs');

const LIVE_FILE = '/var/www/wa-ai-gemini2/data/messages.json';
const BACKUP_FILE = '/root/wa-ai-gemini2/data/messages.json';
const LOG_FILE = '/root/.pm2/logs/wa-bot-out.log';

// 1. Load data
let liveMsgs = [];
if (fs.existsSync(LIVE_FILE)) {
    liveMsgs = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
}
let backupMsgs = [];
if (fs.existsSync(BACKUP_FILE)) {
    backupMsgs = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
}

// 2. Build Name -> Number mapping
const nameMap = {};
for (const m of [...backupMsgs, ...liveMsgs]) {
    if (m.senderName && m.from) {
        nameMap[m.senderName.trim()] = m.from;
    }
}

// 3. Parse PM2 logs
const logLines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
const recovered = [];
let currentMsg = null;
let fakeTime = Date.now() - (24 * 60 * 60 * 1000); // Start from yesterday to order them roughly

for (let line of logLines) {
    if (!line.trim()) continue;
    line = line.replace(/^0\|wa-bot\s+\|\s+/, '');
    
    if (line.startsWith('📩')) {
        let text = line.substring(2).trim(); // hapus 📩
        let colonIdx = text.indexOf(':');
        if (colonIdx > -1) {
            let sName = text.substring(0, colonIdx).trim();
            // hapus [MacroDroid] jika ada
            sName = sName.replace(/^\[MacroDroid\]\s+/, '').trim();
            let body = text.substring(colonIdx + 1).trim();
            
            let fromNum = nameMap[sName] || `unknown_${sName.replace(/[^a-zA-Z0-9]/g, '')}`;
            
            fakeTime += 1000;
            currentMsg = {
                id: fakeTime,
                from: fromNum,
                senderName: sName,
                body: body,
                timestamp: new Date(fakeTime).toISOString(),
                replied: true,
                aiReply: null
            };
            recovered.push(currentMsg);
        }
    } else if (line.startsWith('🤖 AI') && currentMsg) {
        let text = line;
        let colonIdx = text.indexOf(':');
        if (colonIdx > -1) {
            currentMsg.aiReply = text.substring(colonIdx + 1).trim();
        } else {
            currentMsg.aiReply = text;
        }
        currentMsg = null; // reset
    }
}

// 4. Merge data (deduplicate)
const existingBodies = new Set(liveMsgs.map(m => m.body.trim()));
let addedCount = 0;

for (const rm of recovered) {
    if (!existingBodies.has(rm.body.trim())) {
        liveMsgs.unshift(rm);
        addedCount++;
    }
}

// Sort by timestamp desc (newest first)
liveMsgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

// Save backup before overwrite
fs.copyFileSync(LIVE_FILE, LIVE_FILE + '.bak_recovery');

fs.writeFileSync(LIVE_FILE, JSON.stringify(liveMsgs, null, 2));

console.log(`✅ Recovery selesai! Berhasil memulihkan ${addedCount} pesan dari hari ini.`);
