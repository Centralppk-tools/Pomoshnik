/**
 * Подписка Robokassa: пилюля в шапке, мягкая плашка, модалки, профиль.
 */
(function (global) {
    'use strict';

    const REF_KEY = 'da_referral_code';
    const ONBOARD_KEY = 'da_sub_onboard_v1';
    const BANNER_HIDE_KEY = 'da_sub_banner_hide_until';
    const BANNER_HIDE_MS = 12 * 60 * 60 * 1000;

    let referralsCache = { invited: 0, paid: 0, bonus_days: 0 };
    /** @type {'idle'|'loading'|'ok'|'error'} */
    let meFetchState = 'idle';

    function cfg() {
        return global.APP_CONFIG?.crewApi || {};
    }

    function formatShortDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}`;
    }

    function getUser() {
        return global.DaAuthSession?.getStoredUser?.() || null;
    }

    function uiKind(user) {
        const ui = user?.subscription_ui;
        if (ui?.kind === 'bind') return 'bind';
        if (ui?.kind === 'trial') return 'trial';
        if (ui?.kind === 'paid') return 'paid';
        if (ui?.kind === 'expired') return 'expired';
        if (!user?.trial_card_bound_at && !user?.subscription_ends_at) return 'bind';
        if (user?.subscription_status === 'lifetime' || user?.is_manual_grant) return 'paid';
        const end = user?.subscription_ends_at || user?.subscription_expires_at;
        if (end && new Date(end).getTime() > Date.now()) return 'paid';
        const trial = user?.trial_ends_at;
        if (trial) {
            return new Date(trial).getTime() > Date.now() ? 'trial' : 'expired';
        }
        if (!user || !global.DaAuthSession?.getJwt?.()) return 'unknown';
        if (meFetchState === 'loading' || meFetchState === 'idle') return 'loading';
        if (meFetchState === 'error') return 'loading';
        return 'unknown';
    }

    function trialDaysLeft(user) {
        const ui = user?.subscription_ui;
        if (ui?.kind === 'trial' && ui.daysLeft != null) return Number(ui.daysLeft) || 0;
        const trial = user?.trial_ends_at;
        if (!trial) return 0;
        const left = Math.ceil((new Date(trial).getTime() - Date.now()) / 86400000);
        return Math.max(0, left);
    }

    function pillLabel(user) {
        const kind = uiKind(user);
        if (kind === 'bind') return 'Триал · 1 ₽';
        if (kind === 'loading' || kind === 'unknown') {
            const days = trialDaysLeft(user) || 14;
            return user?.trial_card_bound_at ? `Триал · ${days} дн.` : 'Триал · 1 ₽';
        }
        if (kind === 'trial') return `Триал · ${trialDaysLeft(user) || 14} дн.`;
        if (kind === 'paid') {
            const end = user.subscription_ends_at || user.subscription_expires_at;
            return `До ${formatShortDate(end)}`;
        }
        return 'Оплатить';
    }

    function referralLink(user) {
        const code = String(user?.referral_code || '').trim();
        if (!code) return '';
        const base = String(global.location?.origin || 'https://app.digipom.ru').replace(/\/$/, '');
        return `${base}/?ref=${encodeURIComponent(code)}`;
    }

    function captureReferralFromUrl() {
        try {
            const p = new URLSearchParams(global.location.search);
            const ref = String(p.get('ref') || '').trim().toLowerCase().slice(0, 16);
            if (ref) global.localStorage.setItem(REF_KEY, ref);
        } catch (_) { /* */ }
    }

    function getStoredReferralCode() {
        try {
            return String(global.localStorage.getItem(REF_KEY) || '').trim().toLowerCase().slice(0, 16);
        } catch (_) {
            return '';
        }
    }

    async function apiFetch(path, options) {
        if (typeof global.DaCrewApi?.apiFetch === 'function') {
            return global.DaCrewApi.apiFetch(path, options);
        }
        const base = String(cfg().baseUrl || '').replace(/\/$/, '');
        const headers = {
            'Content-Type': 'application/json',
            ...(global.DaAuthSession?.authHeaders?.() || {}),
        };
        const res = await fetch(`${base}${path}`, {
            method: options?.method || 'GET',
            headers,
            body: options?.body != null ? JSON.stringify(options.body) : undefined,
            cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `http_${res.status}`);
            err.payload = data;
            throw err;
        }
        return data;
    }

    async function refreshMe() {
        if (!global.DaAuthSession?.getJwt?.()) {
            meFetchState = 'idle';
            return null;
        }
        meFetchState = 'loading';
        try {
            const data = await apiFetch('/api/v1/me');
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            if (data.referrals) referralsCache = data.referrals;
            meFetchState = 'ok';
            return data;
        } catch (_) {
            meFetchState = 'error';
            return null;
        }
    }

    function updateHeaderPills() {
        const user = getUser();
        const label = pillLabel(user);
        document.querySelectorAll('[data-subscription-pill]').forEach((el) => {
            el.textContent = label;
            el.classList.toggle('sub-header-pill--pay', uiKind(user) === 'expired');
        });
        const statusEl = document.getElementById('subPlanStatus');
        if (statusEl) {
            const kind = uiKind(user);
            if (kind === 'loading' || kind === 'unknown') {
                statusEl.textContent = 'Загрузка статуса подписки…';
            } else if (kind === 'bind') {
                statusEl.textContent = 'Привяжите карту за 1 ₽ — старт триала 14 дней';
            } else if (kind === 'trial') {
                statusEl.textContent = `Триал · осталось ${trialDaysLeft(user) || 14} дн.`;
            } else if (kind === 'paid') {
                const end = user.subscription_ends_at || user.subscription_expires_at;
                statusEl.textContent = `Подписка активна до ${formatShortDate(end)}`;
            } else {
                statusEl.textContent = 'Пробный период завершён — оформите подписку';
            }
        }
        syncProfileSubscriptionBlock();
        syncSoftBanner();
    }

    function shouldShowSoftBanner() {
        const user = getUser();
        if (!user || !global.DaAuthSession?.getJwt?.()) return false;
        if (uiKind(user) !== 'expired') return false;
        try {
            const until = Number(global.localStorage.getItem(BANNER_HIDE_KEY) || 0);
            if (until > Date.now()) return false;
        } catch (_) { /* */ }
        return true;
    }

    function syncSoftBanner() {
        const bar = document.getElementById('subSoftBanner');
        if (!bar) return;
        const show = shouldShowSoftBanner();
        bar.hidden = !show;
        bar.classList.toggle('is-visible', show);
    }

    function openModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.hidden = false;
        el.setAttribute('aria-hidden', 'false');
        document.body.classList.add('sub-modal-open');
    }

    function closeModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
        if (!document.querySelector('.sub-modal-overlay:not([hidden])')) {
            document.body.classList.remove('sub-modal-open');
        }
    }

    function closeTopSubModal() {
        const open = document.querySelector('.sub-modal-overlay:not([hidden])');
        if (open && open.id) closeModal(open.id);
    }

    /** Никогда не уводим основное окно на Robokassa (иначе застревают на ошибке 26). */
    function openPaymentInSeparateTab(paymentUrl) {
        const url = String(paymentUrl || '').trim();
        if (!url) return false;
        let opened = null;
        try {
            opened = global.open('about:blank', '_blank', 'noopener,noreferrer');
        } catch (_) { /* */ }
        if (opened) {
            try {
                opened.opener = null;
                opened.location.href = url;
            } catch (_) {
                try { opened.close(); } catch (_e) { /* */ }
                opened = null;
            }
        }
        if (!opened) {
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return true;
        }
        return true;
    }

    function showPaymentOpenedUi() {
        closeModal('subPlanModal');
        openModal('subPayOpenedModal');
    }

    function showPaymentBlockedUi(paymentUrl) {
        const input = document.getElementById('subPayBlockedUrl');
        if (input) input.value = paymentUrl;
        closeModal('subPlanModal');
        openModal('subPayBlockedModal');
    }

    function pickDefaultPlan(user) {
        const kind = uiKind(user);
        if (kind === 'bind' || (!user?.trial_card_bound_at && kind !== 'paid')) return 'trial_bind';
        return 'month';
    }

    function selectPayPlan(plan) {
        document.querySelectorAll('[data-sub-plan]').forEach((c) => {
            c.classList.toggle('is-selected', c.getAttribute('data-sub-plan') === plan);
        });
        const btn = document.getElementById('subPayGoBtn');
        if (btn) {
            btn.textContent = plan === 'trial_bind' ? 'Привязать карту (1 ₽)' : 'Перейти к оплате';
        }
        const trialCard = document.getElementById('subPlanTrialBind');
        if (trialCard) trialCard.hidden = Boolean(getUser()?.trial_card_bound_at);
    }

    function openPaywall() {
        const emailInput = document.getElementById('subPayEmail');
        const user = getUser();
        if (emailInput && user?.email) emailInput.value = user.email;
        const refLink = document.getElementById('subReferralLink');
        if (refLink) refLink.textContent = referralLink(user) || '—';
        selectPayPlan(pickDefaultPlan(user));
        updateHeaderPills();
        openModal('subPlanModal');
    }

    async function startPayment(plan) {
        const emailEl = document.getElementById('subPayEmail');
        const email = emailEl ? String(emailEl.value || '').trim() : '';
        const btn = document.getElementById('subPayGoBtn');
        if (btn) btn.disabled = true;
        try {
            const data = await apiFetch('/api/v1/payments/create', {
                method: 'POST',
                body: { plan, email: email || undefined },
            });
            if (data.payment_url) {
                const ok = openPaymentInSeparateTab(data.payment_url);
                if (ok) {
                    showPaymentOpenedUi();
                } else {
                    showPaymentBlockedUi(data.payment_url);
                }
            }
        } catch (err) {
            const code = err?.payload?.error;
            const msg = err?.payload?.message
                || (code === 'payments_not_configured'
                    ? 'Оплата на сервере не настроена (Robokassa).'
                    : 'Не удалось создать платёж. Попробуйте позже.');
            global.showDaErrorToast?.(msg);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function handlePaymentReturn() {
        const p = new URLSearchParams(global.location.search);
        const payment = String(p.get('payment') || '').trim().toLowerCase();
        if (payment !== 'success' && payment !== 'fail') return;
        const inv = p.get('InvId') || p.get('inv_id');
        let detail = null;
        if (payment === 'success' && inv) {
            try {
                detail = await apiFetch(`/api/v1/payments/status?inv_id=${encodeURIComponent(inv)}`);
                if (detail?.user) global.DaAuthSession.persistSession(null, detail.user);
            } catch (_) { /* */ }
        }
        const title = document.getElementById('subResultTitle');
        const text = document.getElementById('subResultText');
        const retryBtn = document.getElementById('subResultRetryBtn');
        if (payment === 'success') {
            const user = detail?.user || getUser();
            const txPlan = detail?.transaction?.plan;
            const end = user?.subscription_ends_at || user?.subscription_expires_at;
            const trial = user?.trial_ends_at;
            if (title) title.textContent = 'Оплата прошла';
            if (text) {
                if (txPlan === 'trial_bind' || (!end && trial)) {
                    text.textContent = `Карта привязана. Триал до ${formatShortDate(trial)}. Чек на ${user?.email || 'указанную почту'}.`;
                } else if (end) {
                    text.textContent = `Подписка до ${formatShortDate(end)}. Чек на ${user?.email || 'указанную почту'}.`;
                } else {
                    text.textContent = 'Платёж принят. Обновляю статус…';
                }
            }
            if (retryBtn) retryBtn.hidden = true;
        } else {
            if (title) title.textContent = 'Оплата не завершена';
            if (text) text.textContent = 'Платёж отменён или прерван. Можно попробовать снова.';
            if (retryBtn) retryBtn.hidden = false;
        }
        openModal('subResultModal');
        const clean = new URL(global.location.href);
        clean.searchParams.delete('payment');
        clean.searchParams.delete('InvId');
        clean.searchParams.delete('inv_id');
        global.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
        updateHeaderPills();
    }

    function syncProfileSubscriptionBlock() {
        const user = getUser();
        const statusEl = document.getElementById('profileSubStatus');
        const renewBtn = document.getElementById('profileSubRenewBtn');
        const refStat = document.getElementById('profileSubRefStat');
        const autorenewBtn = document.getElementById('profileSubAutorenewBtn');
        const autorenewHint = document.getElementById('profileSubAutorenewHint');
        if (!statusEl) return;
        const kind = uiKind(user);
        if (kind === 'loading' || kind === 'unknown') {
            statusEl.textContent = 'Триал — загрузка данных…';
        } else if (kind === 'bind') {
            statusEl.textContent = 'Триал не активирован — привязка карты 1 ₽';
        } else if (kind === 'trial') {
            const trialIso = user.trial_ends_at;
            statusEl.textContent = trialIso
                ? `Триал до ${formatShortDate(trialIso)} (${trialDaysLeft(user) || 14} дн.)`
                : `Триал · ${trialDaysLeft(user) || 14} дн.`;
        } else if (kind === 'paid') {
            const end = user.subscription_ends_at || user.subscription_expires_at;
            statusEl.textContent = `Активна до ${formatShortDate(end)}`;
        } else if (kind === 'expired') {
            statusEl.textContent = 'Не оплачена — доступ без блокировок, напоминание в шапке';
        } else {
            statusEl.textContent = 'Триал — загрузка данных…';
        }
        if (renewBtn) {
            renewBtn.textContent = kind === 'paid' ? 'Продлить' : 'Оплатить';
        }
        if (refStat) {
            const max = referralsCache.bonus_days_max || 21;
            const activated = referralsCache.rewards_count != null
                ? referralsCache.rewards_count
                : (referralsCache.paid || 0);
            refStat.textContent = `Приглашено: ${referralsCache.invited || 0}, активировали: ${activated}, бонус: +${referralsCache.bonus_days || 0} / ${max} дн.`;
        }
        const profileRef = document.getElementById('profileSubRefLink');
        if (profileRef) profileRef.textContent = referralLink(user) || '—';
        if (autorenewBtn) {
            autorenewBtn.hidden = !user?.autorenew_enabled;
        }
        if (autorenewHint) {
            autorenewHint.hidden = Boolean(user?.autorenew_enabled);
            autorenewHint.textContent = 'Автопродление отключено, списаний без вашего подтверждения не будет.';
        }
    }

  async function patchReceiptEmail() {
        const input = document.getElementById('profileAccountEmail');
        if (!input) return;
        const email = String(input.value || '').trim();
        try {
            const data = await apiFetch('/api/v1/me', { method: 'PATCH', body: { email } });
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            global.showDaActionToast?.('Email для чеков сохранён');
            updateHeaderPills();
        } catch (err) {
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось сохранить email');
        }
    }

    async function setAutorenew(enabled) {
        try {
            const data = await apiFetch('/api/v1/me/autorenew', {
                method: 'POST',
                body: { enabled: Boolean(enabled) },
            });
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            updateHeaderPills();
            global.showDaActionToast?.(enabled ? 'Автопродление включено' : 'Автопродление отключено');
        } catch (_) {
            global.showDaErrorToast?.('Не удалось изменить автопродление');
        }
    }

    async function clearAppCache() {
        try {
            if (global.caches?.keys) {
                const keys = await global.caches.keys();
                await Promise.all(keys.map((k) => global.caches.delete(k)));
            }
            if (global.navigator?.serviceWorker?.getRegistrations) {
                const regs = await global.navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
            }
        } catch (_) { /* */ }
        global.location.reload();
    }

    async function deleteAccount(confirmText) {
        if (String(confirmText || '').trim() !== 'УДАЛИТЬ') {
            global.showDaErrorToast?.('Введите УДАЛИТЬ для подтверждения');
            return;
        }
        try {
            await apiFetch('/api/v1/me', { method: 'DELETE', body: { confirm: 'УДАЛИТЬ' } });
            global.DaAuthSession?.clearSession?.();
            try {
                global.localStorage.clear();
            } catch (_) { /* */ }
            global.location.href = '/';
        } catch (err) {
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось удалить аккаунт');
        }
    }

    function maybeShowOnboarding() {
        try {
            if (global.localStorage.getItem(ONBOARD_KEY) === '1') return;
        } catch (_) { return; }
        if (!global.DaAuthSession?.getJwt?.()) return;
        openModal('subOnboardModal');
    }

    function bindUi() {
        document.querySelectorAll('[data-subscription-pill]').forEach((btn) => {
            btn.addEventListener('click', () => openPaywall());
        });
        document.getElementById('subSoftPayBtn')?.addEventListener('click', () => openPaywall());
        document.getElementById('subSoftLaterBtn')?.addEventListener('click', () => {
            try {
                global.localStorage.setItem(BANNER_HIDE_KEY, String(Date.now() + BANNER_HIDE_MS));
            } catch (_) { /* */ }
            syncSoftBanner();
        });
        document.getElementById('subOnboardOkBtn')?.addEventListener('click', () => {
            try { global.localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) { /* */ }
            closeModal('subOnboardModal');
        });
        document.getElementById('subOnboardPlansBtn')?.addEventListener('click', () => {
            try { global.localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) { /* */ }
            closeModal('subOnboardModal');
            openPaywall();
        });
        document.querySelectorAll('[data-sub-modal-close]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-sub-modal-close');
                if (id) closeModal(id);
            });
        });
        document.querySelectorAll('.sub-modal-overlay[data-sub-overlay]').forEach((overlay) => {
            overlay.addEventListener('click', (ev) => {
                if (ev.target === overlay && overlay.id) closeModal(overlay.id);
            });
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Escape') return;
            closeTopSubModal();
        });
        document.getElementById('subPayBlockedCopyBtn')?.addEventListener('click', async () => {
            const url = document.getElementById('subPayBlockedUrl')?.value || '';
            if (!url) return;
            try {
                await global.navigator.clipboard.writeText(url);
                global.showDaActionToast?.('Ссылка скопирована');
            } catch (_) {
                global.showDaActionToast?.(url);
            }
        });
        document.getElementById('subPayGoBtn')?.addEventListener('click', () => {
            const active = document.querySelector('[data-sub-plan].is-selected');
            const plan = active?.getAttribute('data-sub-plan') || pickDefaultPlan(getUser());
            startPayment(plan);
        });
        document.querySelectorAll('[data-sub-plan]').forEach((card) => {
            card.addEventListener('click', () => {
                selectPayPlan(card.getAttribute('data-sub-plan') || 'month');
            });
        });
        document.getElementById('subCopyRefBtn')?.addEventListener('click', async () => {
            const link = referralLink(getUser());
            if (!link) return;
            try {
                await global.navigator.clipboard.writeText(link);
                global.showDaActionToast?.('Ссылка скопирована');
            } catch (_) {
                global.showDaActionToast?.(link);
            }
        });
        document.getElementById('profileSubRenewBtn')?.addEventListener('click', () => openPaywall());
        document.getElementById('profileSubCopyRefBtn')?.addEventListener('click', async () => {
            const link = referralLink(getUser());
            if (!link) return;
            try {
                await global.navigator.clipboard.writeText(link);
                global.showDaActionToast?.('Ссылка скопирована');
            } catch (_) {
                global.showDaActionToast?.(link);
            }
        });
        document.getElementById('profileSubAutorenewBtn')?.addEventListener('click', () => {
            if (global.confirm('Отключить автопродление? Следующее списание не произойдёт без вашего подтверждения.')) {
                void setAutorenew(false);
            }
        });
        document.getElementById('profileAccountEmailSave')?.addEventListener('click', () => patchReceiptEmail());
        document.getElementById('profileCacheRefreshBtn')?.addEventListener('click', () => clearAppCache());
        document.getElementById('profileAccountLogoutBtn')?.addEventListener('click', () => {
            if (typeof global.handleLogout === 'function') global.handleLogout();
        });
        document.getElementById('profileDeleteOpenBtn')?.addEventListener('click', () => openModal('subDeleteModal'));
        document.getElementById('subDeleteConfirmBtn')?.addEventListener('click', () => {
            const v = document.getElementById('subDeleteConfirmInput')?.value;
            void deleteAccount(v);
        });
        document.getElementById('subResultRetryBtn')?.addEventListener('click', () => {
            closeModal('subResultModal');
            openPaywall();
        });
        document.getElementById('subResultOkBtn')?.addEventListener('click', () => closeModal('subResultModal'));
    }

    function init() {
        captureReferralFromUrl();
        bindUi();
        updateHeaderPills();
        void refreshMe().then(() => {
            updateHeaderPills();
            maybeShowOnboarding();
            void handlePaymentReturn();
        });
        global.addEventListener('storage', () => updateHeaderPills());
    }

    global.DaSubscription = {
        init,
        refreshMe,
        updateHeaderPills,
        openPaywall,
        getStoredReferralCode,
        pillLabel,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);