const fs = require('fs');
const path = 'G:/rzd/Приложение/Digital Assistant/app/index.html';
const html = fs.readFileSync(path, 'utf8');
const marker = '<script src="js/da-secrets.js"></script>';
const start = html.indexOf(marker);
if (start < 0) {
    console.error('marker not found');
    process.exit(1);
}
const scriptOpen = html.indexOf('<script>', start + marker.length);
const scriptClose = html.indexOf('</script>', scriptOpen + 8);
const js = html.slice(scriptOpen + 8, scriptClose);
const out = 'G:/rzd/Приложение/Digital Assistant/tools/_tmp-check.js';
fs.writeFileSync(out, js);
console.log('bytes', js.length);
