/**
 * Единый реестр загрузок: колесо + теги операций, ошибки через toast.
 */
(function (global) {
    'use strict';

    const tasks = new Map();
    let bootHeld = true;
    let hideTimer = null;

    function shellEl() {
        return document.getElementById('daLoadShell');
    }

    function tagsEl() {
        return document.getElementById('daLoadTags');
    }

    function titleEl() {
        return document.getElementById('daLoadTitle');
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
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
            title.textContent = bootHeld && !labels.length
                ? 'Запуск приложения…'
                : (labels[0] || 'Загрузка…');
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
        isActive: () => bootHeld || tasks.size > 0,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => render(), { once: true });
    } else {
        render();
    }
})(typeof window !== 'undefined' ? window : globalThis);
