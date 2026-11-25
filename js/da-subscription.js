/**
 * Подписка Robokassa: пилюля в шапке, мягкая плашка, модалки, профиль.
 */
(function (global) {
    'use strict';

    const REF_KEY = 'da_referral_code';
    const PENDING_PAY_LS_KEY = 'da_pending_payment_inv_id';
    const ONBOARD_KEY = 'da_sub_onboard_v1';
    const BANNER_HIDE_KEY = 'da_sub_banner_hide_until';
    const BANNER_HIDE_MS = 12 * 60 * 60 * 1000;
    const PLAN_AMOUNTS = { trial_bind: 1, month: 150, quarter: 300 };
    const REF_REWARDS_MAX = 3;
    const ACTIVATE_LEAD =
        'Для запуска пробного периода привяжите карту за 1 ₽. '
        + 'По окончании пробного периода подписка продлится автоматически — 300 ₽ раз в 3 месяца; '
        + 'отключить можно в любой момент в профиле.';
    const TRUST_GATE_TEXT =
        'После пробного периода спишется 300 ₽ за 3 месяца. '
        + 'Отключить автопродление можно в профиле в один клик.';
    const AUTORENEW_ON_TITLE = 'Автопродление · 300 ₽ раз в 3 мес.';
    const AUTORENEW_OFF_TITLE = 'Автопродление выключено';

    let referralsCache = { invited: 0, paid: 0, bonus_days: 0 };
    let boundCardsCache = { cards: [], demo: false, can_unbind: false, has_bound_card: false };
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

    function formatRuDateFull(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }

    /** «ещё N день / дня / дней» */
    function ruDaysPhrase(n) {
        const num = Math.max(0, Math.floor(Number(n)) || 0);
        const abs = num % 100;
        const n1 = num % 10;
        let word = 'дней';
        if (abs < 11 || abs > 14) {
            if (n1 === 1) word = 'день';
            else if (n1 >= 2 && n1 <= 4) word = 'дня';
        }
        return `ещё ${num} ${word}`;
    }

    function freeTrialStatusLabel(user) {
        const days = trialDaysLeft(user) || 14;
        return `Бесплатный доступ · ${ruDaysPhrase(days)}`;
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
        if (user?.subscription_status === 'lifetime') return 'paid';
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

    function receiptEmailDisplay(user, inputEl) {
        const typed = String(inputEl?.value || '').trim();
        if (typed) return typed;
        return String(user?.email || '').trim() || 'указать e-mail';
    }

    function syncReceiptEmailUi(prefix) {
        const user = getUser();
        const input = document.getElementById(`${prefix}Email`);
        const label = document.getElementById(`${prefix}ReceiptEmail`);
        if (label) label.textContent = receiptEmailDisplay(user, input);
    }

    function showReceiptEmailField(prefix, show) {
        const compact = document.getElementById(`${prefix}ReceiptCompact`);
        const field = document.getElementById(`${prefix}ReceiptField`);
        if (field) field.hidden = !show;
        if (compact) compact.hidden = show;
        if (show) {
            const input = document.getElementById(`${prefix}Email`);
            global.requestAnimationFrame(() => input?.focus());
        }
    }

    const PAYMENT_CREATE_TIMEOUT_MS = 12000;

    async function apiFetch(path, options) {
        if (typeof global.DaCrewApi?.apiFetch === 'function') {
            return global.DaCrewApi.apiFetch(path, options);
        }
        const base = String(cfg().baseUrl || '').replace(/\/$/, '');
        const headers = {
            'Content-Type': 'application/json',
            ...(global.DaAuthSession?.authHeaders?.() || {}),
        };
        const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
        const ac = new AbortController();
        let timer = null;
        if (timeoutMs > 0) {
            timer = global.setTimeout(() => ac.abort(), timeoutMs);
        }
        try {
            const res = await fetch(`${base}${path}`, {
                method: options?.method || 'GET',
                headers,
                body: options?.body != null ? JSON.stringify(options.body) : undefined,
                cache: 'no-store',
                signal: ac.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || `http_${res.status}`);
                err.payload = data;
                throw err;
            }
            return data;
        } catch (err) {
            if (err?.name === 'AbortError') {
                const timeoutErr = new Error('payment_create_timeout');
                timeoutErr.code = 'TIMEOUT';
                timeoutErr.payload = {
                    message: 'Сервер не ответил за 12 с. Проверьте crew-api и туннель dev-local-pay.',
                };
                throw timeoutErr;
            }
            throw err;
        } finally {
            if (timer) global.clearTimeout(timer);
        }
    }

    async function paymentCreateFetch(body) {
        const opts = { method: 'POST', body, timeoutMs: PAYMENT_CREATE_TIMEOUT_MS };
        return apiFetch('/api/v1/payments/create', opts);
    }

    async function refreshMe() {
        if (!global.DaAuthSession?.getJwt?.()) {
            meFetchState = 'idle';
            return null;
        }
        meFetchState = 'loading';
        try {
            const data = await apiFetch('/api/v1/me');
            if (data.user) {
                global.isHydratingFromServer = true;
                try {
                    global.DaAuthSession.persistSession(null, data.user);
                } finally {
                    global.isHydratingFromServer = false;
                }
            }
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
        syncPlanModal();
        syncProfileSubscriptionBlock();
        syncSoftBanner();
        syncAccessGate();
    }

    function needsActivationGate() {
        if (!global.DaAuthSession?.getJwt?.()) return false;
        const user = getUser();
        if (user?.needs_card_bind === true) return true;
        if (user && user.access_allowed === true) return false;
        if (user && user.access_allowed === false) return true;
        const kind = uiKind(user);
        return kind === 'bind' || kind === 'expired' || kind === 'unknown';
    }

    function syncAccessGate() {
        const need = needsActivationGate();
        document.body.classList.toggle('subscription-blocking', need);
        const gate = document.getElementById('subActivateGate');
        if (gate) {
            gate.hidden = !need;
            gate.setAttribute('aria-hidden', need ? 'false' : 'true');
        }
        if (need) {
            const user = getUser();
            const emailInput = document.getElementById('subActivateEmail');
            if (emailInput && user?.email && !emailInput.value) emailInput.value = user.email;
            const ref = getStoredReferralCode();
            const titleEl = document.getElementById('subActivateTitle');
            const leadEl = document.getElementById('subActivateLead');
            if (titleEl) {
                titleEl.textContent = ref
                    ? 'Активируйте 21 день бесплатно'
                    : 'Активируйте 14 дней бесплатно';
            }
            if (leadEl) leadEl.textContent = ACTIVATE_LEAD;
            const trustGate = document.getElementById('subActivateTrustText');
            if (trustGate) trustGate.textContent = TRUST_GATE_TEXT;
            syncReceiptEmailUi('subActivate');
            showReceiptEmailField('subActivate', false);
            syncPaymentConsentUi();
        }
    }

    function applyElHidden(el, hide) {
        if (!el) return;
        el.hidden = hide;
        if (hide) {
            el.style.display = 'none';
            el.setAttribute('aria-hidden', 'true');
        } else {
            el.style.removeProperty('display');
            el.removeAttribute('aria-hidden');
        }
    }

    function userTermsAccepted(user) {
        if (!user) return false;
        if (user.terms_accepted === true) return true;
        if (global.DaLegalConsent?.needsConsentForUser) {
            return !global.DaLegalConsent.needsConsentForUser(user);
        }
        return Boolean(user.terms_accepted_at);
    }

    /** Активный/использованный триал, оплата или привязка карты (в т.ч. по subscription_ui с /me). */
    function userHasPaidBindOrActiveTrial(user) {
        if (!user) return false;
        const kind = uiKind(user);
        if (kind === 'trial' || kind === 'paid' || kind === 'expired') return true;
        const uiKindRaw = String(user.subscription_ui?.kind || '').toLowerCase();
        if (uiKindRaw === 'trial' || uiKindRaw === 'paid' || uiKindRaw === 'expired') return true;
        if (user.trial_card_bound_at || user.card_bound || user.has_bound_card) return true;
        if (user.robokassa_mother_inv_id != null && Number(user.robokassa_mother_inv_id) > 0) return true;
        if (user.first_paid_at) return true;
        if (user.terms_accepted === true || user.terms_accepted_at) return true;
        const trialEnd = user.trial_ends_at;
        if (trialEnd && new Date(trialEnd).getTime() > Date.now()) return true;
        if (user.access_allowed === true && (user.trial_card_bound_at || user.has_bound_card || user.card_bound)) return true;
        const end = user.subscription_ends_at || user.subscription_expires_at;
        if (end && new Date(end).getTime() > Date.now()) return true;
        return false;
    }

    /** Чекбокс в модалке подписки — только новые без согласий и без оплаты/карты/триала. */
    function needsPlanModalConsent(user) {
        if (!user) return true;
        if (userHasPaidBindOrActiveTrial(user)) return false;
        if (userTermsAccepted(user)) return false;
        return true;
    }

    function showPlanAutorenewRow(user) {
        if (!user) return false;
        return Boolean(
            user.autorenew_enabled
            || user.trial_card_bound_at
            || user.card_bound
            || user.has_bound_card
            || (user.robokassa_mother_inv_id != null && Number(user.robokassa_mother_inv_id) > 0),
        );
    }

    let autorenewSwitchBusy = false;

    function syncPaymentConsentUi() {
        const user = getUser();
        const gateOpen = needsActivationGate();
        const needGateConsent = gateOpen && global.DaLegalConsent?.needsConsentForUser(user);
        const needPlanConsent = needsPlanModalConsent(user);
        const activateConsent = document.getElementById('subActivateConsent');
        const planConsent = document.getElementById('subPlanConsent');
        const planLinks = document.getElementById('subPlanLegalLinks');
        const showActivate = Boolean(needGateConsent);
        const showPlanConsent = Boolean(needPlanConsent && !gateOpen);
        global.DaLegalConsent?.setVisible(activateConsent, showActivate);
        global.DaLegalConsent?.setVisible(planConsent, showPlanConsent);
        applyElHidden(planConsent, !showPlanConsent);
        applyElHidden(activateConsent, !showActivate);
        if (planLinks) planLinks.hidden = false;
        if (showActivate && activateConsent) {
            global.DaLegalConsent?.bindRoot?.(activateConsent);
            global.DaLegalConsent?.syncButtonForRoot?.(activateConsent);
        }
        if (showPlanConsent) {
            global.DaLegalConsent?.bindRoot?.(planConsent);
            global.DaLegalConsent?.syncButtonForRoot?.(planConsent);
        } else if (planConsent) {
            global.DaLegalConsent?.syncButtonForRoot?.(planConsent);
        }
    }

    function shouldShowTrialPlanCard(user) {
        if (userHasPaidBindOrActiveTrial(user)) return false;
        return uiKind(user) === 'bind';
    }

    function autorenewRowCopy(user, autorenewOn) {
        const kind = uiKind(user);
        const paidAccess = kind === 'paid';
        if (autorenewOn) {
            let subtitle = 'Спишется после пробного периода';
            if (paidAccess) {
                const end = user?.subscription_ends_at || user?.subscription_expires_at;
                subtitle = end
                    ? `Следующее списание — ${formatRuDateFull(end)}`
                    : 'Спишется после пробного периода';
            }
            return { title: AUTORENEW_ON_TITLE, hint: subtitle };
        }
        const hint = paidAccess
            ? 'Доступ действует до конца оплаченного периода'
            : 'Доступ закроется после пробного периода';
        return { title: AUTORENEW_OFF_TITLE, hint };
    }

    function syncPlanAutorenewRow(user) {
        const arRow = document.getElementById('subPlanAutorenewRow');
        const arTitle = document.getElementById('subPlanAutorenewTitle');
        const arHint = document.getElementById('subPlanAutorenewHint');
        const sw = document.getElementById('subPlanAutorenewSwitch');
        if (!arRow) return;
        const visible = showPlanAutorenewRow(user);
        applyElHidden(arRow, !visible);
        arRow.classList.toggle('is-loading', autorenewSwitchBusy);
        if (!visible) return;
        const on = Boolean(user?.autorenew_enabled);
        const copy = autorenewRowCopy(user, on);
        if (arTitle) arTitle.textContent = copy.title;
        if (arHint) arHint.textContent = copy.hint;
        const swWrap = sw?.closest?.('.da-switch');
        if (sw) {
            sw.checked = on;
            sw.disabled = autorenewSwitchBusy;
            sw.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        if (swWrap) swWrap.classList.toggle('is-on', on);
    }

    function planPayButtonLabel(plan) {
        if (plan === 'trial_bind') return 'Привязать карту за 1 ₽';
        const sum = PLAN_AMOUNTS[plan] || PLAN_AMOUNTS.month;
        return `Оплатить ${sum} ₽`;
    }

    function syncPlanModal() {
        const user = getUser();
        const kind = uiKind(user);
        const statusEl = document.getElementById('subPlanStatus');
        if (statusEl) {
            if (kind === 'loading' || kind === 'unknown') {
                statusEl.textContent = 'Загрузка статуса подписки…';
            } else if (kind === 'bind') {
                statusEl.textContent = 'Привяжите карту за 1 ₽ — старт триала 14 дней';
            } else if (kind === 'trial') {
                statusEl.textContent = freeTrialStatusLabel(user);
            } else if (kind === 'paid') {
                const end = user.subscription_ends_at || user.subscription_expires_at;
                statusEl.textContent = `Подписка активна до ${formatShortDate(end)}`;
            } else {
                statusEl.textContent = 'Пробный период завершён — оформите подписку';
            }
        }
        syncPlanAutorenewRow(user);
        const showTrial = shouldShowTrialPlanCard(user);
        const trialCard = document.getElementById('subPlanTrialBind');
        applyElHidden(trialCard, !showTrial);
        const cardsWrap = document.querySelector('#subPlanModal .sub-plan-cards--landing');
        if (cardsWrap) cardsWrap.classList.toggle('sub-plan-cards--with-trial', showTrial);
        const selected = document.querySelector('[data-sub-plan].is-selected');
        let plan = selected?.getAttribute('data-sub-plan') || pickDefaultPlan(user);
        if (!showTrial && plan === 'trial_bind') plan = 'month';
        selectPayPlan(plan, { skipTrialToggle: true });
        syncPaymentConsentUi();
    }

    function showActivationGate() {
        syncAccessGate();
    }

    function blocksMainScreen() {
        return needsActivationGate();
    }

    function paymentEmail() {
        const user = getUser();
        const profileEmail = String(user?.email || '').trim();
        const gateVis = !document.getElementById('subActivateGate')?.hidden;
        if (gateVis) {
            const typed = String(document.getElementById('subActivateEmail')?.value || '').trim();
            return typed || profileEmail;
        }
        return profileEmail;
    }

    function shouldShowSoftBanner() {
        if (needsActivationGate()) return false;
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

    function savePendingPayment(meta) {
        try {
            global.localStorage.setItem(PENDING_PAY_LS_KEY, JSON.stringify(meta));
        } catch (_) { /* */ }
    }

    function readPendingPayment() {
        try {
            const raw = global.localStorage.getItem(PENDING_PAY_LS_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            const invId = data?.inv_id ?? data?.invId;
            if (!invId) return null;
            return { ...data, inv_id: String(invId) };
        } catch (_) {
            return null;
        }
    }

    function clearPendingPayment() {
        try {
            global.localStorage.removeItem(PENDING_PAY_LS_KEY);
        } catch (_) { /* */ }
    }

    function isActivateGateOpen() {
        const gate = document.getElementById('subActivateGate');
        return Boolean(gate && !gate.hidden);
    }

    let pendingPayResumeActive = false;

    async function syncPendingPaymentFromStorage() {
        if (!global.DaAuthSession?.getJwt?.()) return;
        if (!isActivateGateOpen()) return;
        const pending = readPendingPayment();
        if (!pending?.inv_id) return;

        const rb = {
            inv: pending.inv_id,
            outSum: pending.out_sum || pending.OutSum || '1.00',
            sig: pending.signature_value || pending.SignatureValue || '',
        };
        const emptyParams = new URLSearchParams();
        let detail = null;
        try {
            detail = await syncInvoiceAfterReturn(emptyParams, rb);
            await refreshMe();
        } catch (err) {
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось синхронизировать оплату');
            return;
        }

        const paid = Boolean(detail?.confirmed)
            || detail?.transaction?.status === 'paid'
            || detail?.user?.access_allowed
            || userHasBoundCard(detail?.user);
        if (paid) {
            clearPendingPayment();
            showPaymentSuccessModal(detail);
            updateHeaderPills();
            syncAccessGate();
        }
    }

    async function handlePendingPaymentOnResume() {
        if (pendingPayResumeActive) return;
        if (!readPendingPayment()) return;
        if (!isActivateGateOpen()) return;
        pendingPayResumeActive = true;
        try {
            await syncPendingPaymentFromStorage();
        } finally {
            pendingPayResumeActive = false;
        }
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
        if (shouldShowTrialPlanCard(user)) return 'trial_bind';
        return 'month';
    }

    function selectPayPlan(plan, opts) {
        const user = getUser();
        const showTrial = shouldShowTrialPlanCard(user);
        if (!showTrial && plan === 'trial_bind') plan = 'month';
        document.querySelectorAll('[data-sub-plan]').forEach((c) => {
            if (c.hidden || c.style.display === 'none') {
                c.classList.remove('is-selected');
                return;
            }
            c.classList.toggle('is-selected', c.getAttribute('data-sub-plan') === plan);
        });
        const btn = document.getElementById('subPayGoBtn');
        if (btn) btn.textContent = planPayButtonLabel(plan);
        if (!opts?.skipTrialToggle) {
            const trialCard = document.getElementById('subPlanTrialBind');
            applyElHidden(trialCard, !showTrial);
        }
    }

    function forcePlanModalVisibility(user) {
        const showTrial = shouldShowTrialPlanCard(user);
        applyElHidden(document.getElementById('subPlanTrialBind'), !showTrial);
        const showConsent = Boolean(needsPlanModalConsent(user) && !needsActivationGate());
        applyElHidden(document.getElementById('subPlanConsent'), !showConsent);
        syncPaymentConsentUi();
        syncPlanAutorenewRow(user);
    }

    async function openPaywall() {
        if (global.DaAuthSession?.getJwt?.()) {
            await refreshMe();
        }
        const user = getUser();
        syncPlanModal();
        selectPayPlan(pickDefaultPlan(user), { skipTrialToggle: true });
        forcePlanModalVisibility(user);
        openModal('subPlanModal');
        global.requestAnimationFrame(() => forcePlanModalVisibility(getUser()));
    }

    function activeConsentRoot() {
        const gateVis = !document.getElementById('subActivateGate')?.hidden;
        return document.getElementById(gateVis ? 'subActivateConsent' : 'subPlanConsent');
    }

    async function startPayment(plan) {
        const user = getUser();
        const email = paymentEmail();
        const consentRoot = activeConsentRoot();
        const gateVis = !document.getElementById('subActivateGate')?.hidden;
        const consentRequired = gateVis
            ? (global.DaLegalConsent?.needsConsentForUser(user) && consentRoot && !consentRoot.hidden)
            : (needsPlanModalConsent(user) && consentRoot && !consentRoot.hidden);
        if (consentRequired && consentRoot && !consentRoot.hidden) {
            if (!global.DaLegalConsent.bothChecked(consentRoot)) {
                global.DaLegalConsent.flashMissing(consentRoot);
                const combined = consentRoot?.dataset?.consentCombined === '1';
                global.showDaErrorToast?.(combined
                    ? 'Отметьте согласие с офертой и политикой конфиденциальности.'
                    : 'Отметьте оба согласия: оферту и политику конфиденциальности.');
                return;
            }
        }
        const gateBtn = document.getElementById('subActivateBindBtn');
        const btn = document.getElementById('subPayGoBtn');
        const payBtn = gateBtn && !document.getElementById('subActivateGate')?.hidden ? gateBtn : btn;
        if (payBtn?.dataset.paymentLoading === '1') return;
        if (payBtn) {
            payBtn.dataset.paymentLoading = '1';
            payBtn.disabled = true;
        }
        try {
            const body = {
                plan,
                email: email || undefined,
                return_origin: (() => {
                    const loc = global.location;
                    if (!loc?.origin) return '';
                    const p = String(loc.pathname || '/').replace(/\/$/, '') || '';
                    return p && p !== '/' ? `${loc.origin}${p}` : loc.origin;
                })(),
            };
            const sendConsent = gateVis
                ? global.DaLegalConsent?.needsConsentForUser(user)
                : needsPlanModalConsent(user);
            if (sendConsent) {
                Object.assign(body, global.DaLegalConsent.consentPayload());
            }
            const data = await paymentCreateFetch(body);
            if (data.payment_url) {
                savePendingPayment({
                    inv_id: data.inv_id,
                    out_sum: data.amount || PLAN_AMOUNTS[plan],
                    signature_value: data.signature_value || data.SignatureValue || null,
                    plan,
                    saved_at: Date.now(),
                });
                global.location.assign(data.payment_url);
                return;
            }
            global.showDaErrorToast?.('Не удалось создать платёж: нет ссылки на оплату.');
        } catch (err) {
            const code = err?.payload?.error || err?.code;
            const msg = err?.payload?.message
                || (code === 'TIMEOUT' || err?.message === 'payment_create_timeout'
                    ? 'Таймаут оплаты (12 с). Проверьте crew-api и туннель.'
                    : code === 'payments_not_configured'
                        ? 'Оплата на сервере не настроена (Robokassa).'
                        : 'Не удалось создать платёж. Попробуйте позже.');
            global.showDaErrorToast?.(msg);
        } finally {
            if (payBtn) {
                delete payBtn.dataset.paymentLoading;
                payBtn.disabled = false;
            }
            syncPaymentConsentUi();
        }
    }

    function clearPaymentReturnUrl() {
        const clean = new URL(global.location.href);
        [
            'payment', 'inv_id', 'InvId', 'OutSum', 'out_summ', 'SignatureValue', 'crc',
            'Culture', 'Fee', 'EMail', 'Email', 'PaymentMethod', 'IncCurrLabel', 'IsTest',
        ].forEach((key) => clean.searchParams.delete(key));
        global.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
    }

    function robokassaReturnParams(p) {
        const outSum = p.get('OutSum') || p.get('out_summ');
        const inv = p.get('InvId') || p.get('inv_id');
        const sig = p.get('SignatureValue') || p.get('crc');
        const paymentFlag = String(p.get('payment') || '').trim().toLowerCase();
        if (!inv) return null;
        if (paymentFlag === 'success' || (outSum && sig)) {
            return { outSum, inv, sig, payment: paymentFlag };
        }
        return null;
    }

    function buildSyncInvoiceBody(p, rb) {
        const body = { inv_id: rb.inv };
        if (rb.outSum) body.out_sum = rb.outSum;
        if (rb.sig) body.signature = rb.sig;
        [
            'PaymentMethod', 'IncCurrLabel', 'IsTest', 'CardPan', 'MaskedPan', 'Email', 'OutSum',
        ].forEach((key) => {
            const v = p.get(key);
            if (v) body[key] = v;
        });
        return body;
    }

    async function syncInvoiceAfterReturn(p, rb, opts = {}) {
        const attempts = opts.attempts || 8;
        const delayMs = opts.delayMs || 2000;
        const body = buildSyncInvoiceBody(p, rb);
        let last = null;
        for (let i = 0; i < attempts; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const detail = await apiFetch('/api/v1/payments/sync-invoice', {
                method: 'POST',
                body,
            });
            last = detail;
            if (detail?.user) global.DaAuthSession.persistSession(null, detail.user);
            if (detail?.confirmed) return detail;
            if (!detail?.pending) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => global.setTimeout(r, delayMs));
        }
        return last;
    }

    function showPaymentSuccessModal(detail) {
        const user = detail?.user || getUser();
        const txPlan = detail?.transaction?.plan;
        const end = user?.subscription_ends_at || user?.subscription_expires_at;
        const trial = user?.trial_ends_at;
        const title = document.getElementById('subResultTitle');
        const text = document.getElementById('subResultText');
        const retryBtn = document.getElementById('subResultRetryBtn');
        if (title) {
            title.textContent = txPlan === 'trial_bind' || (!end && trial)
                ? 'Карта привязана'
                : 'Оплата прошла';
        }
        if (text) {
            if (txPlan === 'trial_bind' || (!end && trial)) {
                const days = trialDaysLeft(user) || (user?.referred_by ? 21 : 14);
                text.textContent = `Карта привязана — открыты ${days} дней бесплатно. Чек на ${user?.email || 'указанную почту'}.`;
            } else if (end) {
                text.textContent = `Подписка до ${formatShortDate(end)}. Чек на ${user?.email || 'указанную почту'}.`;
            } else {
                text.textContent = 'Платёж принят. Обновляю статус…';
            }
        }
        if (retryBtn) retryBtn.hidden = true;
        closeModal('subPayOpenedModal');
        closeModal('subPayBlockedModal');
        openModal('subResultModal');
        updateHeaderPills();
        syncAccessGate();
    }

    async function handlePaymentReturn() {
        const p = new URLSearchParams(global.location.search);
        const rb = robokassaReturnParams(p);
        const payment = String(p.get('payment') || '').trim().toLowerCase();

        if (payment === 'fail') {
            const title = document.getElementById('subResultTitle');
            const text = document.getElementById('subResultText');
            const retryBtn = document.getElementById('subResultRetryBtn');
            if (title) title.textContent = 'Оплата не завершена';
            if (text) text.textContent = 'Платёж отменён или прерван. Можно попробовать снова.';
            if (retryBtn) retryBtn.hidden = false;
            closeModal('subPayOpenedModal');
            openModal('subResultModal');
            clearPaymentReturnUrl();
            updateHeaderPills();
            syncAccessGate();
            return;
        }

        if (!rb || !global.DaAuthSession?.getJwt?.()) {
            if (rb) clearPaymentReturnUrl();
            return;
        }

        const dedupeKey = `da_pay_ok_${rb.inv}`;
        try {
            if (global.sessionStorage?.getItem(dedupeKey) === '1') {
                clearPaymentReturnUrl();
                return;
            }
        } catch (_) { /* */ }

        let detail = null;
        try {
            detail = await syncInvoiceAfterReturn(p, rb);
        } catch (err) {
            clearPaymentReturnUrl();
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось синхронизировать оплату с Robokassa');
            return;
        }

        const paid = Boolean(detail?.confirmed)
            || detail?.transaction?.status === 'paid'
            || detail?.user?.access_allowed;
        if (!paid) {
            clearPaymentReturnUrl();
            global.showDaErrorToast?.('Оплата ещё не подтверждена Robokassa. Обновите страницу через минуту.');
            return;
        }
        try {
            global.sessionStorage?.setItem(dedupeKey, '1');
        } catch (_) { /* */ }
        clearPaymentReturnUrl();
        clearPendingPayment();
        showPaymentSuccessModal(detail);
    }

    function profileSubStatusBadgeText(user, kind) {
        if (kind === 'loading' || kind === 'unknown') return 'Загрузка…';
        if (kind === 'bind') return 'Триал · привязка 1 ₽';
        if (kind === 'trial') {
            const trialIso = user?.trial_ends_at;
            const days = trialDaysLeft(user) || 14;
            return trialIso
                ? `Триал до ${formatShortDate(trialIso)} · ${days} дн.`
                : `Триал · ${days} дн.`;
        }
        if (kind === 'paid') {
            const end = user.subscription_ends_at || user.subscription_expires_at;
            return `Активна до ${formatShortDate(end)}`;
        }
        if (kind === 'expired') return 'Не оплачена';
        return '—';
    }

    function syncProfileReceiptEmailUi() {
        const user = getUser();
        const email = String(user?.email || '').trim();
        const valueEl = document.getElementById('profileReceiptEmailValue');
        const input = document.getElementById('profileReceiptEmailInput');
        if (valueEl) valueEl.textContent = email || '—';
        if (input && document.activeElement !== input && !input.value && email) {
            input.value = email;
        }
    }

    function userHasBoundCard(user) {
        if (!user) return false;
        if (user.has_bound_card === true || user.card_bound === true) return true;
        const mother = Number(user.robokassa_mother_inv_id);
        return Boolean(user.trial_card_bound_at && Number.isFinite(mother) && mother > 0);
    }

    function cardBrandDisplayTitle(brand) {
        const b = String(brand || '').trim();
        if (!b || b === 'Карта') return 'Банковская карта';
        return b;
    }

    function formatCardListLabel(card, user) {
        const brand = String(card?.brand || user?.card_brand || '').trim();
        const last4 = String(card?.last4 || user?.card_last4 || '').trim();
        if (brand === 'Тестовая карта Robokassa' || card?.is_test) {
            return 'Тестовая карта Robokassa';
        }
        if (last4) {
            return `${cardBrandDisplayTitle(brand)} •••• ${last4}`;
        }
        return cardBrandDisplayTitle(brand);
    }

    function sessionFallbackCards(user) {
        if (!userHasBoundCard(user)) return [];
        return [{
            inv_id: Number(user.robokassa_mother_inv_id) || 0,
            active: true,
            bound_at: user.trial_card_bound_at || null,
            autorenew_enabled: Boolean(user.autorenew_enabled),
            brand: user.card_brand || null,
            last4: user.card_last4 || null,
            is_test: user.card_brand === 'Тестовая карта Robokassa',
            label: formatCardListLabel(null, user),
        }];
    }

    function mergeBoundCards(apiCards, user, hasBound) {
        const list = Array.isArray(apiCards) ? [...apiCards] : [];
        if (list.some((c) => c.active)) return list;
        if (hasBound === true || userHasBoundCard(user)) {
            const fb = sessionFallbackCards(user);
            if (fb.length) return fb;
        }
        return list;
    }

    function profileBoundCardsSummary() {
        if (boundCardsCache.has_bound_card === true) {
            const cards = boundCardsCache.cards || [];
            const n = cards.length || 1;
            return n === 1 ? '1 карта' : `${n} карты`;
        }
        const cards = boundCardsCache.cards || [];
        if (cards.length) return cards.length === 1 ? '1 карта' : `${cards.length} карты`;
        return userHasBoundCard(getUser()) ? '1 карта' : 'Нет';
    }

    function syncProfileBoundCardsValue() {
        const valueEl = document.getElementById('profileBoundCardsValue');
        if (valueEl) valueEl.textContent = profileBoundCardsSummary();
    }

    function renderProfileBoundCards() {
        const list = document.getElementById('profileBoundCardsList');
        const emptyEl = document.getElementById('profileBoundCardsEmpty');
        const demoEl = document.getElementById('profileBoundCardsDemo');
        if (!list) return;
        const user = getUser();
        const demo = Boolean(boundCardsCache.demo);
        list.innerHTML = '';
        if (demoEl) demoEl.hidden = !demo;
        const bindBtn = document.getElementById('profileBoundCardsBindBtn');
        const hasBound = boundCardsCache.has_bound_card === true || userHasBoundCard(user);
        let cards = boundCardsCache.cards || [];
        if (!cards.length && hasBound) {
            cards = sessionFallbackCards(user);
        }
        const showEmpty = !demo && cards.length === 0 && !hasBound;
        if (emptyEl) {
            emptyEl.hidden = !showEmpty;
            emptyEl.style.display = showEmpty ? '' : 'none';
        }
        if (bindBtn) {
            bindBtn.hidden = !showEmpty;
            bindBtn.style.display = showEmpty ? '' : 'none';
        }
        if (demo) {
            syncProfileBoundCardsValue();
            return;
        }
        cards.forEach((card) => {
            const li = document.createElement('li');
            li.className = 'profile-bound-cards__item';
            const main = document.createElement('div');
            main.className = 'profile-bound-cards__main';
            const title = document.createElement('div');
            title.className = 'profile-bound-cards__title';
            title.textContent = formatCardListLabel(card, user);
            const meta = document.createElement('div');
            meta.className = 'profile-bound-cards__meta';
            const parts = [];
            if (card.bound_at) parts.push(`с ${formatShortDate(card.bound_at)}`);
            if (card.autorenew_enabled) parts.push('автопродление');
            else if (card.active) parts.push('автопродление выкл.');
            meta.textContent = parts.join(' · ') || '—';
            main.appendChild(title);
            main.appendChild(meta);
            li.appendChild(main);
            if (card.active && (boundCardsCache.can_unbind || userHasBoundCard(user))) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'profile-bound-cards__unbind';
                btn.textContent = 'Отвязать';
                btn.dataset.invId = String(card.inv_id);
                btn.addEventListener('click', () => {
                    const msg = 'Отвязать карту? Автопродление отключится; без карты пробный период недоступен.';
                    if (global.confirm(msg)) void unbindProfileCard(card.inv_id);
                });
                li.appendChild(btn);
            }
            list.appendChild(li);
        });
        syncProfileBoundCardsValue();
    }

    async function fetchProfileBoundCards() {
        if (!global.DaAuthSession?.getJwt?.()) return;
        const user = getUser();
        try {
            const data = await apiFetch('/api/v1/me/cards');
            const hasBound = data.has_bound_card === true || userHasBoundCard(user);
            boundCardsCache = {
                cards: mergeBoundCards(data.cards, user, hasBound),
                demo: Boolean(data.demo),
                can_unbind: Boolean(data.can_unbind),
                has_bound_card: hasBound,
            };
        } catch (_) {
            const hasBound = userHasBoundCard(user);
            const fallback = sessionFallbackCards(user);
            boundCardsCache = {
                cards: hasBound ? fallback : [],
                demo: false,
                can_unbind: hasBound,
                has_bound_card: hasBound,
            };
        }
        renderProfileBoundCards();
    }

    async function unbindProfileCard(invId) {
        try {
            const data = await apiFetch('/api/v1/me/cards/unbind', {
                method: 'POST',
                body: { inv_id: invId },
            });
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            global.showDaActionToast?.('Карта отвязана');
            boundCardsCache = { cards: [], demo: false, can_unbind: false, has_bound_card: false };
            await fetchProfileBoundCards();
            updateHeaderPills();
            showActivationGate();
        } catch (err) {
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось отвязать карту');
        }
    }

    function setProfileBoundCardsEditorOpen(open) {
        const editor = document.getElementById('profileBoundCardsEditor');
        const toggle = document.getElementById('profileBoundCardsToggle');
        if (!editor || !toggle) return;
        editor.classList.toggle('is-open', open);
        editor.setAttribute('aria-hidden', open ? 'false' : 'true');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) void fetchProfileBoundCards();
    }

    function bindCardFromProfile() {
        const user = getUser();
        if (userHasBoundCard(user)) {
            global.showDaActionToast?.('Карта уже привязана');
            void fetchProfileBoundCards();
            return;
        }
        void startPayment('trial_bind');
    }

    function toggleProfileBoundCardsEditor(forceOpen) {
        const editor = document.getElementById('profileBoundCardsEditor');
        if (!editor) return;
        const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !editor.classList.contains('is-open');
        if (nextOpen) {
            const emailEditor = document.getElementById('profileReceiptEmailEditor');
            if (emailEditor?.classList.contains('is-open')) {
                setProfileReceiptEmailEditorOpen(false);
            }
        }
        setProfileBoundCardsEditorOpen(nextOpen);
    }

    function syncProfileSubscriptionBlock() {
        const user = getUser();
        const renewBtn = document.getElementById('profileSubRenewBtn');
        const refStat = document.getElementById('profileSubRefStat');
        const refInput = document.getElementById('profileSubRefUrlInput');
        const autorenewRow = document.getElementById('profileSubAutorenewRow');
        const kind = uiKind(user);
        const badgeText = profileSubStatusBadgeText(user, kind);
        const badgeEl = document.getElementById('profileSubStatusBadge');
        if (badgeEl) badgeEl.textContent = badgeText;
        if (renewBtn) {
            renewBtn.textContent = kind === 'paid' ? 'Продлить' : 'Оплатить';
        }
        const invited = referralsCache.rewards_count != null
            ? referralsCache.rewards_count
            : (referralsCache.paid || referralsCache.invited || 0);
        const max = referralsCache.rewards_max || REF_REWARDS_MAX;
        if (refStat) refStat.textContent = `Приглашено: ${invited} из ${max}`;
        if (refInput) refInput.value = referralLink(user) || '';
        if (autorenewRow) autorenewRow.hidden = !user?.autorenew_enabled;
        syncProfileReceiptEmailUi();
        if (userHasBoundCard(user)) {
            boundCardsCache.has_bound_card = true;
            if (!(boundCardsCache.cards || []).length) {
                boundCardsCache.cards = sessionFallbackCards(user);
            }
        } else {
            boundCardsCache.has_bound_card = false;
        }
        syncProfileBoundCardsValue();
        renderProfileBoundCards();
    }

    async function patchReceiptEmail() {
        const input = document.getElementById('profileReceiptEmailInput');
        if (!input) return;
        const email = String(input.value || '').trim();
        try {
            const data = await apiFetch('/api/v1/me', { method: 'PATCH', body: { email } });
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            global.showDaActionToast?.('Email для чеков сохранён');
            syncProfileReceiptEmailUi();
            const headerEmail = document.getElementById('profileAccountEmail');
            if (headerEmail) headerEmail.textContent = email || '—';
            setProfileReceiptEmailEditorOpen(false);
            updateHeaderPills();
        } catch (err) {
            global.showDaErrorToast?.(err?.payload?.message || 'Не удалось сохранить email');
        }
    }

    function setProfileReceiptEmailEditorOpen(open) {
        const editor = document.getElementById('profileReceiptEmailEditor');
        const toggle = document.getElementById('profileReceiptEmailToggle');
        const input = document.getElementById('profileReceiptEmailInput');
        if (!editor || !toggle) return;
        editor.classList.toggle('is-open', open);
        editor.setAttribute('aria-hidden', open ? 'false' : 'true');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            const cardsEditor = document.getElementById('profileBoundCardsEditor');
            if (cardsEditor?.classList.contains('is-open')) {
                setProfileBoundCardsEditorOpen(false);
            }
            const user = getUser();
            if (input && user?.email && !String(input.value || '').trim()) {
                input.value = user.email;
            }
            global.requestAnimationFrame(() => input?.focus());
        }
    }

    function toggleProfileReceiptEmailEditor(forceOpen) {
        const editor = document.getElementById('profileReceiptEmailEditor');
        if (!editor) return;
        const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !editor.classList.contains('is-open');
        setProfileReceiptEmailEditorOpen(nextOpen);
    }

    async function setAutorenew(enabled) {
        try {
            const data = await apiFetch('/api/v1/me/autorenew', {
                method: 'POST',
                body: { enabled: Boolean(enabled) },
            });
            if (data.user) global.DaAuthSession.persistSession(null, data.user);
            updateHeaderPills();
            syncPlanAutorenewRow(data.user || getUser());
            syncProfileSubscriptionBlock();
            global.showDaActionToast?.(enabled ? 'Автопродление включено' : 'Автопродление отключено');
        } catch (err) {
            global.showDaErrorToast?.('Не удалось изменить автопродление');
            throw err;
        }
    }

    async function setAutorenewFromPlanSwitch(enabled) {
        if (autorenewSwitchBusy) return;
        const sw = document.getElementById('subPlanAutorenewSwitch');
        const arRow = document.getElementById('subPlanAutorenewRow');
        const prev = Boolean(getUser()?.autorenew_enabled);
        if (prev === Boolean(enabled)) return;
        autorenewSwitchBusy = true;
        if (sw) sw.disabled = true;
        if (arRow) arRow.classList.add('is-loading');
        try {
            await setAutorenew(enabled);
        } catch (_) {
            if (sw) sw.checked = prev;
        } finally {
            autorenewSwitchBusy = false;
            if (sw) sw.disabled = false;
            if (arRow) arRow.classList.remove('is-loading');
            syncPlanAutorenewRow(getUser());
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

    function bindUi() {
        document.querySelectorAll('[data-subscription-pill]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (needsActivationGate()) showActivationGate();
                else openPaywall();
            });
        });
        document.getElementById('subSoftPayBtn')?.addEventListener('click', () => {
            if (needsActivationGate()) showActivationGate();
            else openPaywall();
        });
        document.getElementById('subSoftLaterBtn')?.addEventListener('click', () => {
            try {
                global.localStorage.setItem(BANNER_HIDE_KEY, String(Date.now() + BANNER_HIDE_MS));
            } catch (_) { /* */ }
            syncSoftBanner();
        });
        document.getElementById('subActivateBindBtn')?.addEventListener('click', () => startPayment('trial_bind'));
        document.getElementById('subActivateLogoutBtn')?.addEventListener('click', () => {
            if (typeof global.handleLogout === 'function') global.handleLogout();
        });
        document.getElementById('subActivateReceiptEditBtn')?.addEventListener('click', () => {
            showReceiptEmailField('subActivate', true);
        });
        document.getElementById('subActivateEmail')?.addEventListener('input', () => syncReceiptEmailUi('subActivate'));
        document.getElementById('subActivateEmail')?.addEventListener('blur', () => {
            syncReceiptEmailUi('subActivate');
            if (String(document.getElementById('subActivateEmail')?.value || '').trim()) {
                showReceiptEmailField('subActivate', false);
            }
        });
        document.querySelectorAll('[data-sub-activate-plan]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const plan = btn.getAttribute('data-sub-activate-plan') || 'month';
                void startPayment(plan);
            });
        });
        document.querySelectorAll('[data-sub-modal-close]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-sub-modal-close');
                if (id) closeModal(id);
            });
        });
        document.querySelectorAll('.sub-modal-overlay[data-sub-overlay]').forEach((overlay) => {
            overlay.addEventListener('click', (ev) => {
                if (overlay.hasAttribute('data-sub-nodismiss')) return;
                if (ev.target === overlay && overlay.id) closeModal(overlay.id);
            });
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Escape') return;
            if (needsActivationGate()) return;
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
        document.getElementById('subPlanAutorenewSwitch')?.addEventListener('change', (ev) => {
            const on = Boolean(ev.currentTarget?.checked);
            void setAutorenewFromPlanSwitch(on);
        });
        document.getElementById('profileSubRenewBtn')?.addEventListener('click', () => openPaywall());
        document.getElementById('profileSubCopyRefBtn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const link = referralLink(getUser())
                || document.getElementById('profileSubRefUrlInput')?.value;
            if (!link) return;
            try {
                await global.navigator.clipboard.writeText(link);
                global.showDaActionToast?.('Ссылка скопирована');
            } catch (_) {
                global.showDaActionToast?.(link);
                return;
            }
            btn.classList.add('is-copied');
            global.setTimeout(() => btn.classList.remove('is-copied'), 2000);
        });
        document.getElementById('profileSubAutorenewBtn')?.addEventListener('click', () => {
            if (global.confirm('Отключить автопродление? Следующее списание не произойдёт без вашего подтверждения.')) {
                void setAutorenew(false);
            }
        });
        document.getElementById('profileReceiptEmailToggle')?.addEventListener('click', () => {
            toggleProfileReceiptEmailEditor();
        });
        document.getElementById('profileBoundCardsToggle')?.addEventListener('click', () => {
            toggleProfileBoundCardsEditor();
        });
        document.getElementById('profileBoundCardsBindBtn')?.addEventListener('click', () => {
            bindCardFromProfile();
        });
        document.getElementById('profileAccountEmailSave')?.addEventListener('click', () => patchReceiptEmail());
        document.getElementById('profileCacheRefreshBtn')?.addEventListener('click', () => clearAppCache());
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
            void handlePaymentReturn();
            void handlePendingPaymentOnResume();
        });
        global.addEventListener('storage', () => updateHeaderPills());
        global.document?.addEventListener('visibilitychange', () => {
            if (global.document.visibilityState === 'visible') {
                void handlePendingPaymentOnResume();
            }
        });
        global.addEventListener('pageshow', () => {
            void handlePendingPaymentOnResume();
        });
    }

    global.DaSubscription = {
        init,
        refreshMe,
        updateHeaderPills,
        openPaywall,
        getStoredReferralCode,
        pillLabel,
        needsActivationGate,
        showActivationGate,
        blocksMainScreen,
        syncAccessGate,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);