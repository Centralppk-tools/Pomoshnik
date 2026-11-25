/**
 * Склейка полётной карты по плечам и путям (I–VI) из FLIGHT_SPEED_LIMITS.
 */
(function initFlightSpeedRoute(global) {
    'use strict';

    const META = {
        'msk-myt': { tracks: [1, 2, 3, 4, 5], mainKm: [1.0, 21.6] },
        'myt-alex': { tracks: [1, 2], mainKm: [20.0, 114.5] },
        'myt-fryaz': { tracks: [1, 2], mainKm: [18.5, 74.0] },
        'bol-fryaz-pass': { tracks: [3], mainKm: null },
        'sof-kras': { tracks: [6], mainKm: null },
    };

    const FRYAZINO_PASS_KEYS = [
        'ивантеев',
        'фабрика 1',
        'зеленый бор',
        'фрязино-тов',
        'фрязино-пас',
        'фрязино пас',
        'детская',
    ];
    const FRYAZEVO_KEYS = [
        'фрязево',
        'монино',
        'щелков',
        'валентинов',
        'загорян',
        'соколовск',
        'воронок',
        'гагарин',
        'чкалов',
        'бахчивандж',
        'циолков',
        'осеев',
        'кашино',
        'колонтаев',
        'лесная 64',
        'подлипки',
        'болшево',
    ];
    const ALEX_KEYS = [
        'александров',
        'сергиев',
        'ашукин',
        'калистов',
        'радонеж',
        'абрамцев',
        'семхоз',
        'хотьково',
        'стройтель',
        'челюскин',
        'тарасов',
        'клязьм',
        'мамонтов',
        'пушкин',
        'заветы',
        'правда',
        'зеленоград',
        'софрино',
    ];
    const KRAS_KEYS = ['красноармейск', 'путилово', 'федоровск', 'рахманово', 'поселок дальн', 'посёлок дальн'];

    function registry() {
        return global.FLIGHT_SPEED_LIMITS?.speedLimitsByBranch || {};
    }

    function normTitle(title) {
        return String(title || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function keysFromStops(displayStops) {
        return (displayStops || []).map((s) => normTitle(s?.referenceTitle));
    }

    function anyKeyMatch(keys, needles) {
        return keys.some((k) => needles.some((n) => k.includes(n)));
    }

    function isMoscowYar(title) {
        const t = normTitle(title);
        return t.includes('москва') && (t.includes('ярослав') || t.includes('вокзал'));
    }

    function detectBranches(displayStops) {
        const keys = keysFromStops(displayStops);
        const branches = ['msk-myt'];
        if (anyKeyMatch(keys, FRYAZINO_PASS_KEYS)) {
            branches.push('bol-fryaz-pass');
        } else if (anyKeyMatch(keys, FRYAZEVO_KEYS)) {
            branches.push('myt-fryaz');
        } else if (anyKeyMatch(keys, ALEX_KEYS)) {
            branches.push('myt-alex');
        }
        if (anyKeyMatch(keys, KRAS_KEYS)) {
            if (!branches.includes('myt-alex')) branches.push('myt-alex');
            branches.push('sof-kras');
        }
        return branches;
    }

    function isOutbound(displayStops) {
        if (!displayStops?.length) return true;
        return isMoscowYar(displayStops[0]?.referenceTitle);
    }

    function defaultTrack(displayStops, branches) {
        if (branches.includes('bol-fryaz-pass')) return 3;
        if (branches.includes('sof-kras')) {
            const keys = keysFromStops(displayStops);
            if (anyKeyMatch(keys, KRAS_KEYS)) return 6;
        }
        return isOutbound(displayStops) ? 2 : 1;
    }

    function effectiveTrackForBranch(branchId, userTrack, outbound) {
        const allowed = META[branchId]?.tracks || [];
        if (allowed.includes(userTrack)) return userTrack;
        if (branchId === 'bol-fryaz-pass') return 3;
        if (branchId === 'sof-kras') return 6;
        return outbound ? 2 : 1;
    }

    function branchOwnsMainKm(branchId, km) {
        const range = META[branchId]?.mainKm;
        if (!range) return false;
        return km >= range[0] && km <= range[1];
    }

    function intervalsToMilestones(intervals, branchId) {
        const sorted = [...(intervals || [])].sort((a, b) => a.fromKm - b.fromKm);
        const milestones = [];
        const brakeMarks = [];
        sorted.forEach((iv) => {
            if (iv.speed == null || !Number.isFinite(iv.fromKm)) return;
            milestones.push({
                km: iv.fromKm,
                vmax: iv.speed,
                note: iv.note || null,
                branch: branchId,
                isBrakeTest: Boolean(iv.isBrakeTest),
            });
            if (iv.isBrakeTest && iv.note) {
                brakeMarks.push({ km: iv.fromKm, text: iv.note, branch: branchId });
            }
        });
        return { milestones, brakeMarks };
    }

    function mergeMilestonesForRoute(branches, trackByBranch, reg) {
        const byKm = new Map();
        const priority = {
            'msk-myt': 1,
            'myt-fryaz': 2,
            'myt-alex': 2,
            'bol-fryaz-pass': 3,
            'sof-kras': 4,
        };

        const allBrakes = [];
        let kmMin = Infinity;
        let kmMax = -Infinity;
        const branchMilestones = {};

        branches.forEach((branchId) => {
            const track = trackByBranch[branchId];
            const trackData = reg[branchId]?.tracks?.[String(track)];
            if (!trackData?.intervals?.length) return;
            const axis = reg[branchId]?.chainageAxis || 'main';
            const { milestones, brakeMarks } = intervalsToMilestones(trackData.intervals, branchId);
            allBrakes.push(...brakeMarks);

            if (axis === 'main') {
                milestones.forEach((m) => {
                    const key = Math.round(m.km * 1000);
                    const prev = byKm.get(key);
                    const pr = priority[branchId] ?? 9;
                    const prevPr = prev ? priority[prev.branch] ?? 9 : -1;
                    if (branchId !== 'msk-myt' && !branchOwnsMainKm(branchId, m.km)) return;
                    if (branchId !== 'msk-myt' && branchOwnsMainKm('msk-myt', m.km) && m.km < 21.5) return;
                    if (!prev || pr >= prevPr) byKm.set(key, m);
                    kmMin = Math.min(kmMin, m.km);
                    kmMax = Math.max(kmMax, m.km);
                });
            } else {
                branchMilestones[branchId] = milestones;
            }
        });

        const milestones = [...byKm.values()].sort((a, b) => a.km - b.km);
        if (!Number.isFinite(kmMin)) {
            kmMin = 1.0;
            kmMax = 114.0;
        }

        return { milestones, brakeMarks: allBrakes, kmMin, kmMax, branchMilestones };
    }

    function pathsOnRoute(displayStops) {
        const branches = detectBranches(displayStops);
        const set = new Set();
        branches.forEach((b) => (META[b]?.tracks || []).forEach((t) => set.add(t)));
        return [1, 2, 3, 4, 5, 6].map((p) => set.has(p));
    }

    function branchKmForTitle(title, branchId) {
        const t = normTitle(title);
        if (branchId === 'sof-kras') {
            const map = global.KRASNOARMEYSK_BRANCH_KM;
            if (map && typeof map === 'object') {
                for (const [key, km] of Object.entries(map)) {
                    if (t.includes(String(key).toLowerCase())) return Number(km);
                }
                if (t.includes('дальн') && (t.includes('поселок') || t.includes('мкр'))) {
                    return Number(map['поселок дальний']);
                }
            }
        }
        return null;
    }

    function vmaxOnMainAxis(km, profile) {
        if (km == null || !Number.isFinite(km) || !profile?.milestones?.length) return null;
        let v = profile.milestones[0].vmax;
        for (let i = 0; i < profile.milestones.length; i++) {
            const m = profile.milestones[i];
            if (km + 1e-6 >= m.km) v = m.vmax;
            else break;
        }
        return v;
    }

    function vmaxOnBranchAxis(branchId, km, profile) {
        const list = profile.branchMilestones?.[branchId];
        if (!list?.length || km == null) return null;
        let v = list[0].vmax;
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (km + 1e-6 >= m.km) v = m.vmax;
            else break;
        }
        return v;
    }

    function resolveVmaxForLeg(kmFrom, kmTo, profile, metaFrom, metaTo) {
        if (metaFrom?.branchAxis && metaFrom.branchKm != null) {
            const mid = (Number(metaFrom.branchKm) + Number(metaTo?.branchKm ?? metaFrom.branchKm)) / 2;
            return vmaxOnBranchAxis(metaFrom.branchAxis, mid, profile);
        }
        if (metaTo?.branchAxis && metaTo.branchKm != null && kmFrom == null) {
            return vmaxOnBranchAxis(metaTo.branchAxis, metaTo.branchKm, profile);
        }
        const a = Number(kmFrom);
        const b = Number(kmTo);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return vmaxOnMainAxis((a + b) / 2, profile);
    }

    function stationLimitMeta(title, branches) {
        if (branches.includes('sof-kras')) {
            const bk = branchKmForTitle(title, 'sof-kras');
            if (bk != null) return { branchAxis: 'sof-kras', branchKm: bk };
        }
        if (branches.includes('bol-fryaz-pass')) {
            return { branchAxis: 'bol-fryaz-pass', branchKm: null };
        }
        return null;
    }

    function buildFlightProfile(displayStops, userTrack) {
        const reg = registry();
        if (!Object.keys(reg).length) return null;
        const branches = detectBranches(displayStops);
        const outbound = isOutbound(displayStops);
        const track = userTrack ?? defaultTrack(displayStops, branches);
        const trackByBranch = {};
        branches.forEach((b) => {
            trackByBranch[b] = effectiveTrackForBranch(b, track, outbound);
        });
        const merged = mergeMilestonesForRoute(branches, trackByBranch, reg);
        return {
            id: `yar-flight-${branches.join('+')}-path${track}`,
            pathNum: track,
            pathLabel: `Путь ${track}`,
            edition: global.FLIGHT_SPEED_LIMITS?.edition || '19.11.2026',
            sourceNote: 'МЯЭД',
            branches,
            trackByBranch,
            ...merged,
        };
    }

    global.FlightSpeedRoute = {
        META,
        registry,
        detectBranches,
        defaultTrack,
        effectiveTrackForBranch,
        pathsOnRoute,
        buildFlightProfile,
        vmaxOnMainAxis,
        vmaxOnBranchAxis,
        resolveVmaxForLeg,
        stationLimitMeta,
        branchKmForTitle,
        isMoscowYar,
        isOutbound,
    };
})(typeof window !== 'undefined' ? window : globalThis);