import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'app');
const htmlPath = path.join(root, 'index.html');

const content = fs.readFileSync(htmlPath, 'utf8');
const lines = content.split(/\r?\n/);

const startIdx = lines.findIndex((l) => l.trim() === '<style>');
const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === '</style>');
if (startIdx < 0 || endIdx < 0) {
    throw new Error('style block not found');
}

function stripIndent(rawLines) {
    return rawLines.map((ln) => (ln.startsWith('        ') ? ln.slice(8) : ln));
}

const splits = [
    ['tokens.css', 14, 37],
    ['base.css', 39, 699],
    ['routes.css', 700, 1819],
    ['schedule.css', 1820, 2426],
    ['calendar.css', 2427, 2874],
    ['profile.css', 2875, 3262],
    ['responsive.css', 3263, 3598],
    ['auth.css', 3599, endIdx]
];

const stylesDir = path.join(root, 'styles');
fs.mkdirSync(stylesDir, { recursive: true });

for (const [name, first, last] of splits) {
    const chunk = stripIndent(lines.slice(first - 1, last));
    fs.writeFileSync(path.join(stylesDir, name), chunk.join('\n') + '\n', 'utf8');
    console.log(name, chunk.length, 'lines');
}

const linkTags = splits
    .map(([name]) => `    <link rel="stylesheet" href="styles/${name}">`)
    .join('\n');

const newLines = [
    ...lines.slice(0, startIdx),
    linkTags,
    ...lines.slice(endIdx + 1)
];

fs.writeFileSync(htmlPath, newLines.join('\n') + '\n', 'utf8');
console.log('index.html lines:', newLines.length);
console.log('removed from html:', endIdx - startIdx - 1, 'css lines');
