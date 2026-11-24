/**
 * Правила расчёта ЗП — синхронизировать с Human/расчет-зп/исходная-таблица-зп.html (#payroll-rules).
 */
(function (global) {
    const PAYROLL_RULES = {
        version: '2026-03-24',
        source: 'Human/расчет-зп/исходная-таблица-зп.html',
        roles: {
            machinist: {
                id: 'machinist',
                label: 'Машинист электропоезда',
                chts: 426.86,
                premium: 0.84,
                rightsLabel: 'Права на другой вид тяги',
                qualificationClasses: { 1: 0.2, 2: 0.1, 3: 0.05, 4: 0 }
            },
            assistant: {
                id: 'assistant',
                label: 'Помощник машиниста',
                chts: 332.67,
                premium: 0.7,
                rightsLabel: 'Права управления',
                qualificationClasses: null
            }
        },
        common: {
            regional: 0.5,
            harm: 0.04,
            extraRightEach: 0.05,
            extraRightMax: 3,
            nightPremium: 0.4,
            nightWindow: { from: '22:00', to: '06:00' },
            holidayPremium: 1.0,
            mealPerShift: 406,
            mcdIntensityPerShift: 800,
            overtimeFirstTwoHours: 0.5,
            overtimeAfter: 1.0,
            overtimeFirstTwoCapPerShift: 2,
            yearlyOvertimeHourCap: 120,
            unionFee: 0.01,
            ndflLow: 0.13,
            ndflHigh: 0.15,
            ndflHighThresholdYear: 2400000,
            advanceDayEnd: 15,
            sickEmployerDays: 3,
            sickExperienceRates: { under5: 0.6, from5to8: 0.8, over8: 1.0 },
            vacationDivisor: 29.3,
            odExtraHours: 4,
            alimonyRates: { none: 0, quarter: 0.25, third: 1 / 3, half: 0.5 }
        }
    };

    global.DaPayrollRules = PAYROLL_RULES;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PAYROLL_RULES;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);