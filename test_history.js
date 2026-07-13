const fs = require('fs');
const messages = JSON.parse(fs.readFileSync('data/messages.json', 'utf8'));
console.log(JSON.stringify(messages.slice(0, 3), null, 2));
