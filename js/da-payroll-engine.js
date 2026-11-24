/**
 * Движок расчёта зарплаты (правила: DaPayrollRules, профиль: DaPayrollProfile).
 */
(function (global) {
    const rules = () => global.DaPayrollRules;
    const profileApi = () => global.DaPayrollProfile;

    function getRoleConfig(roleId) {
        const R = rules();
        if (!R) return null;
        if (roleId === 'assistant') return R.roles.assistant;
        return R.roles.machinist;
    }

    function normalizeRole(role) {
        const r = String(role || '').trim().toLowerCase();
        if (r === 'assistant' || r === 'помощник') return 'assistant';
        return 'machinist';
    }

    function classifyRoute(route) {
        const r = String(route || '').trim().toLowerCase();
        if (!r) return 'work';
        if (r === 'б' || r === 'бл' || r === 'больничный') return 'sick';
        if (r === 'о' || r === 'отп' || r === 'отпуск') return 'vacation';
        if (r === 'у' || r === 'учотпуск') return 'study_leave';
        if (r === 'дон') return 'donor';
        if (r === 'мед' || r === 'мк' || (r.includes('мед') && r.length <= 5)) return 'medical';
        if (r === 'ш') return 'study';
        if (r === 'з') return 'substitute';
        if (r === 'од') return 'od';
        if (r === 'я') return 'attendance';
        if (r === 'то' || (r.includes('то') && !r.startsWith('ут'))) return 'to';
        if (r === 'и' && r.length === 1) return 'briefing';
        if (r === 'в' || r === 'выходной') return 'rest_marker';
        return 'work';
    }

    function isDayRoute(route, presetKind) {
        const r = String(route || '').trim().toLowerCase();
        if (r === 'д' || /^д\d/.test(r)) return true;
        return String(presetKind || '').toLowerCase() === 'day';
    }

    function effectivePremiumRate(roleConfig, profile) {
        const base = Number(roleConfig?.premium) || 0;
        const cut = Math.max(0, Math.min(100, Number(profile?.premiumDeprivationPct) || 0)) / 100;
        return Math.max(0, base * (1 - cut));
    }

    function percentAddonsOnBase(baseAmount, roleId, roleConfig, profile) {
        const C = rules().common;
        const premium = baseAmount * effectivePremiumRate(roleConfig, profile);
        const regional = baseAmount * (C.regional || 0);
        const harm = baseAmount * (C.harm || 0);
        let qual = 0;
        if (roleId === 'machinist' && roleConfig.qualificationClasses) {
            const cl = profile?.qualificationClass ?? 4;
            const pct = roleConfig.qualificationClasses[cl];
            if (pct > 0) qual = baseAmount * pct;
        }
        const rightsN = Math.min(C.extraRightMax || 3, Math.max(0, profile?.extraRightsCount || 0));
        const rights = baseAmount * (C.extraRightEach || 0) * rightsN;
        return { premium, regional, harm, qualification: qual, rights, total: premium + regional + harm + qual + rights };
    }

    function getAverageMonthlyEarnings(profile) {
        const p = profile || {};
        const daily = profileApi()?.getTwoYearAverageDaily?.(p) || 0;
        const C = rules()?.common || {};
        if (daily > 0) return daily * (C.vacationDivisor || 29.3);
        const sum = Number(p.incomeYearPrev2) + Number(p.incomeYearPrev1);
        return sum > 0 ? sum / 24 : 0;
    }

    function getAverageDailyVacation(profile) {
        const C = rules()?.common || {};
        const monthly = getAverageMonthlyEarnings(profile);
        return monthly > 0 ? monthly / (C.vacationDivisor || 29.3) : 0;
    }

    function absenceNormHours(kind, scheduled) {
        const h = scheduled > 0 ? scheduled : 8;
        if (['sick', 'vacation', 'study_leave', 'donor', 'medical', 'study', 'substitute'].includes(kind)) return h;
        if (kind === 'od') return 0;
        if (kind === 'attendance' || kind === 'briefing') return Math.min(h, kind === 'attendance' ? 2 : h);
        return 0;
    }

    function computeShiftAccrual(input) {
        const R = rules();
        if (!R) return { total: 0, components: { kind: 'unknown' } };
        const roleId = normalizeRole(input.role);
        const roleConfig = getRoleConfig(roleId);
        const profile = input.profile || profileApi()?.loadPayrollProfile?.() || {};
        const C = R.common;
        const chts = roleConfig.chts;
        const kind = input.routeKind || classifyRoute(input.route);
        const workHours = Math.max(0, Number(input.workHours) || 0);
        const nightHours = Math.min(workHours, Math.max(0, Number(input.nightHours) || 0));
        const holidayH = Math.max(0, Number(input.holidayExtraHours) || 0);

        if (kind === 'sick' || kind === 'rest_marker') {
            return { total: 0, components: { kind, baseBare: 0, normDelta: absenceNormHours(kind, workHours) } };
        }

        const hourly = Number(input.averageHourly) || 0;
        const vacDaily = getAverageDailyVacation(profile);

        if (kind === 'vacation' || kind === 'study_leave') {
            const days = workHours > 0 ? workHours / 8 : 1;
            const ref = Math.round(vacDaily * days);
            return { total: 0, components: { kind, vacationRef: ref, normDelta: absenceNormHours(kind, workHours) } };
        }

        if (kind === 'donor' || kind === 'medical' || kind === 'study' || kind === 'substitute' || kind === 'od') {
            let hours = workHours;
            if (kind === 'od') hours = C.odExtraHours || 4;
            const total = hourly > 0 ? hourly * hours : 0;
            return {
                total: Math.round(total),
                components: {
                    kind,
                    averageHourly: hourly,
                    hours,
                    tariff: kind === 'od' ? 0 : total,
                    normDelta: kind === 'substitute' ? 0 : absenceNormHours(kind, hours)
                }
            };
        }

        if (kind === 'briefing' || kind === 'attendance') {
            const capHours = kind === 'attendance' ? Math.min(workHours, 2) : workHours;
            const base = capHours * chts;
            return { total: Math.round(base), components: { kind, tariff: base, baseBare: base } };
        }

        if (kind === 'to') {
            const base = workHours * chts;
            return { total: Math.round(base), components: { kind, tariff: base, baseBare: base } };
        }

        const baseBare = workHours * chts;
        const holidayExtra = holidayH > 0 ? holidayH * chts * (C.holidayPremium || 1) : 0;
        const nightExtra = nightHours * chts * (C.nightPremium || 0.4);
        const percents = percentAddonsOnBase(baseBare, roleId, roleConfig, profile);
        let meals = 0;
        let intensity = 0;
        if (input.isWorkShift !== false && workHours > 0) {
            meals = C.mealPerShift || 0;
            if (input.mcdIntensity) intensity = C.mcdIntensityPerShift || 0;
        }
        const subtotal = baseBare + holidayExtra + nightExtra + percents.total + meals + intensity;
        const advanceEligible = subtotal - percents.premium;

        return {
            total: Math.round(subtotal),
            components: {
                kind: 'work',
                baseBare,
                tariff: baseBare,
                holidayExtra,
                nightExtra,
                meals,
                intensity,
                mcdIntensity: Boolean(input.mcdIntensity),
                percents,
                advanceEligible
            }
        };
    }

    function computeShiftTotal(input) {
        return computeShiftAccrual(input).total;
    }

    function netAfterPayrollDeductions(gross, profile, C) {
        const rulesCommon = C || rules()?.common || {};
        const p = profile || {};
        const ndfl = rulesCommon.ndflLow ?? 0.13;
        let net = gross * (1 - ndfl);
        if (p.unionMember) net *= (1 - (rulesCommon.unionFee || 0));
        const alimonyRate = rulesCommon.alimonyRates?.[p.alimony] || 0;
        if (alimonyRate > 0) net *= (1 - alimonyRate);
        return net;
    }

    function grossHourlyTariff(roleId, profile) {
        const roleConfig = getRoleConfig(roleId);
        const C = rules()?.common || {};
        const chts = roleConfig.chts;
        const premium = effectivePremiumRate(roleConfig, profile);
        const regional = C.regional || 0;
        const harm = C.harm || 0;
        let classPct = 0;
        if (roleId === 'machinist' && roleConfig.qualificationClasses) {
            const cl = profile?.qualificationClass ?? 4;
            classPct = roleConfig.qualificationClasses[cl] || 0;
        }
        const rightsN = Math.min(C.extraRightMax || 3, Math.max(0, profile?.extraRightsCount || 0));
        const rightsPct = (C.extraRightEach || 0) * rightsN;
        return chts * (1 + premium + regional + harm + classPct + rightsPct);
    }

    function benchmarkWorkShiftInput(roleId, profile, workHours, opts) {
        const o = opts || {};
        return {
            role: roleId,
            profile: profile || {},
            route: 'д1',
            routeKind: 'work',
            workHours: Math.max(0, Number(workHours) || 0),
            nightHours: 0,
            holidayExtraHours: 0,
            isWorkShift: true,
            mcdIntensity: Boolean(o.mcdIntensity),
            averageHourly: 0,
            dayOfMonth: 15
        };
    }

    /** Нетто ₽/ч и ориентир за 12 ч (эталон через computeShiftAccrual + удержания). */
    function computeLiveNetPreview(profile, roleId) {
        const R = rules();
        if (!R) return null;
        const role = getRoleConfig(roleId);
        const C = R.common;
        const p = profile || {};
        const accr1 = computeShiftAccrual(benchmarkWorkShiftInput(roleId, p, 1));
        const grossHour = Math.max(0, (Number(accr1.total) || 0) - (accr1.components?.meals || 0));
        const netHour = netAfterPayrollDeductions(grossHour, p, C);
        const accr12 = computeShiftAccrual(benchmarkWorkShiftInput(roleId, p, 12, {
            mcdIntensity: Boolean(p.mcdIntensityDefault)
        }));
        const netShift12 = netAfterPayrollDeductions(Number(accr12.total) || 0, p, C);
        return {
            roleLabel: role.label,
            netHour,
            netShift12
        };
    }

    function progressiveNdfl(amount, ytdBefore) {
        const C = rules()?.common;
        if (!C || !(amount > 0)) return { tax: 0, note: '' };
        const threshold = C.ndflHighThresholdYear || 2400000;
        const ytd = Math.max(0, Number(ytdBefore) || 0);
        const lowRate = C.ndflLow ?? 0.13;
        const highRate = C.ndflHigh ?? 0.15;
        if (ytd >= threshold) return { tax: amount * highRate, note: '15%' };
        const room = threshold - ytd;
        if (amount <= room) return { tax: amount * lowRate, note: '13%' };
        return {
            tax: room * lowRate + (amount - room) * highRate,
            note: '13%/15%'
        };
    }

    function parseDateKeyParts(dateKey) {
        const p = String(dateKey || '').split('.');
        if (p.length !== 3) return null;
        return { day: parseInt(p[0], 10), month: parseInt(p[1], 10), year: parseInt(p[2], 10) };
    }

    function compareDateKeys(a, b) {
        const pa = parseDateKeyParts(a);
        const pb = parseDateKeyParts(b);
        if (!pa || !pb) return 0;
        const ta = new Date(pa.year, pa.month - 1, pa.day).getTime();
        const tb = new Date(pb.year, pb.month - 1, pb.day).getTime();
        return ta - tb;
    }

    function collectSickEmployerPay(sickDates, profile, sickRate, avgDaily) {
        if (!sickDates.length || !(avgDaily > 0)) return { employer: 0, sfr: 0 };
        const sorted = sickDates.slice().sort(compareDateKeys);
        let employerDays = 0;
        let sfrDays = 0;
        let i = 0;
        const C = rules()?.common || {};
        const capEmployer = C.sickEmployerDays || 3;
        while (i < sorted.length) {
            let spell = 1;
            while (i + spell < sorted.length) {
                const a = parseDateKeyParts(sorted[i + spell - 1]);
                const b = parseDateKeyParts(sorted[i + spell]);
                if (!a || !b) break;
                const d1 = new Date(a.year, a.month - 1, a.day);
                const d2 = new Date(b.year, b.month - 1, b.day);
                if ((d2 - d1) / 86400000 === 1) spell += 1;
                else break;
            }
            employerDays += Math.min(capEmployer, spell);
            sfrDays += Math.max(0, spell - capEmployer);
            i += spell;
        }
        const daily = avgDaily * sickRate;
        return {
            employer: Math.round(daily * employerDays),
            sfr: Math.round(daily * sfrDays)
        };
    }

    function computeQuarterOvertimePay(opts) {
        const C = rules()?.common || {};
        const roleId = normalizeRole(opts.role);
        const chts = getRoleConfig(roleId).chts;
        const fact = Number(opts.quarterFactHours) || 0;
        const norm = Number(opts.quarterNormHours) || 0;
        const excess = Math.max(0, fact - norm);
        if (!(excess > 0)) return { pay: 0, hours: 0 };

        const capLeft = Math.max(0, (C.yearlyOvertimeHourCap || 120) - (Number(opts.yearOtBefore) || 0));
        let toPay = Math.min(excess, capLeft);
        const workShifts = (opts.quarterWorkShifts || []).slice().sort((a, b) => compareDateKeys(a.dateKey, b.dateKey));
        let pay = 0;
        let counted = 0;
        for (let si = 0; si < workShifts.length && toPay > 0; si += 1) {
            const wh = Math.max(0, Number(workShifts[si].workHours) || 0);
            if (wh <= 0) continue;
            const chunk = Math.min(wh, toPay);
            const first = Math.min(C.overtimeFirstTwoCapPerShift || 2, chunk);
            const rest = Math.max(0, chunk - first);
            pay += first * chts * (C.overtimeFirstTwoHours || 0.5) + rest * chts * (C.overtimeAfter || 1);
            counted += chunk;
            toPay -= chunk;
        }
        return { pay: Math.round(pay), hours: counted };
    }

  function mergeAccrualBucket(bucket, accr) {
        const c = accr.components || {};
        if (c.kind === 'vacation' || c.kind === 'study_leave') {
            bucket.vacationRef += c.vacationRef || 0;
            return;
        }
        if (c.percents) {
            bucket.premium += c.percents.premium || 0;
            bucket.regional += c.percents.regional || 0;
            bucket.harm += c.percents.harm || 0;
            bucket.qualification += c.percents.qualification || 0;
            bucket.rights += c.percents.rights || 0;
        }
        bucket.tariff += c.tariff || c.baseBare || 0;
        bucket.night += c.nightExtra || 0;
        bucket.holiday += c.holidayExtra || 0;
        bucket.meals += c.meals || 0;
        bucket.intensity += c.intensity || 0;
        if (c.kind === 'od' || c.kind === 'substitute' || c.kind === 'donor' || c.kind === 'medical' || c.kind === 'study') {
            bucket.averagePay += accr.total || 0;
        }
    }

  function computePayrollMonthDetailed(monthInput) {
        const R = rules();
        const profile = monthInput.profile || profileApi()?.loadPayrollProfile?.() || {};
        const roleId = normalizeRole(monthInput.role);
        const C = R.common;
        const accruals = {
            tariff: 0, night: 0, premium: 0, regional: 0, harm: 0, qualification: 0, rights: 0,
            holiday: 0, meals: 0, intensity: 0, overtime: 0, sickEmployer: 0, averagePay: 0
        };
        let gross = 0;
        let advanceBase = 0;
        let workHours = 0;
        let nightHours = 0;
        let shiftCount = 0;
        let normReduction = 0;
        const sickDates = [];
        let vacationRef = 0;

        const avgDaily = profileApi()?.getTwoYearAverageDaily?.(profile) || 0;
        const sickRate = profileApi()?.getSickLeaveExperienceRate?.(profile) || 1;

        (monthInput.days || []).forEach((day) => {
            const parts = parseDateKeyParts(day.dateKey);
            const dayNum = parts?.day || 0;
            const h = day.hooks || {};
            (day.shifts || []).forEach((shift) => {
                if (shift?.isVirtualMorning) return;
                const enriched = typeof h.enrichShift === 'function' ? h.enrichShift(shift, day.dateKey) : shift;
                const route = enriched?.route || enriched?.name || '';
                const kind = classifyRoute(route);
                if (h.isAveragePay?.(enriched)) {
                    const amt = Number(h.getAveragePayAmount?.(day.dateKey)) || 0;
                    gross += amt;
                    accruals.averagePay += amt;
                    shiftCount += 1;
                    if (dayNum <= C.advanceDayEnd) advanceBase += amt;
                    return;
                }
                const workH = Number(h.getWorkHours?.(enriched, day.dateKey)) || 0;
                const nightH = Number(h.getNightHours?.(enriched, day.dateKey)) || 0;
                let holidayH = 0;
                if (kind === 'work' && !h.shiftSkipsRed?.(enriched)) {
                    if (typeof h.getHolidayExtraHours === 'function') {
                        holidayH = Number(h.getHolidayExtraHours(enriched, day.dateKey)) || 0;
                    } else if (h.isRedDay?.(day.dateKey)) {
                        holidayH = workH;
                    }
                }

                if (kind === 'sick') sickDates.push(day.dateKey);

                const mcd = typeof h.getMcdIntensity === 'function'
                    ? Boolean(h.getMcdIntensity(enriched, day.dateKey))
                    : enriched.mcdIntensity === true;
                const accr = computeShiftAccrual({
                    role: roleId,
                    profile,
                    route,
                    routeKind: kind,
                    workHours: workH,
                    nightHours: nightH,
                    holidayExtraHours: holidayH,
                    isWorkShift: kind === 'work',
                    mcdIntensity: mcd,
                    averageHourly: h.getAverageHourly?.() || 0,
                    dayOfMonth: dayNum
                });

                if (accr.components?.normDelta) normReduction += accr.components.normDelta;
                if (kind === 'work' && workH > 0) shiftCount += 1;
                if (kind === 'work') {
                    workHours += workH;
                    nightHours += nightH;
                }
                if (accr.total > 0) gross += accr.total;
                mergeAccrualBucket(accruals, accr);
                if (accr.components?.vacationRef) vacationRef += accr.components.vacationRef;

                const adv = accr.components?.advanceEligible;
                if (dayNum <= C.advanceDayEnd) {
                    advanceBase += adv != null ? adv : accr.total - (accr.components?.percents?.premium || 0);
                }
            });
        });

        const sickPay = collectSickEmployerPay(sickDates, profile, sickRate, avgDaily);
        accruals.sickEmployer = sickPay.employer;
        gross += sickPay.employer;

        const monthIndex = Number(monthInput.monthIndex) || 0;
        const isQuarterEnd = [2, 5, 8, 11].includes(monthIndex);
        if (isQuarterEnd && typeof monthInput.getQuarterStats === 'function') {
            const qs = monthInput.getQuarterStats();
            const ot = computeQuarterOvertimePay({
                role: roleId,
                quarterFactHours: qs.factHours,
                quarterNormHours: qs.normHours,
                quarterWorkShifts: qs.workShifts,
                yearOtBefore: Number(monthInput.yearOtBefore) || 0
            });
            accruals.overtime = ot.pay;
            gross += ot.pay;
        }

        gross = Math.round(gross);
        const normHours = Number(monthInput.normHours) || 0;
        const effectiveNormHours = Math.max(0, Math.round((normHours - normReduction) * 10) / 10);

        const ytdBefore = Number(monthInput.ytdIncomeBeforeMonth) || profile.ytdIncome || 0;
        const advanceNdfl = progressiveNdfl(advanceBase, ytdBefore);
        const advanceNet = Math.max(0, Math.round(advanceBase - advanceNdfl.tax));
        const ndflMain = progressiveNdfl(gross, ytdBefore);
        const union = profile.unionMember ? gross * (C.unionFee || 0) : 0;
        const afterTax = gross - ndflMain.tax - union;
        const alimonyRate = C.alimonyRates?.[profile.alimony] || 0;
        const alimony = alimonyRate > 0 ? afterTax * alimonyRate : 0;
        const netPay = Math.max(0, Math.round(afterTax - alimony));
        const settlement = Math.max(0, netPay - advanceNet);

        Object.keys(accruals).forEach((k) => { accruals[k] = Math.round(accruals[k]); });

        return {
            gross,
            advanceGross: Math.round(advanceBase),
            advanceNdfl: Math.round(advanceNdfl.tax),
            advanceNet,
            monthNdfl: Math.round(ndflMain.tax),
            union: Math.round(union),
            alimony: Math.round(alimony),
            netPay,
            settlement,
            workHours,
            nightHours,
            shiftCount,
            normHours,
            effectiveNormHours,
            accruals,
            deductions: {
                ndfl: Math.round(ndflMain.tax),
                ndflNote: ndflMain.note,
                union: Math.round(union),
                alimony: Math.round(alimony)
            },
            reference: {
                sfrSick: sickPay.sfr,
                vacationPay: Math.round(vacationRef)
            }
        };
    }

    function computeMonthPayroll(monthInput) {
        const d = computePayrollMonthDetailed(monthInput);
        return {
            gross: d.gross,
            advanceGross: d.advanceGross,
            advanceNdfl: d.advanceNdfl,
            advanceNet: d.advanceNet,
            monthNdfl: d.monthNdfl,
            union: d.union,
            alimony: d.alimony,
            netPay: d.netPay,
            settlement: d.settlement,
            vacationPay: d.reference.vacationPay,
            sfrSickRef: d.reference.sfrSick,
            workHours: d.workHours
        };
    }

    global.DaPayrollEngine = {
        classifyRoute,
        computeShiftAccrual,
        computeShiftTotal,
        computeMonthPayroll,
        computePayrollMonthDetailed,
        getRoleConfig,
        normalizeRole,
        progressiveNdfl,
        effectivePremiumRate,
        computeLiveNetPreview,
        netAfterPayrollDeductions,
        grossHourlyTariff
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.DaPayrollEngine;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);