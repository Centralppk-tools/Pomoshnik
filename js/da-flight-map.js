/**
 * Полётная карта (ограничения скорости по километражу).
 * Справочник: FLIGHT_SPEED_LIMITS (плечи × пути I–VI), сборка — FlightSpeedRoute.
 */
(function initDaFlightMap(global) {
    'use strict';

    const Route = () => global.FlightSpeedRoute;

    /** rail — вертикальная ось как в PDF-навигаторе */
    const FLIGHT_MAP_LAYOUT = 'rail';
    const PX_PER_KM = 36;
    const ROW_SEG_MIN = 36;
    const BOUND_DOT = 6;
    const ROW_KM_COL = 44;
    const ROW_TRACK_COL = 32;
    const NODE_STOP = 26;
    const NODE_MID = 14;
    const NODE_SPEED = 6;

    const LIVE_TICK_MS = 1000;
    let lastCtx = null;
    let lastLivePaint = 0;
    let liveTimer = null;
    let lastRailEvents = null;
    /** Ручной выбор пути (I–VI); сбрасывается при смене поезда/даты */
    let userPathOverride = null;
    let lastRouteKey = '';

    function routeContextKey(ctx) {
        const n = String(ctx?.trainNumber ?? '').trim();
        let d = ctx?.selectedDate;
        if (d && typeof d === 'object' && typeof d.toISOString === 'function') {
            d = d.toISOString().slice(0, 10);
        }
        d = String(d ?? '').trim();
        return `${n}@${d}`;
    }

    function effectivePathBarCtx(ctx) {
        if (lastCtx?.displayStops?.length) return lastCtx;
        return ctx;
    }

    function defaultPathForRoute(displayStops) {
        const r = Route();
        if (!r || !displayStops?.length) return 2;
        const branches = r.detectBranches(displayStops);
        return r.defaultTrack(displayStops, branches);
    }

    function rememberRouteContext(ctx) {
        const key = routeContextKey(ctx);
        const train = key.split('@')[0];
        if (!train) return;
        if (key !== lastRouteKey) {
            lastRouteKey = key;
            userPathOverride = null;
        }
    }

    function resolveActivePathNum(ctx) {
        const displayStops = ctx?.displayStops;
        if (userPathOverride != null) return userPathOverride;
        return defaultPathForRoute(displayStops);
    }

    function pathRoman(pathNum) {
        return ['I', 'II', 'III', 'IV', 'V', 'VI'][pathNum - 1] || String(pathNum);
    }

    function pathsOnRouteMask(displayStops) {
        const r = Route();
        if (!r || !displayStops?.length) return [false, false, false, false, false, false];
        return r.pathsOnRoute(displayStops);
    }

    function isPathSelectable(pathNum, displayStops) {
        const mask = pathsOnRouteMask(displayStops);
        return Boolean(mask[pathNum - 1]);
    }

    function profileHasLimits(profile) {
        if (!profile) return false;
        if (profile.milestones?.length) return true;
        const bm = profile.branchMilestones;
        return Boolean(bm && Object.values(bm).some((arr) => arr?.length));
    }

    function vmaxAtChainage(km, profile, limitMeta) {
        const r = Route();
        if (!r) return null;
        if (limitMeta?.branchAxis && limitMeta.branchKm != null) {
            return r.vmaxOnBranchAxis(limitMeta.branchAxis, limitMeta.branchKm, profile);
        }
        return r.vmaxOnMainAxis(km, profile);
    }

    function stationLimitMeta(displayStops, profile, stopIndex, getChainage) {
        const r = Route();
        if (!r || !displayStops?.length || !profile) return null;
        const item = displayStops[stopIndex];
        const title = item?.referenceTitle;
        const meta = r.stationLimitMeta(title, profile.branches || []);
        const code = item?.threadStop?.station?.code;
        const km =
            typeof getChainage === 'function' ? getChainage(title, code) : null;
        if (meta?.branchAxis === 'sof-kras' && meta.branchKm == null) {
            meta.branchKm = r.branchKmForTitle(title, 'sof-kras');
        }
        return { km, ...meta };
    }

    function vmaxForLeg(kmFrom, kmTo, profile, metaFrom, metaTo) {
        const r = Route();
        if (!r) return null;
        return r.resolveVmaxForLeg(kmFrom, kmTo, profile, metaFrom, metaTo);
    }

    function normalizeStationTitle(title) {
        return String(title || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isMoscowYarTerminal(title) {
        const t = normalizeStationTitle(title);
        return t.includes('москва') || t.includes('ярослав');
    }

    function collectChainages(displayStops, getChainage) {
        const kms = [];
        displayStops.forEach((item) => {
            const km = getChainage(item?.referenceTitle, item?.threadStop?.station?.code);
            if (km != null && Number.isFinite(km)) kms.push(km);
        });
        return kms;
    }

    function isYaroslavskoyeOutbound(displayStops, getChainage) {
        if (!isFlightMapEligible(displayStops, getChainage)) return false;
        const r = Route();
        return r ? r.isOutbound(displayStops) : false;
    }

    function isYaroslavskoyeInbound(displayStops, getChainage) {
        if (!isFlightMapEligible(displayStops, getChainage)) return false;
        const r = Route();
        return r ? !r.isOutbound(displayStops) : false;
    }

    function isFlightMapEligible(displayStops, getChainage) {
        const r = Route();
        if (!r || !displayStops?.length) return false;
        const branches = r.detectBranches(displayStops);
        if (!branches.includes('msk-myt')) return false;
        const kms = collectChainages(displayStops, getChainage);
        if (kms.length < 2) return false;
        const inBand = kms.filter((k) => k >= 0.5 && k <= 114.5).length;
        return inBand / kms.length >= 0.5;
    }

    function isYaroslavskoyeRoute(displayStops, getChainage) {
        return isFlightMapEligible(displayStops, getChainage);
    }

    function routeSectionTitle(displayStops) {
        if (!displayStops?.length) return 'Полётная карта';
        const a = displayStops[0]?.referenceTitle || '—';
        const b = displayStops[displayStops.length - 1]?.referenceTitle || '—';
        return `${a} → ${b}`;
    }

    function pickProfile(displayStops, getChainage, pathNum) {
        if (!Array.isArray(displayStops) || !displayStops.length || typeof getChainage !== 'function') {
            return null;
        }
        if (!isFlightMapEligible(displayStops, getChainage)) return null;
        const r = Route();
        if (!r) return null;

        const path = pathNum ?? defaultPathForRoute(displayStops);
        const profile = r.buildFlightProfile(displayStops, path);
        if (!profileHasLimits(profile)) return null;

        return {
            ...profile,
            sectionTitle: routeSectionTitle(displayStops),
        };
    }

    function speedTone(v) {
        if (v == null) return 'muted';
        if (v <= 60) return 'slow';
        if (v <= 90) return 'mid';
        if (v <= 110) return 'fast';
        return 'max';
    }

    function formatChainage(km) {
        if (km == null || !Number.isFinite(km)) return '';
        const whole = Math.floor(km);
        const pk = Math.round((km - whole) * 10);
        if (pk <= 0) return `${whole} км`;
        return `${whole} км ${pk} пк`;
    }

    /** Компактная подпись км/пк как на полётной (1.1, 2.4…) */
    function formatKmCompact(km) {
        if (km == null || !Number.isFinite(km)) return '';
        const whole = Math.floor(km + 1e-6);
        const pk = Math.round((km - whole) * 10 + 1e-6);
        if (pk <= 0) return String(whole);
        return `${whole}.${pk}`;
    }

    function shortStationTitle(title) {
        const t = String(title || '').trim();
        if (!t) return '';
        if (/[→\-–—−]/.test(t)) return t.length > 22 ? `${t.slice(0, 21)}…` : t;
        if (/^москва\b/i.test(t) && /ярослав/i.test(t)) return 'Москва Яр.';
        return t.length > 22 ? `${t.slice(0, 21)}…` : t;
    }

    function kmKey(km) {
        return Math.round(km * 1000);
    }

    function eventPriority(type) {
        return { stop: 0, pass: 1, brake: 2, mark: 3, speed: 4 }[type] ?? 9;
    }

    function putRouteEvent(byKm, ev) {
        const key = kmKey(ev.km);
        const prev = byKm.get(key);
        if (!prev || eventPriority(ev.type) < eventPriority(prev.type)) {
            byKm.set(key, { ...ev });
        }
    }

    function nodeHeightForType(type) {
        if (type === 'mark') return BOUND_DOT;
        if (type === 'stop') return NODE_STOP;
        return NODE_MID;
    }

    function hasRailNode(type) {
        return type === 'stop' || type === 'pass' || type === 'brake';
    }

    function isSpeedBoundDot(type) {
        return type === 'mark';
    }

    function applySpeedLabels(events, profile, displayStops, getChainage) {
        let lastShown = null;
        events.forEach((ev, i) => {
            const next = events[i + 1];
            if (!next) {
                ev.speedToNext = null;
                ev.segHeight = 0;
                ev.displaySpeed = null;
                return;
            }
            const metaFrom =
                ev.stopIndex != null
                    ? stationLimitMeta(displayStops, profile, ev.stopIndex, getChainage)
                    : null;
            const metaTo =
                next.stopIndex != null
                    ? stationLimitMeta(displayStops, profile, next.stopIndex, getChainage)
                    : null;
            const v = vmaxForLeg(ev.km, next.km, profile, metaFrom, metaTo);
            ev.speedToNext = v;
            ev.segHeight = Math.max(ROW_SEG_MIN, (next.km - ev.km) * PX_PER_KM);

            let show = v != null && v !== lastShown;
            // На перегонах между остановками цифру не глушим, даже если лимит не менялся
            if (!show && v != null && ev.type === 'stop') show = true;

            ev.displaySpeed = show ? v : null;
            if (show && v != null) lastShown = v;
        });
    }

    function buildRouteEvents(displayStops, getChainage, profile) {
        if (!profileHasLimits(profile) || !displayStops?.length) return [];
        const byKm = new Map();

        displayStops.forEach((item, index) => {
            const title = String(item.referenceTitle || '').trim();
            const code = item?.threadStop?.station?.code;
            const km = getChainage(title, code);
            if (km == null || !Number.isFinite(km)) return;
            putRouteEvent(byKm, {
                km,
                type: item.passThrough ? 'pass' : 'stop',
                title: title || '—',
                stopIndex: index,
                terminal: index === displayStops.length - 1,
            });
        });

        const stopKms = [...byKm.values()].map((e) => e.km);
        let minK = Math.min(...stopKms);
        let maxK = Math.max(...stopKms);
        minK = Math.max(profile.kmMin ?? 0, minK - 0.35);
        maxK = Math.min(profile.kmMax ?? 200, maxK + 0.35);

        (profile.brakeMarks || []).forEach((b) => {
            if (b.branch && b.branch !== 'msk-myt') return;
            if (b.km < minK - 0.5 || b.km > maxK + 0.5) return;
            putRouteEvent(byKm, {
                km: b.km,
                type: 'brake',
                title: b.text,
                stopIndex: null,
                terminal: false,
            });
        });

        const anchors = [...byKm.values()];
        const msInRange = profile.milestones.filter(
            (m) => m.km >= minK - 0.02 && m.km <= maxK + 0.02
        );
        let prevVmax = null;
        msInRange.forEach((m, idx) => {
            const speedChange = prevVmax != null && m.vmax !== prevVmax;
            if (idx > 0 && !speedChange) {
                prevVmax = m.vmax;
                return;
            }
            const nearAnchor = anchors.some((a) => Math.abs(a.km - m.km) < 0.12);
            if (!nearAnchor && !byKm.has(kmKey(m.km))) {
                putRouteEvent(byKm, {
                    km: m.km,
                    type: 'mark',
                    title: '',
                    stopIndex: null,
                    terminal: false,
                });
            }
            prevVmax = m.vmax;
        });

        const events = [...byKm.values()].sort((a, b) => a.km - b.km);
        applySpeedLabels(events, profile, displayStops, getChainage);
        return events;
    }

    function totalRouteHeight(events) {
        return events.reduce((sum, ev) => sum + nodeHeightForType(ev.type) + (ev.segHeight || 0), 0);
    }

    function progressHeightForKm(events, currentKm, motion) {
        if (motion.state === 'before' || currentKm == null) return 0;
        if (motion.state === 'done') return totalRouteHeight(events);
        let y = 0;
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const next = events[i + 1];
            const nodeH = nodeHeightForType(ev.type);
            if (currentKm <= ev.km + 1e-4) {
                return y + nodeH / 2;
            }
            y += nodeH;
            if (!next) return y;
            if (currentKm <= next.km + 1e-4) {
                const span = next.km - ev.km;
                const t = span > 0 ? (currentKm - ev.km) / span : 0;
                return y + t * ev.segHeight;
            }
            y += ev.segHeight;
        }
        return y;
    }

    function findNextStopIndex(events, currentKm, motion) {
        if (!events.length || motion.state === 'done' || motion.state === 'off') return -1;
        if (motion.state === 'dwell') return -1;
        if (motion.state === 'before' || currentKm == null) {
            return events.findIndex((e) => e.type === 'stop');
        }
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (ev.type !== 'stop') continue;
            if (ev.km > currentKm + 0.015) return i;
        }
        return -1;
    }

    function dwellEventIndex(events, motion) {
        if (motion.state !== 'dwell' || motion.displayStopIndex == null) return -1;
        return events.findIndex(
            (e) => e.type === 'stop' && e.stopIndex === motion.displayStopIndex
        );
    }

    function isStationRowPassed(ev, currentKm, motion) {
        if (ev.type !== 'stop' && ev.type !== 'pass') return false;
        if (motion.state === 'done') return true;
        if (
            motion.state === 'dwell'
            && motion.displayStopIndex != null
            && ev.stopIndex != null
        ) {
            return ev.stopIndex < motion.displayStopIndex;
        }
        if (currentKm == null || motion.state === 'before') return false;
        return ev.km < currentKm - 0.02;
    }

    function isNodePassed(ev, currentKm, motion, index, events) {
        if (!hasRailNode(ev.type)) return false;
        const dwellIdx = dwellEventIndex(events, motion);
        if (dwellIdx >= 0) return index < dwellIdx;
        if (motion.state === 'done') return index < events.length - 1;
        if (currentKm == null) return false;
        return ev.km < currentKm - 0.02;
    }

    function resolveMotion(ctx) {
        const getNow = typeof ctx?.getNowDate === 'function' ? ctx.getNowDate : () => new Date();
        const now = getNow();
        if (typeof ctx?.computeCurrentKm === 'function') {
            return ctx.computeCurrentKm(now);
        }
        return { km: null, state: 'unknown', progress: 0 };
    }

    function pickClockHm(value) {
        if (typeof global.formatClockHm === 'function') {
            return global.formatClockHm(value);
        }
        const t = String(value || '').trim();
        return t && t !== '—' && t !== '...' ? t : '';
    }

    function formatDwellForStop(stop, index, total) {
        if (!stop || typeof global.getStopDwellMinutes !== 'function') return '';
        const dwell = global.getStopDwellMinutes(stop, index === 0 || index === total - 1);
        if (typeof global.formatDwellChip === 'function') {
            return global.formatDwellChip(dwell);
        }
        return '';
    }

    function formatStopTimesParts(item, index, total) {
        const stop = item?.threadStop;
        if (!stop) return { arr: '', dep: '' };
        const pickArr = global.pickStopArrival;
        const pickDep = global.pickStopDeparture;
        const arr = pickArr ? pickClockHm(pickArr(stop)) : '';
        const dep = pickDep ? pickClockHm(pickDep(stop)) : '';
        if (index === 0) return { arr: '', dep: dep || arr };
        if (index === total - 1) return { arr: arr || dep, dep: '' };
        return { arr, dep };
    }

    function buildSourceFooter(profile) {
        if (!profile) return '';
        const ed = profile.edition || '—';
        const path = profile.pathNum != null ? pathRoman(profile.pathNum) : '—';
        return `Путь ${path} · ${profile.sourceNote} · ред. ${ed}`;
    }

    function renderStationTimesBlock(arr, dep, dwell, index, total) {
        const chips = [];
        if (arr) chips.push(`<span class="fm-station-line__arr">${escapeText(arr)}</span>`);
        if (dwell && arr && dep && index > 0 && index < total - 1) {
            chips.push(`<span class="fm-station-line__dwell">${escapeText(dwell)}</span>`);
        }
        if (dep) chips.push(`<span class="fm-station-line__dep">${escapeText(dep)}</span>`);
        if (!chips.length) return '';
        const single = chips.length === 1 ? ' fm-station-line__times--single' : '';
        return `<span class="fm-station-line__times${single}">${chips.join('')}</span>`;
    }

    function renderRowInfo(ev, displayStops) {
        if (ev.type === 'speed') return '';
        if (ev.type === 'brake') {
            const cls = /ЭПТ/i.test(ev.title) ? 'fm-row__title--ept' : 'fm-row__title--pt';
            return `<span class="fm-row__title ${cls}">${escapeText(ev.title)}</span>`;
        }
        if (ev.type === 'pass') {
            return `
                <div class="fm-pass-line">
                    <span class="fm-row__title fm-row__title--pass">${escapeText(ev.title)}</span>
                    <span class="fm-row__pass-tag">без остановки</span>
                </div>`;
        }
        if (ev.type === 'stop' && ev.stopIndex != null) {
            const item = displayStops[ev.stopIndex];
            const stop = item?.threadStop;
            const total = displayStops.length;
            const { arr, dep } = formatStopTimesParts(item, ev.stopIndex, total);
            const dwell = formatDwellForStop(stop, ev.stopIndex, total);
            const times = renderStationTimesBlock(arr, dep, dwell, ev.stopIndex, total);
            return `
                <div class="fm-station-line">
                    <span class="fm-station-line__name">${escapeText(ev.title)}</span>
                    ${times}
                </div>`;
        }
        return ev.title ? `<span class="fm-row__title">${escapeText(ev.title)}</span>` : '';
    }

    function renderRouteRow(ev, index, events, displayStops, motion, nextStopIndex, dwellIdx) {
        const currentKm = motion.km;
        const isNext = index === nextStopIndex && ev.type === 'stop';
        const isDwelling = index === dwellIdx && ev.type === 'stop';
        const rowPassed = isStationRowPassed(ev, currentKm, motion);
        const passed = isNodePassed(ev, currentKm, motion, index, events);
        const nodeCls = [
            'fm-row__node',
            `fm-row__node--${ev.type}`,
            isNext ? 'is-upcoming' : '',
            isDwelling ? 'is-dwelling' : '',
            passed ? 'is-passed' : '',
            ev.terminal ? 'is-terminal' : '',
        ]
            .filter(Boolean)
            .join(' ');
        const showNode = hasRailNode(ev.type);
        const speedVal = ev.displaySpeed;
        const segHtml =
            ev.speedToNext != null
                ? `<div class="fm-row__leg fm-row__seg" style="min-height:${ev.segHeight}px"${
                      speedVal != null ? ` aria-label="Ограничение ${speedVal} км/ч"` : ''
                  }>${speedVal != null ? `<span class="fm-row__speed">${escapeText(String(speedVal))}</span>` : ''}</div>`
                : '';
        const boundDot = isSpeedBoundDot(ev.type)
            ? '<span class="fm-row__bound" aria-hidden="true"></span>'
            : '';
        const nodeHtml = showNode
            ? `<span class="${nodeCls}" role="img" aria-label="${ev.title ? escapeText(ev.title) : escapeText(formatKmCompact(ev.km))}"></span>`
            : '';
        const info = ev.type === 'mark' ? '' : renderRowInfo(ev, displayStops);
        const rowCls = [
            'fm-row',
            `fm-row--${ev.type}`,
            ev.type === 'stop' ? 'fm-row--station' : '',
            ev.type === 'pass' ? 'fm-row--pass' : '',
            rowPassed ? 'fm-row--passed' : '',
            isNext ? 'fm-row--next-stop' : '',
            isDwelling ? 'fm-row--dwelling' : '',
        ]
            .filter(Boolean)
            .join(' ');

        return `
            <div class="${rowCls}" role="listitem" data-km="${ev.km}" data-row-index="${index}">
                <span class="fm-row__km">${escapeText(formatKmCompact(ev.km))}</span>
                <div class="fm-row__track">${boundDot}${nodeHtml}${segHtml}</div>
                <div class="fm-row__info">${info}</div>
            </div>`;
    }

    function applyRowMotionClasses(rowEl, ev, index, events, motion, nextStopIndex, dwellIdx) {
        if (!rowEl || !ev) return;
        const currentKm = motion.km;
        const isNext = index === nextStopIndex && ev.type === 'stop';
        const isDwelling = index === dwellIdx && ev.type === 'stop';
        const rowPassed = isStationRowPassed(ev, currentKm, motion);
        rowEl.classList.toggle('fm-row--passed', rowPassed);
        rowEl.classList.toggle('fm-row--next-stop', isNext);
        rowEl.classList.toggle('fm-row--dwelling', isDwelling);

        const node = rowEl.querySelector('.fm-row__node');
        if (node && hasRailNode(ev.type)) {
            const passed = isNodePassed(ev, currentKm, motion, index, events);
            node.classList.toggle('is-passed', passed);
            node.classList.toggle('is-upcoming', isNext);
            node.classList.toggle('is-dwelling', isDwelling);
            node.classList.remove('is-active');
        }

    }

    function applyRailTrackMotion(rowsRoot, fill, motion) {
        if (!rowsRoot) return;
        const isTransit = motion.state === 'transit';
        const isDwell = motion.state === 'dwell';
        rowsRoot.classList.toggle('is-transit', isTransit);
        rowsRoot.classList.toggle('is-dwelling', isDwell);
        if (fill) {
            fill.classList.toggle('is-flowing', isTransit);
        }
    }

    function updateRailMotion(ctx) {
        const rowsRoot = document.querySelector('#flightMapList .fm-rail-rows');
        if (!rowsRoot || !lastRailEvents?.length) return;

        const motion = resolveMotion(ctx);
        const currentKm = motion.km;
        const progressH = progressHeightForKm(lastRailEvents, currentKm, motion);
        const nextStopIndex = findNextStopIndex(lastRailEvents, currentKm, motion);
        const dwellIdx = dwellEventIndex(lastRailEvents, motion);

        const fill = rowsRoot.querySelector('.fm-rail-rows__fill');
        if (fill) {
            fill.style.height = `${progressH}px`;
            fill.style.setProperty('--fm-fill-h', `${progressH}px`);
        }
        applyRailTrackMotion(rowsRoot, fill, motion);

        const rowEls = rowsRoot.querySelectorAll('.fm-row[data-row-index]');
        rowEls.forEach((rowEl) => {
            const index = Number(rowEl.getAttribute('data-row-index'));
            if (!Number.isFinite(index)) return;
            const ev = lastRailEvents[index];
            if (!ev) return;
            applyRowMotionClasses(
                rowEl,
                ev,
                index,
                lastRailEvents,
                motion,
                nextStopIndex,
                dwellIdx
            );
        });
    }

    function getPathPickerMount() {
        return (
            document.querySelector('#scheduleHeader #flightMapPathBarMount')
            || document.getElementById('flightMapPathBarMount')
        );
    }

    function buildShortRouteTitle(fullTitle) {
        const raw = String(fullTitle || '').trim();
        if (!raw) return '';
        const parts = raw.split(/\s*[→\-–—−]\s*/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
            const from = shortStationTitle(parts[0]);
            const to = shortStationTitle(parts[parts.length - 1]);
            return `${from} → ${to}`;
        }
        return shortStationTitle(raw);
    }

    function syncFlightRouteCard(isFlightTab) {
        const header = document.getElementById('scheduleHeader');
        if (!header) return;
        const titleEl = header.querySelector('.route-card-title');
        if (!titleEl) return;
        let full = titleEl.getAttribute('data-route-title-full');
        if (!full) {
            full = String(titleEl.textContent || '').trim();
            if (full) titleEl.setAttribute('data-route-title-full', full);
        }
        if (!full) return;
        titleEl.textContent = buildShortRouteTitle(full);
    }

    function renderPathPickerMarkup(activePath, displayStops, getChainage, options = {}) {
        const paths = [1, 2, 3, 4, 5, 6];
        const roman = ['I', 'II', 'III', 'IV', 'V', 'VI'];
        const compact = options.compact === true;
        return `
            <div class="fm-path${compact ? ' fm-path--compact' : ''}" role="group" aria-label="Выбор пути">
                ${compact ? '' : '<span class="fm-card__title">Полётная карта</span>'}
                <span class="fm-path__label">Путь</span>
                <div class="fm-path__capsule" role="tablist" data-active-path="${activePath}">
                    ${paths
                        .map((p, i) => {
                            const on = p === activePath;
                            const selectable = isPathSelectable(p, displayStops);
                            const off = !selectable;
                            return `
                            <button type="button" role="tab"
                                class="fm-path__tab${on ? ' is-active' : ''}${off ? ' is-disabled' : ''}"
                                data-path="${p}"
                                ${off ? 'disabled' : ''}
                                aria-selected="${on ? 'true' : 'false'}"
                                aria-disabled="${off ? 'true' : 'false'}"
                                title="${off ? 'Нет полётной карты МЯЭД для этого пути' : `Путь ${roman[i]}`}">${roman[i]}</button>`;
                        })
                        .join('')}
                </div>
            </div>
        `;
    }

    function paintPathPickerState(mount, activePath) {
        if (!mount) return;
        mount.dataset.pathActive = String(activePath);
        mount.querySelectorAll('.fm-path__tab').forEach((btn) => {
            const p = Number(btn.dataset.path);
            const on = p === activePath;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const capsule = mount.querySelector('.fm-path__capsule');
        if (capsule) capsule.dataset.activePath = String(activePath);
    }

    function onPathPickerSelect(pathNum) {
        if (!lastCtx?.displayStops?.length) return;
        if (!isPathSelectable(pathNum, lastCtx.displayStops)) return;
        if (userPathOverride === pathNum) return;
        userPathOverride = pathNum;
        const mount = getPathPickerMount();
        if (mount) {
            paintPathPickerState(mount, pathNum);
            mount.classList.add('fm-path-bar-mount--changed');
            global.setTimeout?.(() => mount.classList.remove('fm-path-bar-mount--changed'), 420);
        }
        renderList(lastCtx);
        global.TrainMotionTimer?.updateTimers?.();
    }

    function ensurePathPickerDelegation() {
        if (ensurePathPickerDelegation.done) return;
        ensurePathPickerDelegation.done = true;
        document.addEventListener(
            'click',
            (e) => {
                const btn = e.target.closest(
                    '#scheduleHeader #flightMapPathBarMount .fm-path__tab, #flightMapPathBarMount .fm-path__tab'
                );
                if (!btn || btn.disabled || btn.classList.contains('is-disabled')) return;
                e.preventDefault();
                e.stopPropagation();
                const p = Number(btn.dataset.path);
                if (!Number.isFinite(p)) return;
                onPathPickerSelect(p);
            },
            true
        );
    }

    function syncHeaderPathBar(ctx) {
        ensurePathPickerDelegation();
        const mount = getPathPickerMount();
        if (!mount) return;

        const useCtx = effectivePathBarCtx(ctx);
        const getChainage =
            typeof useCtx?.getChainage === 'function'
                ? useCtx.getChainage
                : (title, code) => global.stationChainage?.(title, code);

        const show =
            isFlightTabVisible()
            && useCtx?.displayStops?.length
            && isYaroslavskoyeRoute(useCtx.displayStops, getChainage);

        if (!show) {
            mount.hidden = true;
            mount.setAttribute('aria-hidden', 'true');
            mount.innerHTML = '';
            return;
        }

        const activePath = resolveActivePathNum(useCtx);
        const capsule = mount.querySelector('.fm-path__capsule');
        mount.hidden = false;
        mount.removeAttribute('aria-hidden');
        if (!capsule) {
            mount.innerHTML = renderPathPickerMarkup(
                activePath,
                useCtx.displayStops,
                getChainage,
                { compact: true }
            );
        }
        paintPathPickerState(mount, activePath);
        mount.classList.toggle('fm-path-bar-mount--ready', true);
    }

    function pathDataStatus() {
        const reg = global.FLIGHT_SPEED_LIMITS?.speedLimitsByBranch || {};
        const tracks = new Set();
        Object.values(reg).forEach((branch) => {
            Object.keys(branch?.tracks || {}).forEach((t) => tracks.add(Number(t)));
        });
        return [1, 2, 3, 4, 5, 6].map((pathNum) => ({
            pathNum,
            roman: ['I', 'II', 'III', 'IV', 'V', 'VI'][pathNum - 1],
            hasMilestones: tracks.has(pathNum),
        }));
    }

    function renderRailChart(displayStops, getChainage, profile, ctx) {
        const events = buildRouteEvents(displayStops, getChainage, profile);
        if (!events.length) {
            return '<p class="flight-map__warn">Нет точек километража для построения оси.</p>';
        }

        lastRailEvents = events;

        const motion = resolveMotion(ctx);
        const currentKm = motion.km;
        const progressH = progressHeightForKm(events, currentKm, motion);
        const nextStopIndex = findNextStopIndex(events, currentKm, motion);
        const dwellIdx = dwellEventIndex(events, motion);
        const flowCls = motion.state === 'transit' ? ' is-flowing' : '';
        const rowsRootCls = [
            motion.state === 'transit' ? 'is-transit' : '',
            motion.state === 'dwell' ? 'is-dwelling' : '',
        ]
            .filter(Boolean)
            .join(' ');

        const rows = events
            .map((ev, index) =>
                renderRouteRow(ev, index, events, displayStops, motion, nextStopIndex, dwellIdx)
            )
            .join('');

        const footer = escapeText(buildSourceFooter(profile));
        const trackLeft = ROW_KM_COL + 10;

        const pathNum = profile?.pathNum ?? resolveActivePathNum(ctx);

        return `
            <div class="flight-map__card flight-map__rail--path${pathNum} is-path-${pathNum}" data-active-path="${pathNum}">
                <div class="fm-card__body">
                    <div class="fm-rail-rows${rowsRootCls ? ` ${rowsRootCls}` : ''}" role="list" style="--fm-track-left:${trackLeft}px;--fm-track-w:${ROW_TRACK_COL}px">
                        <div class="fm-rail-rows__fill${flowCls}" style="height:${progressH}px;--fm-fill-h:${progressH}px" aria-hidden="true"></div>
                        ${rows}
                    </div>
                </div>
                ${footer ? `<footer class="fm-card__foot"><span class="fm-card__source">${footer}</span></footer>` : ''}
            </div>
        `;
    }

    function stopLiveTimer() {
        if (liveTimer != null) {
            clearInterval(liveTimer);
            liveTimer = null;
        }
    }

    function startLiveTimer() {
        stopLiveTimer();
        liveTimer = setInterval(() => {
            if (!lastCtx) return;
            if (!isFlightTabVisible()) return;
            updateRailMotion(lastCtx);
        }, LIVE_TICK_MS);
    }

    function tickLive() {
        const now = Date.now();
        if (now - lastLivePaint < LIVE_TICK_MS) return;
        lastLivePaint = now;
        if (!lastCtx || !isFlightTabVisible()) return;
        if (document.querySelector('#flightMapList .fm-rail-rows')) {
            updateRailMotion(lastCtx);
        } else {
            renderList(lastCtx);
        }
    }

    function escapeText(s) {
        if (global.escapeHtml) return global.escapeHtml(s);
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function renderRows(displayStops, getChainage, profile) {
        const rows = [];
        let prevKm = null;

        displayStops.forEach((item, index) => {
            const title = item.referenceTitle || '—';
            const code = item?.threadStop?.station?.code;
            const km = getChainage(title, code);
            const pass = Boolean(item.passThrough);
            const legV = index > 0 ? vmaxForLeg(prevKm, km, profile) : null;
            const tone = speedTone(legV);

            if (index > 0) {
                const segLabel = (prevKm != null && km != null)
                    ? `${formatChainage(prevKm)} — ${formatChainage(km)}`
                    : '';
                rows.push(`
                    <div class="fm-seg fm-seg--${tone}" role="listitem" aria-label="${escapeText(
                        legV != null ? `Ограничение ${legV} км/ч` : 'Перегон'
                    )}${segLabel ? `, ${escapeText(segLabel)}` : ''}">
                        <div class="fm-seg__speed" aria-hidden="true">${legV != null ? escapeText(String(legV)) : '—'}</div>
                        <div class="fm-seg__body">
                            <span class="fm-seg__title">Перегон</span>
                            ${segLabel ? `<span class="fm-seg__km">${escapeText(segLabel)}</span>` : ''}
                        </div>
                    </div>
                `);
            }

            rows.push(`
                <div class="fm-stop ${pass ? 'is-pass' : ''}" role="listitem" data-index="${index}">
                    <span class="fm-stop__dot" aria-hidden="true"></span>
                    <span class="fm-stop__name">${escapeText(title)}</span>
                    <span class="fm-stop__km">${km != null ? escapeText(formatChainage(km)) : ''}</span>
                </div>
            `);

            if (km != null) prevKm = km;
        });

        return rows.join('');
    }

    function renderList(ctx) {
        const root = document.getElementById('flightMapList');
        const empty = document.getElementById('flightMapEmpty');
        const headSection = document.getElementById('flightMapSectionTitle');
        const headMeta = document.getElementById('flightMapMeta');
        const loader = document.getElementById('flightMapLoader');
        if (!root) return;

        const displayStops = ctx?.displayStops;
        const getChainage = ctx?.getChainage;

        if (loader) loader.hidden = true;

        if (!Array.isArray(displayStops) || !displayStops.length) {
            root.innerHTML = '';
            root.hidden = true;
            if (empty) empty.hidden = false;
            if (headSection) headSection.textContent = 'Полётная карта';
            if (headMeta) headMeta.textContent = ctx?.trainNumber
                ? `Поезд ${ctx.trainNumber} · нет остановок`
                : 'Откройте расписание поезда';
            return;
        }

        rememberRouteContext(ctx);
        const activePath = resolveActivePathNum(ctx);
        const profile = pickProfile(displayStops, getChainage, activePath);
        if (headSection) headSection.textContent = 'Полётная карта';
        if (headMeta) headMeta.textContent = `Путь ${pathRoman(activePath)} · МЯЭД`;

        syncHeaderPathBar(ctx);

        if (!profile) {
            const pathRoman = ['I', 'II', 'III', 'IV', 'V', 'VI'][activePath - 1] || String(activePath);
            const yar = isYaroslavskoyeRoute(displayStops, getChainage);
            const warnText = yar && !isPathSelectable(activePath, displayStops)
                ? `Путь ${pathRoman} не действует на этом маршруте. Выберите другой путь в шапке.`
                : 'Для этого направления пока нет загруженной полётной карты по МЯЭД. Станции как на «Расписании»; скорости появятся после привязки участка.';
            root.innerHTML = `
                <p class="flight-map__warn">${escapeText(warnText)}</p>
                <div class="flight-map__ribbon" role="list">
                    ${displayStops.map((item) => {
                        const title = item.referenceTitle || '—';
                        const km = typeof getChainage === 'function'
                            ? getChainage(title, item?.threadStop?.station?.code)
                            : null;
                        return `
                            <div class="fm-stop ${item.passThrough ? 'is-pass' : ''}" role="listitem">
                                <span class="fm-stop__dot" aria-hidden="true"></span>
                                <span class="fm-stop__name">${escapeText(title)}</span>
                                <span class="fm-stop__km">${km != null ? escapeText(formatChainage(km)) : ''}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } else if (FLIGHT_MAP_LAYOUT === 'rail') {
            root.innerHTML = renderRailChart(displayStops, getChainage, profile, ctx);
            startLiveTimer();
            lastLivePaint = Date.now();
        } else {
            root.innerHTML = `
                <div class="flight-map__ribbon flight-map__ribbon--${FLIGHT_MAP_LAYOUT}" role="list">
                    ${renderRows(displayStops, getChainage, profile)}
                </div>
                <p class="flight-map__tone-hint" aria-hidden="true">
                    Цвет полосы: жёлтый ≤60 · голубой 61–90 · зелёный 91–110 · бирюза ≥120
                </p>
            `;
        }

        root.hidden = false;
        if (empty) empty.hidden = true;
    }

    function renderFromDisplayStops(ctx) {
        lastCtx = ctx ? { ...ctx } : null;
        if (lastCtx) rememberRouteContext(lastCtx);
        renderList(lastCtx);
    }

    function refreshIfVisible() {
        if (lastCtx) renderList(lastCtx);
    }

    function getSpeedLimitAtNow(ctx) {
        const pathNum = resolveActivePathNum(ctx);
        const profile = pickProfile(ctx?.displayStops, ctx?.getChainage, pathNum);
        if (!profile) return null;
        const motion = resolveMotion(ctx);
        if (motion.km == null || !Number.isFinite(motion.km)) return null;
        return vmaxAtChainage(motion.km, profile);
    }

    function isFlightTabVisible() {
        const active = document.querySelector('#screen-schedule .tab-content.active');
        return active?.id === 'tab-flight-map';
    }

    function clear() {
        stopLiveTimer();
        lastCtx = null;
        lastRailEvents = null;
        userPathOverride = null;
        lastRouteKey = '';
        syncHeaderPathBar(null);
        const root = document.getElementById('flightMapList');
        const empty = document.getElementById('flightMapEmpty');
        const loader = document.getElementById('flightMapLoader');
        if (root) {
            root.innerHTML = '';
            root.hidden = true;
        }
        if (empty) empty.hidden = false;
        if (loader) loader.hidden = true;
    }

    function onTabActivated() {
        const loader = document.getElementById('flightMapLoader');
        syncHeaderPathBar(lastCtx);
        if (lastCtx) {
            if (loader) loader.hidden = true;
            renderList(lastCtx);
            return;
        }
        if (loader) loader.hidden = false;
        const empty = document.getElementById('flightMapEmpty');
        if (empty) empty.hidden = true;
    }

    ensurePathPickerDelegation();

    global.DaFlightMap = {
        speedLimitsRef: () => global.FLIGHT_SPEED_LIMITS,
        pathDataStatus,
        defaultPathForRoute,
        resolveActivePathNum,
        renderFromDisplayStops,
        refreshIfVisible,
        getSpeedLimitAtNow,
        syncHeaderPathBar,
        syncFlightRouteCard,
        buildShortRouteTitle,
        tickLive,
        clear,
        onTabActivated,
    };
})(typeof window !== 'undefined' ? window : globalThis);