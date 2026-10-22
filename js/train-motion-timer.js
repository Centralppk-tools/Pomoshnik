/**
 * Динамический отсчёт: шапка, подвал карточки маршрута, прогресс перегона.
 */
(function initTrainMotionTimer(global) {
    const MS_MIN = 60 * 1000;
    const MS_HOUR = 60 * MS_MIN;

    const SUB_ACCENT_CLASSES = ['ok', 'muted', 'warn', 'danger', 'dwell'];

    let deps = null;

    function pad2(n) {
        return String(Math.max(0, Math.floor(n))).padStart(2, '0');
    }

    function formatMmSs(totalMs) {
        const sec = Math.max(0, Math.ceil(totalMs / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${pad2(m)}:${pad2(s)}`;
    }

    function formatHourMinRu(totalMs) {
        const min = Math.max(0, Math.ceil(totalMs / MS_MIN));
        const h = Math.floor(min / 60);
        const m = min % 60;
        if (h <= 0) return `${m}м`;
        if (m <= 0) return `${h}ч`;
        return `${h}ч ${m}м`;
    }

    function shortStationLabel(title, maxLen = 9) {
        let text = String(title || '').trim();
        text = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return '—';
        const first = text.split(/[\s,–—-]/)[0] || text;
        const limit = Math.max(3, Number(maxLen) || 9);
        if (first.length <= limit) return first;
        return first.slice(0, limit);
    }

    function accentFromRemainingMs(remainingMs, overdue) {
        if (overdue) return 'danger';
        return 'muted';
    }

    function setBadge(el, text, accent) {
        if (!el) return;
        SUB_ACCENT_CLASSES.forEach((name) => {
            el.classList.remove(`clock-wrap__sub--${name}`);
        });
        if (!text) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = text;
        el.classList.add(`clock-wrap__sub--${accent || 'muted'}`);
    }

    function resolveActiveRouteTrain(nowDate, trains) {
        if (!nowDate || !Array.isArray(trains) || !trains.length || !deps) return null;

        let transit = null;
        let upcoming = null;
        let upcomingDiff = Infinity;

        for (const train of trains) {
            const phase = deps.resolveRouteTrainPhase(nowDate, train);
            if (phase === 'transit') {
                transit = { train, phase: 'transit' };
                break;
            }
            if (phase === 'green' || phase === 'yellow' || phase === 'red') {
                const depDt = deps.buildRouteEventDateTime(train.departureDate, train.departure);
                if (!depDt) continue;
                const diff = depDt.getTime() - nowDate.getTime();
                if (diff < upcomingDiff) {
                    upcomingDiff = diff;
                    upcoming = { train, phase: 'before', depDt };
                }
            }
        }

        if (transit) {
            const arrDt = deps.buildRouteEventDateTime(transit.train.arrivalDate, transit.train.arrival);
            return { ...transit, arrDt };
        }
        if (upcoming) return upcoming;
        return null;
    }

    function buildRouteHeaderBadge(nowDate, active) {
        if (!active) return null;
        if (active.phase === 'transit') {
            const arrDt = active.arrDt;
            if (!arrDt) return null;
            const rem = arrDt.getTime() - nowDate.getTime();
            const overdue = rem < 0;
            return {
                text: `В пути ${formatMmSs(Math.abs(rem))}`,
                accent: accentFromRemainingMs(rem, overdue),
            };
        }
        const depDt = active.depDt;
        if (!depDt) return null;
        const rem = depDt.getTime() - nowDate.getTime();
        const overdue = rem < 0;
        if (rem >= MS_HOUR) {
            return {
                text: `Отпр ${formatHourMinRu(rem)}`,
                accent: accentFromRemainingMs(rem, overdue),
            };
        }
        return {
            text: `Отпр ${formatMmSs(rem)}`,
            accent: accentFromRemainingMs(rem, overdue),
        };
    }

    function findPrevDepartureIndex(displayStops, nextIndex, selectedDate) {
        for (let i = nextIndex - 1; i >= 0; i--) {
            const win = deps.buildStopLiveWindow(displayStops, i, selectedDate);
            if (!win?.end) continue;
            return i;
        }
        return -1;
    }

    function analyzeScheduleMotion(displayStops, selectedDate, nowDate) {
        if (!deps || !displayStops?.length || !nowDate) return null;
        if (selectedDate && !deps.isScheduleContextActive(nowDate, selectedDate)) return null;

        const { currentIndex, nextIndex } = deps.findTimelineStationPhases(displayStops, selectedDate, nowDate);
        const nowMs = nowDate.getTime();

        if (currentIndex >= 0) {
            const win = deps.buildStopLiveWindow(displayStops, currentIndex, selectedDate);
            const arrStart = win?.start?.getTime() ?? win?.arrDt?.getTime();
            const depEnd = win?.end?.getTime();
            if (arrStart != null && depEnd != null && depEnd > arrStart) {
                const rem = depEnd - nowMs;
                const overdue = rem < 0;
                const elapsed = nowMs - arrStart;
                const total = depEnd - arrStart;
                const progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
                return {
                    mode: 'dwell',
                    targetIndex: currentIndex,
                    passedBefore: currentIndex,
                    progress,
                    badge: {
                        text: `Стоянка ${formatMmSs(Math.abs(rem))}`,
                        accent: overdue ? 'danger' : 'dwell',
                    },
                };
            }
        }

        if (nextIndex >= 0) {
            const prevIndex = findPrevDepartureIndex(displayStops, nextIndex, selectedDate);
            const prevWin = prevIndex >= 0
                ? deps.buildStopLiveWindow(displayStops, prevIndex, selectedDate)
                : deps.buildStopLiveWindow(displayStops, 0, selectedDate);
            const nextWin = deps.buildStopLiveWindow(displayStops, nextIndex, selectedDate);
            const legStart = prevWin?.end?.getTime() ?? prevWin?.start?.getTime() ?? prevWin?.arrDt?.getTime();
            const legEnd = nextWin?.arrDt?.getTime();
            if (legStart != null && legEnd != null && legEnd > legStart) {
                const rem = legEnd - nowMs;
                const overdue = rem < 0;
                const elapsed = nowMs - legStart;
                const total = legEnd - legStart;
                const progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
                const item = displayStops[nextIndex];
                const title = item?.referenceTitle || item?.threadStop?.station?.title || '';
                return {
                    mode: 'leg',
                    targetIndex: nextIndex,
                    passedBefore: nextIndex,
                    progress,
                    badge: {
                        text: `${shortStationLabel(title, 9)} ${formatMmSs(Math.abs(rem))}`,
                        accent: accentFromRemainingMs(rem, overdue),
                    },
                };
            }
        }

        return null;
    }

    function resetRouteCardLiveFooters() {
        document.querySelectorAll('.route-live-travel').forEach((el) => {
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-live-travel--active');
        });
        document.querySelectorAll('.route-live-turnaround').forEach((el) => {
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-live-turnaround--active');
        });
    }

    function updateRouteMotion(nowDate, context) {
        const badgeEl = document.getElementById('scheduleMotionBadge');

        if (!context.synced || context.tab !== 'tab-route' || !context.routeTrains?.length) {
            setBadge(badgeEl, '', 'muted');
            resetRouteCardLiveFooters();
            return;
        }

        const active = resolveActiveRouteTrain(nowDate, context.routeTrains);
        const header = buildRouteHeaderBadge(nowDate, active);
        setBadge(badgeEl, header?.text, header?.accent);

        resetRouteCardLiveFooters();
        if (!active?.train) return;

        const idx = active.train.index;
        if (active.phase === 'transit') {
            const arrDt = active.arrDt;
            if (!arrDt) return;
            const rem = arrDt.getTime() - nowDate.getTime();
            const travelEl = document.querySelector(`.route-live-travel[data-train-index="${idx}"]`);
            if (travelEl) {
                travelEl.textContent = `В пути: ${formatMmSs(Math.max(0, rem))}`;
                travelEl.classList.add('route-live-travel--active');
            }
            return;
        }

        if (active.phase === 'before') {
            const depDt = active.depDt;
            if (!depDt) return;
            const rem = depDt.getTime() - nowDate.getTime();
            const turnEl = document.querySelector(`.route-live-turnaround[data-train-index="${idx}"]`);
            if (turnEl) {
                turnEl.textContent = `Оборот: ${formatMmSs(Math.max(0, rem))}`;
                turnEl.classList.add('route-live-turnaround--active');
            }
        }
    }

    function applyProgressBarState(bar, fill, motion, isTarget) {
        bar.classList.remove('station-progress-bar--leg', 'station-progress-bar--dwell', 'station-progress-bar--pulse');
        if (!isTarget || !motion) {
            bar.hidden = true;
            fill.style.width = '0%';
            return;
        }
        bar.hidden = false;
        fill.style.width = `${motion.progress}%`;
        if (motion.mode === 'dwell') {
            bar.classList.add('station-progress-bar--dwell');
        } else {
            bar.classList.add('station-progress-bar--leg');
        }
    }

    function updateScheduleMotion(nowDate, context) {
        const badgeEl = document.getElementById('scheduleMotionBadge');
        if (!context.synced || context.tab !== 'tab-schedule' || !context.displayStops?.length) {
            if (context.tab !== 'tab-route') setBadge(badgeEl, '', 'muted');
            clearTimelineMotion();
            return;
        }

        const motion = analyzeScheduleMotion(context.displayStops, context.selectedDate, nowDate);
        if (motion?.badge) {
            setBadge(badgeEl, motion.badge.text, motion.badge.accent);
        } else {
            setBadge(badgeEl, '', 'muted');
        }

        const nodes = document.querySelectorAll('#stationsList .station-node');
        nodes.forEach((node, index) => {
            const passed = motion && index < motion.passedBefore;
            node.classList.toggle('passed', passed);

            const bar = node.querySelector('[data-leg-progress]');
            const fill = bar?.querySelector('.fill');
            if (!bar || !fill) return;

            const isTarget = motion && index === motion.targetIndex;
            applyProgressBarState(bar, fill, motion, isTarget);
        });
    }

    function clearTimelineMotion() {
        document.querySelectorAll('#stationsList .station-node.passed').forEach((node) => {
            node.classList.remove('passed');
        });
        document.querySelectorAll('#stationsList [data-leg-progress]').forEach((bar) => {
            const fill = bar.querySelector('.fill');
            applyProgressBarState(bar, fill, null, false);
        });
    }

    function updateTimers(context) {
        if (!deps || !context?.nowDate) {
            clearTimelineMotion();
            resetRouteCardLiveFooters();
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            return;
        }

        const screenSchedule = document.getElementById('screen-schedule');
        if (!screenSchedule || screenSchedule.classList.contains('hidden')) {
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            clearTimelineMotion();
            resetRouteCardLiveFooters();
            return;
        }

        if (context.tab === 'tab-route') {
            updateRouteMotion(context.nowDate, context);
            clearTimelineMotion();
        } else if (context.tab === 'tab-schedule') {
            updateScheduleMotion(context.nowDate, context);
            resetRouteCardLiveFooters();
        } else {
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            clearTimelineMotion();
            resetRouteCardLiveFooters();
        }
    }

    global.TrainMotionTimer = {
        init(api) {
            deps = api || null;
        },
        updateTimers,
        clearTimelineMotion,
        resetRouteCardLiveFooters,
        formatMmSs,
    };
})(typeof window !== 'undefined' ? window : globalThis);
