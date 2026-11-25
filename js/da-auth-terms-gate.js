/**
 * Модалка #authTermsGate: делегированный клик «Продолжить», localStorage / API.
 */
(function (global) {
    'use strict';

    const CONSENT_ID = 'authTermsConsent';
    const ERROR_ID = 'authTermsGateError';
    const GATE_ID = 'authTermsGate';
    const SUBMIT_ID = 'authTermsGateSubmit';

    let submitting = false;

    function setError(message) {
        const err = document.getElementById(ERROR_ID);
        if (err) err.textContent = message ? String(message) : '';
    }

    async function handleSubmit() {
        if (submitting) return;
        const root = document.getElementById(CONSENT_ID);
        const btn = document.getElementById(SUBMIT_ID);
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;

        if (!global.DaLegalConsent?.bothChecked?.(root)) {
            global.DaLegalConsent?.flashMissing?.(root);
            setError('Отметьте оба согласия.');
            global.DaLegalConsent?.syncButtonForRoot?.(root);
            return;
        }

        submitting = true;
        setError('');
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.classList.remove('is-consent-ready');
        btn.classList.add('is-consent-pending');

        try {
            await global.DaAuthSession.acceptTerms();
            const onAccepted = global.DaAuthTermsGate?.onAccepted;
            if (typeof onAccepted === 'function') {
                await onAccepted();
            } else {
                global.DaAuthTermsGate?.hide?.();
            }
        } catch (e) {
            const msg = e?.payload?.message
                || e?.message
                || 'Не удалось сохранить согласие.';
            setError(msg);
            global.DaLegalConsent?.syncButtonForRoot?.(root);
        } finally {
            submitting = false;
        }
    }

    function bindSubmit() {
        const gate = document.getElementById(GATE_ID);
        const btn = document.getElementById(SUBMIT_ID);
        if (!gate || !btn) return;
        if (gate.dataset.termsSubmitBound === '1') return;
        gate.dataset.termsSubmitBound = '1';

        gate.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            const hit = target.closest(`#${SUBMIT_ID}`);
            if (!hit || hit.disabled) return;
            ev.preventDefault();
            void handleSubmit();
        });
    }

    function wireShowHook() {
        const prev = global.DaAuthTermsGate?.show;
        global.DaAuthTermsGate = global.DaAuthTermsGate || {};
        global.DaAuthTermsGate.handleSubmit = handleSubmit;
        global.DaAuthTermsGate.bindSubmit = bindSubmit;
        if (typeof prev === 'function') {
            global.DaAuthTermsGate.show = prev;
        }
        global.DaAuthTermsGate.afterShow = () => {
            const root = document.getElementById(CONSENT_ID);
            global.DaLegalConsent?.syncButtonForRoot?.(root);
        };
    }

    wireShowHook();

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', bindSubmit);
    } else {
        bindSubmit();
    }
})(typeof window !== 'undefined' ? window : globalThis);