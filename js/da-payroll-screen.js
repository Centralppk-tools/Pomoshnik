/**
 * Экран «Зарплата» — расчётный листок за месяц.
 */
(function (global) {
    'use strict';

    let payrollScreenMonth = null;
    let payrollScreenBound = false;

    function money(n) {
        const v = Math.round(Number(n) || 0);
        return `${v.toLocaleString('ru-RU')} ₽`;
    }

    function moneyDeduction(n) {
        const v = Math.round(Number(n) || 0);
        if (!(v > 0)) return '0 ₽';
        return `−${v.toLocaleString('ru-RU')} ₽`;
    }

    function rowHtml(label, value, opts) {
        const o = typeof opts === 'string' ? { note: opts } : (opts || {});
        const amount = o.deduction ? moneyDeduction(value) : money(value);
        return `<div class="payroll-line"><span class="payroll-line__label">${label}</span><span class="payroll-line__value">${amount}</span></div>`;
    }

    function formatPayrollDayLabel(day, monthIndex) {
        const mm = String((monthIndex % 12) + 1).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${dd}.${mm}`;
    }

    const MONTH_HINT = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

    function paymentCardLabels(year, monthIndex) {
        const advance = `Аванс ${formatPayrollDayLabel(27, monthIndex)}`;
        const settleMonth = monthIndex >= 11 ? 0 : monthIndex + 1;
        const salary = `Зарплата ${formatPayrollDayLabel(12, settleMonth)}`;
        return {
            advance,
            advanceHint: `в ${MONTH_HINT[monthIndex]}`,
            salary,
            salaryHint: `в ${MONTH_HINT[settleMonth]}`
        };
    }

    function renderPayrollCards(d, year, monthIndex) {
        const pay = paymentCardLabels(year, monthIndex);
        return `
        <div class="payroll-cards">
          <div class="payroll-card payroll-card--primary">
            <span class="payroll-card__label">На руки за месяц</span>
            <span class="payroll-card__value" id="payrollCardNet">${money(d.netPay)}</span>
          </div>
          <div class="payroll-card">
            <span class="payroll-card__label">${pay.advance}</span>
            <span class="payroll-card__value">${money(d.advanceNet)}</span>
            <span class="payroll-card__sub">${pay.advanceHint}</span>
          </div>
          <div class="payroll-card">
            <span class="payroll-card__label">${pay.salary}</span>
            <span class="payroll-card__value">${money(d.settlement)}</span>
            <span class="payroll-card__sub">${pay.salaryHint}</span>
          </div>
          <div class="payroll-card payroll-card--stat">
            <span class="payroll-card__label">Отработано</span>
            <span class="payroll-card__value">${d.workHours.toFixed(1)} ч</span>
            <span class="payroll-card__sub">норма ${d.effectiveNormHours} ч</span>
          </div>
          <div class="payroll-card payroll-card--stat">
            <span class="payroll-card__label">Смен</span>
            <span class="payroll-card__value">${d.shiftCount}</span>
            <span class="payroll-card__sub">ночных ${d.nightHours.toFixed(1)} ч</span>
          </div>
        </div>`;
    }

    function renderBreakdown(d) {
        const a = d.accruals || {};
        const percentSum =
            (a.premium || 0) + (a.regional || 0) + (a.harm || 0) + (a.qualification || 0) + (a.rights || 0);

        const detailLines = [
            ['Премия', a.premium],
            ['Региональная', a.regional],
            ['Вредность', a.harm],
            ['Классность', a.qualification],
            ['Права', a.rights],
            ['Ночные (+40%)', a.night],
            ['Праздничные / выходные', a.holiday],
            ['Кормовые', a.meals],
            ['Интенсивность МЦД', a.intensity],
            ['Сверхурочные (квартал)', a.overtime],
            ['Больничный (работодатель)', a.sickEmployer],
            ['По среднему', a.averagePay]
        ].filter(([, v]) => Number(v) > 0);

        const ded = d.deductions || {};
        const ndflLabel = ded.ndflNote ? `НДФЛ (${ded.ndflNote})` : 'НДФЛ';
        const dedRows = [
            [ndflLabel, ded.ndfl],
            ['Профсоюз (1%)', ded.union],
            ['Алименты', ded.alimony]
        ].filter(([, v]) => Number(v) > 0);

        let accHtml = '';
        if (Number(a.tariff) > 0 || detailLines.length) {
            const rows = [];
            if (Number(a.tariff) > 0) rows.push(rowHtml('Тариф (ЧТС)', a.tariff));
            if (percentSum > 0) rows.push(rowHtml('Надбавки к тарифу', percentSum));
            const detailInner = detailLines.map(([l, v]) => rowHtml(l, v)).join('');
            const foldHtml = detailLines.length
                ? `<details class="payroll-accrual-fold">
                <summary class="payroll-accrual-fold__summary">
                    <span class="payroll-accrual-fold__summary-text">Детализация начислений</span>
                    <span class="payroll-accrual-fold__chev" aria-hidden="true"></span>
                </summary>
                <div class="payroll-lines payroll-lines--nested">${detailInner}</div>
               </details>`
                : '';
            accHtml = `
            <div class="payroll-block">
              <h3 class="payroll-block__title">Начисления</h3>
              <div class="payroll-lines">
                ${rows.join('')}
                ${foldHtml}
              </div>
            </div>`;
        }

        const dedHtml = dedRows.length
            ? `<div class="payroll-block"><h3 class="payroll-block__title">Удержания</h3><div class="payroll-lines">${dedRows.map(([l, v]) => rowHtml(l, v, { deduction: true })).join('')}</div></div>`
            : '';

        let refHtml = '';
        if (d.reference?.sfrSick > 0) {
            refHtml += `<aside class="payroll-ref payroll-ref--sfr">Выплата от СФР (больничный, с 4-го дня): ${money(d.reference.sfrSick)}</aside>`;
        }
        if (d.reference?.vacationPay > 0) {
            refHtml += `<aside class="payroll-ref payroll-ref--vac">Отпускные (справочно): ${money(d.reference.vacationPay)}</aside>`;
        }

        return `${accHtml}${dedHtml}${refHtml ? `<div class="payroll-refs">${refHtml}</div>` : ''}`;
    }

    function ensurePayrollScreenMonth(date) {
        payrollScreenMonth = payrollScreenMonth || new Date(date.getFullYear(), date.getMonth(), 1);
    }

    function renderPayrollScreen() {
        const root = document.getElementById('payrollScreenBody');
        const label = document.getElementById('payrollScreenMonthLabel');
        if (!root) return;

        const picked = typeof global.getProfileSelectedMonthDate === 'function'
            ? global.getProfileSelectedMonthDate()
            : null;
        const src = picked || payrollScreenMonth || new Date();
        const year = src.getFullYear();
        const month = src.getMonth();

        if (label) {
            const names = (typeof global.getCalendarMonthsRu === 'function' && global.getCalendarMonthsRu())
                || ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
            label.textContent = `${names[month]} ${year}`;
        }

        const detail = typeof global.computeProfilePayrollDetailed === 'function'
            ? global.computeProfilePayrollDetailed(year, month)
            : null;

        if (!detail) {
            root.innerHTML = '<p class="payroll-empty">Нет данных для расчёта. Откройте календарь и профиль.</p>';
            return;
        }

        root.innerHTML = `<div class="payroll-sheet">${renderPayrollCards(detail, year, month)}${renderBreakdown(detail)}</div>`;

        const hooks = typeof global.getPayrollProfileUiHooks === 'function'
            ? global.getPayrollProfileUiHooks()
            : null;
        global.DaPayrollProfileUi?.refreshLivePreviewFromStored?.(hooks);
    }

    function bindPayrollScreen() {
        if (payrollScreenBound) return;
        payrollScreenBound = true;
        document.getElementById('payrollScreenPrev')?.addEventListener('click', () => {
            ensurePayrollScreenMonth(payrollScreenMonth || new Date());
            payrollScreenMonth.setMonth(payrollScreenMonth.getMonth() - 1);
            renderPayrollScreen();
        });
        document.getElementById('payrollScreenNext')?.addEventListener('click', () => {
            ensurePayrollScreenMonth(payrollScreenMonth || new Date());
            payrollScreenMonth.setMonth(payrollScreenMonth.getMonth() + 1);
            renderPayrollScreen();
        });
        document.getElementById('payrollScreenBack')?.addEventListener('click', () => {
            if (typeof global.switchMainScreenAnimated === 'function') {
                global.switchMainScreenAnimated('profile');
            }
        });
    }

    function openPayrollScreen() {
        bindPayrollScreen();
        const picked = typeof global.getProfileSelectedMonthDate === 'function'
            ? global.getProfileSelectedMonthDate()
            : null;
        if (picked) {
            payrollScreenMonth = new Date(picked.getFullYear(), picked.getMonth(), 1);
        }
        if (typeof global.switchMainScreenAnimated === 'function') {
            global.switchMainScreenAnimated('payroll');
        } else if (typeof global.switchMainScreen === 'function') {
            global.switchMainScreen('payroll', { animate: true, direction: 'forward' });
        }
        renderPayrollScreen();
    }

    global.DaPayrollScreen = {
        open: openPayrollScreen,
        render: renderPayrollScreen
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);