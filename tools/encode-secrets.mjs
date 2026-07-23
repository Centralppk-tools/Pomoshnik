import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const secretsPath = join(root, 'secrets.local.json');
const outDir = join(root, 'app', 'js');
const outPath = join(outDir, 'da-secrets.js');

const CIPHER_KEY = 'DA_CPPK_245_K9';

if (!existsSync(secretsPath)) {
    console.error('Нет secrets.local.json — скопируйте secrets.example.json и заполните ключи.');
    process.exit(1);
}

const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));

function xorPayload(plain, key) {
    const text = Buffer.from(plain, 'utf8');
    const kb = Buffer.from(key, 'utf8');
    const out = Buffer.alloc(text.length);
    for (let i = 0; i < text.length; i += 1) {
        out[i] = text[i] ^ kb[i % kb.length];
    }
    return out.toString('base64');
}

const payload = xorPayload(JSON.stringify(secrets), CIPHER_KEY);

const bootstrap = `(function(w){var a='${CIPHER_KEY}',b='${payload}',c=null;function d(){if(c)return c;var e=atob(b),f=new Uint8Array(e.length),g=new TextEncoder().encode(a),h='',i,j;for(i=0;i<e.length;i+=1)f[i]=e.charCodeAt(i);for(j=0;j<f.length;j+=1)h+=String.fromCharCode(f[j]^g[j%g.length]);c=JSON.parse(h);return c}function e(n){return d()[n]||''}w.__DA={g:e,donate:function(){return{layoutId:e('cloudtipsLayoutId'),paymentPageUrl:e('cloudtipsPaymentUrl'),feeApiUrl:e('cloudtipsFeeApiUrl')}}}})(typeof window!=='undefined'?window:globalThis);`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, bootstrap, 'utf8');
console.log(`Секреты: app/js/da-secrets.js (${bootstrap.length} байт, XOR+base64)`);
