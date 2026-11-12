/**
 * Единый реестр загрузок: колесо + теги операций, ошибки через toast.
 */
(function (global) {
    'use strict';

    const tasks = new Map();
    let bootHeld = true;
    let hideTimer = null;
    let bootFailsafeTimer = null;
    const BOOT_FAILSAFE_MS = 8000;

    function shellEl() {
        return document.getElementById('daLoadShell');
    }

    function tagsEl() {
        return document.getElementById('daLoadTags');
    }

    function titleEl() {
        return document.getElementById('daLoadTitle');
    }

    function recoveryEl() {
        return document.getElementById('daLoadRecovery');
    }

    function recoveryBtnEl() {
        return document.getElementById('daLoadResetBtn');
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function clearBootFailsafe() {
        if (bootFailsafeTimer) {
            global.clearTimeout(bootFailsafeTimer);
            bootFailsafeTimer = null;
        }
    }

    function armBootFailsafe(ms) {
        clearBootFailsafe();
        const timeout = Number(ms) > 0 ? Number(ms) : BOOT_FAILSAFE_MS;
        bootFailsafeTimer = global.setTimeout(() => {
            bootFailsafeTimer = null;
            if (!bootHeld && tasks.size === 0) return;
            console.warn('[DaLoad] boot failsafe — снятие экрана загрузки');
            bootHeld = false;
            tasks.clear();
            showBootRecovery('Запуск занял слишком много времени. Попробуйте сбросить кэш и войти снова.');
            render();
        }, timeout);
    }

    function showBootRecovery(message) {
        const block = recoveryEl();
        const btn = recoveryBtnEl();
        const title = titleEl();
        if (title && message) {
            title.textContent = String(message).trim();
        }
        if (block) block.hidden = false;
        if (btn && !btn.dataset.daResetBound) {
            btn.dataset.daResetBound = '1';
            btn.addEventListener('click', () => {
                btn.disabled = true;
                const run = typeof global.hardResetAppData === 'function'
                    ? global.hardResetAppData({ preserveBuild: true })
                    : Promise.resolve();
                Promise.resolve(run).catch((err) => {
                    console.warn('[DaLoad] hard reset', err);
                    global.location.reload();
                });
            });
        }
    }

    function hideBootRecovery() {
        const block = recoveryEl();
        if (block) block.hidden = true;
    }

    function render() {
        const shell = shellEl();
        if (!shell) return;

        const labels = [...tasks.values()];
        const active = bootHeld || labels.length > 0;

        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }

        if (!active) {
            hideBootRecovery();
            if (!shell.hidden) {
                shell.classList.add('is-hiding');
                hideTimer = global.setTimeout(() => {
                    shell.hidden = true;
                    shell.classList.remove('is-hiding');
                    hideTimer = null;
                }, 280);
            }
            shell.setAttribute('aria-busy', 'false');
            return;
        }

        shell.classList.remove('is-hiding');
        shell.hidden = false;
        shell.setAttribute('aria-busy', 'true');

        const title = titleEl();
        if (title) {
            const recovery = recoveryEl();
            const recoveryVisible = recovery && recovery.hidden === false;
            if (!recoveryVisible) {
                title.textContent = bootHeld && !labels.length
                    ? 'Запуск приложения…'
                    : (labels[0] || 'Загрузка…');
            }
        }

        const tags = tagsEl();
        if (tags) {
            if (!labels.length && bootHeld) {
                tags.innerHTML = '<span class="da-load-tag">Инициализация</span>';
            } else {
                tags.innerHTML = labels
                    .map((label) => `<span class="da-load-tag">${escapeHtml(label)}</span>`)
                    .join('');
            }
        }
    }

    function start(id, label) {
        const key = String(id || '').trim() || `task_${tasks.size + 1}`;
        tasks.set(key, String(label || key).trim() || key);
        render();
        return key;
    }

    function end(id) {
        tasks.delete(String(id || '').trim());
        render();
    }

    function releaseBoot() {
        bootHeld = false;
        clearBootFailsafe();
        render();
    }

    function holdBoot() {
        bootHeld = true;
        render();
    }

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
        releaseBoot,
        holdBoot,
        error,
        armBootFailsafe,
        showBootRecovery,
        isActive: () => bootHeld || tasks.size > 0,
    };

    armBootFailsafe(BOOT_FAILSAFE_MS);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => render(), { once: true });
    } else {
        render();
    }
})(typeof window !== 'undefined' ? window : globalThis);
