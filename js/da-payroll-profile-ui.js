/**
 * Интерактивный блок настроек ЗП в профиле (живой калькулятор ЧТС/ч).
 */
(function (global) {
    'use strict';

    const SEG_GROUPS = ['profilePayrollClassSeg', 'profilePayrollRightsSeg', 'profilePayrollInsuranceSeg', 'profilePayrollAlimonySeg'];

    function shortRoleLabel(roleLabel) {
        const s = String(roleLabel || '').trim();
        if (/помощник/i.test(s)) return 'Пом. Маш.';
        if (/машинист/i.test(s)) return 'Маш.';
        return s.split(/\s+/).slice(0, 2).join(' ') || s;
    }

    function fmtHour(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '—';
        return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽/ч`;
    }

    function fmtShift12(n) {
        const v = Math.round(Number(n) || 0);
        if (!(v > 0)) return '';
        return `~ ${v.toLocaleString('ru-RU')} ₽/12ч`;
    }

    function readSegValue(groupId) {
        const group = document.getElementById(groupId);
        if (!group) return null;
        const active = group.querySelector('.payroll-seg__btn.is-active');
        return active ? active.dataset.value : null;
    }

    function setSegValue(groupId, value) {
        const group = document.getElementById(groupId);
        if (!group) return;
        group.querySelectorAll('.payroll-seg__btn').forEach((btn) => {
            const on = String(btn.dataset.value) === String(value);
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function readSwitch(id) {
        const el = document.getElementById(id);
        return el ? Boolean(el.checked) : false;
    }

    function setSwitch(id, on) {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = Boolean(on);
        el.closest('.payroll-switch')?.classList.toggle('is-on', Boolean(on));
    }

    function readStateFromDom(hooks) {
        const isAsst = hooks.getIsAssistant?.() === true;
        const stored = global.DaPayrollProfile?.loadPayrollProfile?.() || {};
        return {
            qualificationClass: isAsst ? 4 : parseInt(readSegValue('profilePayrollClassSeg') || '4', 10),
            extraRightsCount: parseInt(readSegValue('profilePayrollRightsSeg') || '0', 10),
            mcdIntensityDefault: readSwitch('profilePayrollMcdDefault'),
            unionMember: readSwitch('profilePayrollUnion'),
            insuranceYearsBand: readSegValue('profilePayrollInsuranceSeg') || 'over8',
            averageDailyIncome: hooks.parseMoney?.(document.getElementById('profilePayrollAvgDaily')?.value) || 0,
            incomeYearPrev2: 0,
            incomeYearPrev1: 0,
            alimony: readSegValue('profilePayrollAlimonySeg') || 'none',
            premiumDeprivationPct: Number(document.getElementById('profilePayrollPremiumCut')?.value) || 0,
            ytdIncome: Number(stored.ytdIncome) || 0
        };
    }

    function computeLivePreview(state, isAssistant) {
        const roleId = isAssistant ? 'assistant' : 'machinist';
        return global.DaPayrollEngine?.computeLiveNetPreview?.(state, roleId) || null;
    }

    const LIVE_PREVIEW_TARGETS = [
        {
            meta: 'profilePayrollLiveMeta',
            net: 'profilePayrollLiveNet',
            shift: 'profilePayrollLiveShift'
        },
        {
            meta: 'payrollScreenLiveMeta',
            net: 'payrollScreenLiveNet',
            shift: 'payrollScreenLiveShift'
        }
    ];

    function paintLivePreview(preview) {
        if (!preview) return;
        const role = shortRoleLabel(preview.roleLabel);
        const hour = fmtHour(preview.netHour);
        const shift = fmtShift12(preview.netShift12);
        LIVE_PREVIEW_TARGETS.forEach((ids) => {
            const metaEl = document.getElementById(ids.meta);
            if (!metaEl) return;
            metaEl.textContent = role;
            const netEl = document.getElementById(ids.net);
            const shiftEl = document.getElementById(ids.shift);
            if (netEl) netEl.textContent = hour;
            if (shiftEl) shiftEl.textContent = shift;
        });
    }

    function renderLiveCard(preview, hooks) {
        if (!preview) return;
        paintLivePreview(preview);
        syncRoleVisibility(hooks);
    }

    function refreshLivePreviewFromStored(hooks) {
        const p = global.DaPayrollProfile?.loadPayrollProfile?.() || {};
        renderLiveCard(computeLivePreview(p, hooks?.getIsAssistant?.()), hooks);
    }

    function syncRoleVisibility(hooks) {
        const isAsst = hooks.getIsAssistant?.() === true;
        const classRow = document.getElementById('profilePayrollClassBlock');
        if (classRow) {
            classRow.hidden = isAsst;
            classRow.style.display = isAsst ? 'none' : '';
        }
        const rightsTitle = document.getElementById('profilePayrollRightsTitle');
        const rightsHint = document.getElementById('profilePayrollRightsHint');
        if (rightsTitle) {
            rightsTitle.textContent = isAsst ? 'Права управления' : 'Права на другой вид тяги';
        }
        if (rightsHint) {
            rightsHint.textContent = isAsst
                ? 'Выберите количество прав на управление'
                : 'Выберите количество прав на другой вид тяги';
        }
    }

    function persistAndRefresh(hooks) {
        const state = readStateFromDom(hooks);
        global.DaPayrollProfile?.savePayrollProfile?.(state);
        renderLiveCard(computeLivePreview(state, hooks.getIsAssistant?.()), hooks);
        if (typeof hooks.onAfterChange === 'function') hooks.onAfterChange();
        markPayrollSettingsUnsaved();
    }

    function setPayrollSaveStatus(text, tone) {
        const el = document.getElementById('profilePayrollSaveStatus');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('is-ok', 'is-warn', 'is-error');
        if (tone) el.classList.add(tone);
    }

    function markPayrollSettingsUnsaved() {
        const btn = document.getElementById('profilePayrollSaveBtn');
        if (btn?.dataset.state === 'saving') return;
        setPayrollSaveStatus('Изменения на устройстве — нажмите «Сохранить»', 'is-warn');
    }

    async function pushPayrollSettingsToServer(hooks) {
        const btn = document.getElementById('profilePayrollSaveBtn');
        const state = readStateFromDom(hooks);
        global.DaPayrollProfile?.savePayrollProfile?.(state);
        renderLiveCard(computeLivePreview(state, hooks.getIsAssistant?.()), hooks);
        if (typeof hooks.onAfterChange === 'function') hooks.onAfterChange();

        if (!global.DaCrewApi?.isEnabled?.()) {
            setPayrollSaveStatus('Синхронизация с сервером отключена', 'is-error');
            return;
        }
        if (!global.DaAuthSession?.getJwt?.()) {
            setPayrollSaveStatus('Войдите в аккаунт, чтобы сохранить на сервере', 'is-warn');
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.dataset.state = 'saving';
        }
        setPayrollSaveStatus('Отправляем на сервер…', '');

        try {
            const res = await global.DaCrewApi.flushProfileUpdate?.();
            if (res?.skipped) {
                setPayrollSaveStatus('Не удалось собрать профиль для отправки', 'is-error');
                return;
            }
            if (res?.payroll_settings === false) {
                setPayrollSaveStatus('Профиль сохранён, но сервер не принял настройки ЗП', 'is-warn');
            } else {
                setPayrollSaveStatus('Сохранено в профиле на сервере', 'is-ok');
            }
            if (typeof global.refreshPayrollScreenIfVisible === 'function') {
                global.refreshPayrollScreenIfVisible();
            }
        } catch (_) {
            setPayrollSaveStatus('Ошибка сохранения — попробуйте позже', 'is-error');
        } finally {
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.state;
            }
        }
    }

    function bindSegGroups(hooks) {
        SEG_GROUPS.forEach((id) => {
            const group = document.getElementById(id);
            if (!group || group.dataset.bound === '1') return;
            group.dataset.bound = '1';
            group.addEventListener('click', (e) => {
                const btn = e.target.closest('.payroll-seg__btn');
                if (!btn || !group.contains(btn)) return;
                e.preventDefault();
                e.stopPropagation();
                setSegValue(id, btn.dataset.value);
                persistAndRefresh(hooks);
            });
        });
    }

    function bindSwitches(hooks) {
        ['profilePayrollMcdDefault', 'profilePayrollUnion'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.dataset.bound === '1') return;
            el.dataset.bound = '1';
            el.addEventListener('click', (e) => e.stopPropagation());
            el.addEventListener('change', () => {
                setSwitch(id, el.checked);
                persistAndRefresh(hooks);
            });
        });
    }

    function bindInputs(hooks) {
        ['profilePayrollAvgDaily', 'profilePayrollPremiumCut'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.dataset.bound === '1') return;
            el.dataset.bound = '1';
            const fire = () => persistAndRefresh(hooks);
            el.addEventListener('change', fire);
            el.addEventListener('blur', fire);
            el.addEventListener('input', () => persistAndRefresh(hooks));
        });
    }

    function resolveAverageDailyDisplay(p) {
        if (p.averageDailyIncome > 0) return p.averageDailyIncome;
        const total = (p.incomeYearPrev2 || 0) + (p.incomeYearPrev1 || 0);
        if (total > 0) return total / 730;
        return 0;
    }

    function fillUiFromProfile(hooks) {
        const p = global.DaPayrollProfile?.loadPayrollProfile?.() || {};
        setSegValue('profilePayrollClassSeg', String(p.qualificationClass || 4));
        setSegValue('profilePayrollRightsSeg', String(p.extraRightsCount || 0));
        setSegValue('profilePayrollInsuranceSeg', p.insuranceYearsBand || 'over8');
        setSegValue('profilePayrollAlimonySeg', p.alimony || 'none');
        setSwitch('profilePayrollMcdDefault', p.mcdIntensityDefault);
        setSwitch('profilePayrollUnion', p.unionMember);
        const fmt = hooks.formatAvgSalaryInputDisplay || ((n) => String(n));
        const avg = document.getElementById('profilePayrollAvgDaily');
        const cut = document.getElementById('profilePayrollPremiumCut');
        const avgVal = resolveAverageDailyDisplay(p);
        if (avg) avg.value = avgVal > 0 ? fmt(Math.round(avgVal)) : '';
        if (cut) cut.value = p.premiumDeprivationPct > 0 ? String(p.premiumDeprivationPct) : '';

        syncRoleVisibility(hooks);
        renderLiveCard(computeLivePreview(p, hooks.getIsAssistant?.()), hooks);
    }

    let inited = false;

    function init(hooks) {
        if (!document.getElementById('profilePayrollLiveCard')) return;
        fillUiFromProfile(hooks);
        if (!inited) {
            inited = true;
            bindSegGroups(hooks);
            bindSwitches(hooks);
            bindInputs(hooks);
            const fold = document.getElementById('profilePayrollSettingsFold');
            const headBtn = document.getElementById('profilePayrollSettingsHead');
            const handleBtn = document.getElementById('profilePayrollSettingsHandle');

            const setPayrollFoldExpanded = (expanded) => {
                if (!fold) return;
                fold.classList.toggle('is-expanded', expanded);
                const aria = expanded ? 'true' : 'false';
                headBtn?.setAttribute('aria-expanded', aria);
                handleBtn?.setAttribute('aria-expanded', aria);
                if (handleBtn) {
                    handleBtn.setAttribute(
                        'aria-label',
                        expanded ? 'Свернуть настройки расчёта ЗП' : 'Развернуть настройки расчёта ЗП'
                    );
                }
            };

            const togglePayrollFold = () => {
                setPayrollFoldExpanded(!fold?.classList.contains('is-expanded'));
            };

            headBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!fold?.classList.contains('is-expanded')) togglePayrollFold();
            });

            handleBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                togglePayrollFold();
            });
            const sheetBtn = document.getElementById('profilePayrollOpenSheetBtn');
            sheetBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                global.DaPayrollScreen?.open?.();
            });
            const saveBtn = document.getElementById('profilePayrollSaveBtn');
            saveBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void pushPayrollSettingsToServer(hooks);
            });
        }
    }

    function refreshForRoleChange(hooks) {
        syncRoleVisibility(hooks);
        fillUiFromProfile(hooks);
    }

    global.DaPayrollProfileUi = {
        init,
        refreshForRoleChange,
        computeLivePreview,
        renderLiveCard,
        refreshLivePreviewFromStored,
        paintLivePreview
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);