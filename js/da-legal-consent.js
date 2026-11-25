/**
 * Два чекбокса: оферта + политика. Общая логика для auth, гейта и оплаты.
 */
(function (global) {
    'use strict';

    const OFFER_AUTH = 'Я принимаю условия <a href="offer.html" target="_blank" rel="noopener noreferrer">Публичной оферты</a>';
    const OFFER_PAY = 'Я принимаю условия <a href="offer.html" target="_blank" rel="noopener noreferrer">Публичной оферты</a> и соглашаюсь с автопродлением (300 ₽ раз в 3 месяца после пробного периода)';
    const PRIVACY = 'Я даю согласие на обработку персональных данных согласно <a href="privacy.html" target="_blank" rel="noopener noreferrer">Политике конфиденциальности</a>';

    function offerHtml(mode) {
        return mode === 'payment' ? OFFER_PAY : OFFER_AUTH;
    }

    function mountConsentRoot(root) {
        if (!root || root.dataset.consentMounted === '1') return root;
        const mode = root.dataset.consentMode === 'payment' ? 'payment' : 'auth';
        root.classList.add('da-consent');
        root.innerHTML = `
            <label class="da-consent__card">
                <input type="checkbox" class="da-consent__input" data-consent="offer">
                <span class="da-consent__check" aria-hidden="true"></span>
                <span class="da-consent__text">${offerHtml(mode)}</span>
            </label>
            <label class="da-consent__card">
                <input type="checkbox" class="da-consent__input" data-consent="privacy">
                <span class="da-consent__check" aria-hidden="true"></span>
                <span class="da-consent__text">${PRIVACY}</span>
            </label>
        `;
        root.dataset.consentMounted = '1';
        return root;
    }

    function getRoot(el) {
        if (!el) return null;
        if (el.classList && el.classList.contains('da-consent')) return el;
        return el.closest?.('.da-consent') || document.getElementById(el) || null;
    }

    function bothChecked(root) {
        const r = getRoot(root);
        if (!r || r.hidden) return true;
        const offer = r.querySelector('[data-consent="offer"]');
        const privacy = r.querySelector('[data-consent="privacy"]');
        return Boolean(offer?.checked && privacy?.checked);
    }

    function reset(root) {
        const r = getRoot(root);
        if (!r) return;
        r.querySelectorAll('.da-consent__input').forEach((inp) => {
            inp.checked = false;
        });
        r.querySelectorAll('.da-consent__card').forEach((c) => c.classList.remove('is-consent-error'));
        syncButtonForRoot(r);
    }

    function flashMissing(root) {
        const r = getRoot(root);
        if (!r) return;
        r.querySelectorAll('.da-consent__card').forEach((card) => {
            const inp = card.querySelector('.da-consent__input');
            if (inp && !inp.checked) {
                card.classList.add('is-consent-error');
                global.setTimeout(() => card.classList.remove('is-consent-error'), 1500);
            }
        });
    }

    function consentPayload() {
        return { accepted_offer: true, accepted_privacy: true };
    }

    function needsConsentForUser(user) {
        if (!user) return true;
        return !user.terms_accepted_at;
    }

    function applyGateButtonState(btn, ready) {
        btn.disabled = !ready;
        if (ready) {
            btn.removeAttribute('disabled');
            btn.setAttribute('aria-disabled', 'false');
        } else {
            btn.setAttribute('disabled', '');
            btn.setAttribute('aria-disabled', 'true');
        }
        btn.classList.toggle('is-consent-ready', ready);
        btn.classList.toggle('is-consent-pending', !ready);
    }

    function syncButtonForRoot(root) {
        const r = getRoot(root);
        if (!r) return;
        const btnId = r.dataset.consentButton;
        const btn = btnId ? document.getElementById(btnId) : null;
        if (!btn) return;

        const gate = document.getElementById('authTermsGate');
        const gateOpen = gate && !gate.hidden && gate.getAttribute('aria-hidden') !== 'true';
        let visible = !r.hidden && r.offsetParent !== null;
        if (r.id === 'authTermsConsent' && gateOpen) visible = true;
        const ready = !visible || bothChecked(r);

        if (btn.classList.contains('user-auth-btn')) {
            if (r.id === 'authRegisterConsent') {
                btn.classList.toggle('is-consent-ready', ready);
                btn.classList.toggle('is-consent-pending', !ready);
                return;
            }
            if (r.id === 'authTermsConsent') {
                applyGateButtonState(btn, ready);
            }
            return;
        }

        if (btn.classList.contains('sub-modal__btn--neon')) {
            if (!visible) {
                btn.disabled = false;
                btn.classList.add('is-consent-ready');
                btn.classList.remove('is-consent-pending');
            } else {
                btn.disabled = !ready;
                btn.classList.toggle('is-consent-ready', ready);
                btn.classList.toggle('is-consent-pending', !ready);
            }
        }
    }

    function setVisible(root, visible) {
        const r = getRoot(root);
        if (!r) return;
        r.hidden = !visible;
        syncButtonForRoot(r);
    }

    function bindRoot(root) {
        const r = mountConsentRoot(root);
        if (!r) return r;
        const firstBind = r.dataset.consentBound !== '1';
        if (firstBind) {
            r.dataset.consentBound = '1';

            r.querySelectorAll('a').forEach((a) => {
                a.addEventListener('click', (ev) => ev.stopPropagation());
            });

            r.addEventListener('change', (ev) => {
                if (ev.target?.classList?.contains('da-consent__input')) {
                    syncButtonForRoot(r);
                    if (r.id === 'authRegisterConsent') {
                        if (typeof global.refreshAuthSubmitStates === 'function') {
                            global.refreshAuthSubmitStates();
                        }
                    }
                }
            });

            const btnId = r.dataset.consentButton;
            const btn = btnId ? document.getElementById(btnId) : null;
            if (btn && btn.id !== 'authTermsGateSubmit' && !btn.dataset.consentClickBound) {
                btn.dataset.consentClickBound = '1';
                btn.addEventListener('click', (ev) => {
                    const block = r;
                    if (block.hidden || block.offsetParent === null) return;
                    if (!bothChecked(block)) {
                        ev.preventDefault();
                        ev.stopImmediatePropagation();
                        flashMissing(block);
                        const msg = 'Отметьте оба согласия: оферту и политику конфиденциальности.';
                        if (block.id === 'authRegisterConsent') {
                            document.getElementById('authErrorRegister')?.textContent && (document.getElementById('authErrorRegister').textContent = msg);
                        }
                        global.showDaErrorToast?.(msg);
                    }
                }, true);
            }
        }

        syncButtonForRoot(r);
        return r;
    }

    function init() {
        document.querySelectorAll('[data-consent-root]').forEach((el) => bindRoot(el));
    }

    global.DaLegalConsent = {
        init,
        bindRoot,
        mountConsentRoot,
        bothChecked,
        reset,
        flashMissing,
        consentPayload,
        needsConsentForUser,
        setVisible,
        syncButtonForRoot,
        isReady: bothChecked,
    };

    if (global.document?.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);