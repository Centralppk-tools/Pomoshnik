/**
 * Настройки профиля для расчёта зарплаты (localStorage).
 */
(function (global) {
    const STORAGE_KEY = 'da_payroll_profile_v1';

    const DEFAULTS = {
        qualificationClass: 1,
        extraRightsCount: 0,
        mcdIntensityDefault: false,
        unionMember: false,
        insuranceYearsBand: 'over8',
        incomeYearPrev2: 0,
        incomeYearPrev1: 0,
        averageDailyIncome: 0,
        alimony: 'none',
        premiumDeprivationPct: 0,
        ytdIncome: 0
    };

    function storageKey() {
        const syncId = typeof global.getOrCreateSyncUserId === 'function'
            ? global.getOrCreateSyncUserId()
            : 'local';
        return `${STORAGE_KEY}:${syncId}`;
    }

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function normalizeProfile(raw) {
        const p = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        p.qualificationClass = clamp(parseInt(p.qualificationClass, 10) || 4, 1, 4);
        p.extraRightsCount = clamp(parseInt(p.extraRightsCount, 10) || 0, 0, 3);
        p.mcdIntensityDefault = Boolean(p.mcdIntensityDefault);
        p.unionMember = Boolean(p.unionMember);
        if (!['under5', 'from5to8', 'over8'].includes(p.insuranceYearsBand)) {
            p.insuranceYearsBand = 'over8';
        }
        p.incomeYearPrev2 = Math.max(0, Number(p.incomeYearPrev2) || 0);
        p.incomeYearPrev1 = Math.max(0, Number(p.incomeYearPrev1) || 0);
        p.averageDailyIncome = Math.max(0, Number(p.averageDailyIncome) || 0);
        if (!['none', 'quarter', 'third', 'half'].includes(p.alimony)) {
            p.alimony = 'none';
        }
        p.premiumDeprivationPct = clamp(Number(p.premiumDeprivationPct) || 0, 0, 100);
        p.ytdIncome = Math.max(0, Number(p.ytdIncome) || 0);
        return p;
    }

    let profileMemoryCache = null;
    let profileMemoryCacheKey = '';

    function loadPayrollProfile() {
        const key = storageKey();
        if (profileMemoryCache && profileMemoryCacheKey === key) {
            return profileMemoryCache;
        }
        try {
            const raw = localStorage.getItem(key);
            profileMemoryCache = normalizeProfile(raw ? JSON.parse(raw) : null);
            profileMemoryCacheKey = key;
            return profileMemoryCache;
        } catch (_) {
            profileMemoryCache = normalizeProfile(null);
            profileMemoryCacheKey = key;
            return profileMemoryCache;
        }
    }

    function invalidatePayrollProfileCache() {
        profileMemoryCache = null;
        profileMemoryCacheKey = '';
    }

    function savePayrollProfile(patch) {
        const next = normalizeProfile({ ...loadPayrollProfile(), ...(patch || {}) });
        try {
            localStorage.setItem(storageKey(), JSON.stringify(next));
        } catch (_) { /* quota */ }
        profileMemoryCache = next;
        profileMemoryCacheKey = storageKey();
        return next;
    }

    function getSickLeaveExperienceRate(profile) {
        const band = (profile || loadPayrollProfile()).insuranceYearsBand;
        const rates = global.DaPayrollRules?.common?.sickExperienceRates || {};
        if (band === 'under5') return rates.under5 ?? 0.6;
        if (band === 'from5to8') return rates.from5to8 ?? 0.8;
        return rates.over8 ?? 1;
    }

    function getTwoYearAverageDaily(profile) {
        const p = profile || loadPayrollProfile();
        const direct = Number(p.averageDailyIncome);
        if (direct > 0) return direct;
        const total = p.incomeYearPrev2 + p.incomeYearPrev1;
        if (!(total > 0)) return 0;
        return total / 730;
    }

    function exportPayrollSettingsForServer() {
        const p = loadPayrollProfile();
        return {
            v: 1,
            qualificationClass: p.qualificationClass,
            extraRightsCount: p.extraRightsCount,
            mcdIntensityDefault: p.mcdIntensityDefault,
            unionMember: p.unionMember,
            insuranceYearsBand: p.insuranceYearsBand,
            incomeYearPrev2: p.incomeYearPrev2,
            incomeYearPrev1: p.incomeYearPrev1,
            averageDailyIncome: p.averageDailyIncome,
            alimony: p.alimony,
            premiumDeprivationPct: p.premiumDeprivationPct,
            ytdIncome: p.ytdIncome
        };
    }

    function importPayrollSettingsFromServer(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const patch = { ...raw };
        delete patch.v;
        return savePayrollProfile(patch);
    }

    global.DaPayrollProfile = {
        STORAGE_KEY,
        DEFAULTS,
        loadPayrollProfile,
        savePayrollProfile,
        invalidatePayrollProfileCache,
        normalizeProfile,
        getSickLeaveExperienceRate,
        getTwoYearAverageDaily,
        exportPayrollSettingsForServer,
        importPayrollSettingsFromServer
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);