/**
 * KV-совместимое хранилище для Cloud Function.
 * Прод: Yandex Object Storage (S3 API).
 * Без бакета: MemoryStore (не переживает холодный старт / несколько инстансов).
 */

'use strict';

class MemoryStore {
    constructor() {
        this.map = new Map();
    }

    async get(key, opts = {}) {
        const row = this.map.get(key);
        if (!row) return null;
        if (row.expiration && row.expiration <= Math.floor(Date.now() / 1000)) {
            this.map.delete(key);
            return null;
        }
        if (opts.type === 'json') {
            try {
                return JSON.parse(row.value);
            } catch {
                return null;
            }
        }
        return row.value;
    }

    async put(key, value, options = {}) {
        let expiration = null;
        if (Number.isFinite(options.expiration) && options.expiration > 0) {
            expiration = Math.floor(options.expiration);
        } else if (Number.isFinite(options.expirationTtl) && options.expirationTtl > 0) {
            expiration = Math.floor(Date.now() / 1000) + Math.floor(options.expirationTtl);
        }
        this.map.set(key, { value: String(value), expiration });
    }

    async delete(key) {
        this.map.delete(key);
    }
}

class S3Store {
    constructor({ client, bucket, prefix = 'da-cache/' }) {
        this.client = client;
        this.bucket = bucket;
        this.prefix = prefix;
        this.PutObjectCommand = null;
        this.GetObjectCommand = null;
        this.DeleteObjectCommand = null;
    }

    objectKey(key) {
        const safe = String(key).replace(/[^a-zA-Z0-9:_./\-]/g, '_');
        return `${this.prefix}${safe}`;
    }

    async get(key, opts = {}) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        try {
            const out = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: this.objectKey(key),
            }));
            const metaExp = Number(out.Metadata?.expiration || 0);
            if (metaExp && metaExp <= Math.floor(Date.now() / 1000)) {
                await this.delete(key);
                return null;
            }
            const text = await out.Body.transformToString();
            if (opts.type === 'json') {
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            }
            return text;
        } catch (err) {
            if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw err;
        }
    }

    async put(key, value, options = {}) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        let expiration = null;
        if (Number.isFinite(options.expiration) && options.expiration > 0) {
            expiration = Math.floor(options.expiration);
        } else if (Number.isFinite(options.expirationTtl) && options.expirationTtl > 0) {
            expiration = Math.floor(Date.now() / 1000) + Math.floor(options.expirationTtl);
        }
        const Metadata = {};
        if (expiration) Metadata.expiration = String(expiration);
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.objectKey(key),
            Body: String(value),
            ContentType: 'application/json; charset=utf-8',
            Metadata,
        }));
    }

    async delete(key) {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        try {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: this.objectKey(key),
            }));
        } catch {
            /* ignore */
        }
    }
}

function createStore(env = process.env) {
    const bucket = String(env.S3_BUCKET || env.YC_STORAGE_BUCKET || '').trim();
    const accessKeyId = String(env.AWS_ACCESS_KEY_ID || env.YC_STORAGE_ACCESS_KEY || '').trim();
    const secretAccessKey = String(env.AWS_SECRET_ACCESS_KEY || env.YC_STORAGE_SECRET_KEY || '').trim();
    const endpoint = String(env.S3_ENDPOINT || 'https://storage.yandexcloud.net').trim();
    const region = String(env.S3_REGION || 'ru-central1').trim();
    const prefix = String(env.S3_PREFIX || 'da-cache/').trim();

    if (bucket && accessKeyId && secretAccessKey) {
        const { S3Client } = require('@aws-sdk/client-s3');
        const client = new S3Client({
            region,
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: false,
        });
        return new S3Store({ client, bucket, prefix });
    }

    console.warn('[store] S3 не настроен — MemoryStore (кэш не персистентный)');
    return new MemoryStore();
}

module.exports = { createStore, MemoryStore, S3Store };
