'use strict';

const webpush = require('web-push');

function isExpired(status) {
    return status === 404 || status === 410;
}

async function sendNotification(subscription, payload, options = {}) {
    const vapid = options.vapid || {};
    if (!vapid.publicKey || !vapid.privateKey) {
        throw new Error('VAPID not configured');
    }

    webpush.setVapidDetails(
        vapid.subject || 'mailto:support@cppk.local',
        vapid.publicKey,
        vapid.privateKey
    );

    try {
        const result = await webpush.sendNotification(subscription, payload, {
            TTL: options.ttl || 86400,
            urgency: options.urgency || 'high',
        });
        return { status: result.statusCode || 201 };
    } catch (err) {
        const status = err?.statusCode || err?.status || 500;
        const error = new Error(err?.body || err?.message || `Push failed (${status})`);
        error.statusCode = status;
        throw error;
    }
}

module.exports = { sendNotification, isExpired };
