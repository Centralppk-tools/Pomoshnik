#!/usr/bin/env node
/**
 * Удаляет старые clasp-деплои, оставляя активный web-app и @HEAD.
 * Запуск: npm run clasp:cleanup-deployments
 */
import { execSync } from 'node:child_process';

const KEEP = new Set([
    'AKfycbyXZtOedTna78AwC4bvdGnMqXxqZ1cflSwODYXYIjm7zWA2BfYqpBJlhDZ0JzqozW4RkA',
    'AKfycbyIhTi54_b6w8hIdkDpJo5ccaXctZrEponApwmZ9FCQ'
]);

function listDeployments() {
    const out = execSync('npx clasp deployments', { encoding: 'utf8' });
    const ids = [];
    for (const line of out.split('\n')) {
        const match = line.match(/^-\s+(AKfyc[\w-]+)\s+/);
        if (match) ids.push(match[1]);
    }
    return ids;
}

const all = listDeployments();
const toRemove = all.filter(id => !KEEP.has(id));

if (!toRemove.length) {
    console.log('Nothing to remove. Deployments:', all.length);
    process.exit(0);
}

console.log(`Keeping: ${[...KEEP].join(', ')}`);
console.log(`Removing ${toRemove.length} old deployment(s)...`);

for (const id of toRemove) {
    try {
        execSync(`npx clasp undeploy ${id}`, { stdio: 'inherit' });
        console.log('Removed', id);
    } catch (err) {
        console.warn('Failed to remove', id);
    }
}

console.log('Done. Remaining:', listDeployments().length);
