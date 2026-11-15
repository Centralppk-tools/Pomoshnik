/**
 * Единый реестр загрузок: колесо + теги операций, ошибки через toast.
 * Полноэкранный boot-shell отключён — индикация только в шапке (часы).
 */
(function (global) {
    'use strict';

    const tasks = new Map();
    let bootHeld = false;

    function noop() { /* shell disabled */ }

    function error(message, durationMs) {
        const text = String(message || '').trim() || 'Не удалось выполнить операцию';
        if (typeof global.showDaErrorToast === 'function') {
            global.showDaErrorToast(text, durationMs);
            return;
        }
        if (typeof global.showDaActionToast === 'function') {
            global.showDaActionToast(text, durationMs);
        }
    }

    function start(id, label) {
        const key = String(id || '').trim() || `task_${tasks.size + 1}`;
        tasks.set(key, String(label || key).trim() || key);
        return key;
    }

    function end(id) {
        tasks.delete(String(id || '').trim());
    }

    async function run(id, label, fn) {
        start(id, label);
        try {
            return await fn();
        } catch (err) {
            const msg = err && err.message ? String(err.message) : 'Ошибка загрузки';
            error(msg);
            throw err;
        } finally {
            end(id);
        }
    }

    global.DaLoad = {
        start,
        end,
        run,
        releaseBoot: noop,
        holdBoot: noop,
        error,
        armBootFailsafe: noop,
        showBootRecovery: noop,
        isActive: () => tasks.size > 0,
    };
})(typeof window !== 'undefined' ? window : globalThis);