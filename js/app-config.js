window.APP_BUILD_ID = '5.2.2';

window.APP_CONFIG = {
    APP_BUILD_ID: '5.2.2',
    yandexProxy: '',
    yandexClientToken: '',
    webPushVapidPublicKey: 'BPKYfiRk4SLmag3Q4xclEcQB8TkYY-3r-jfzo00lXFjW6JSIDi8-F7MDH72MEIhsLeFSSY62fYlrR-h5-hMVA1A',
    cloudtipsLayoutId: '0c990fdb',
    cloudtipsPaymentUrl: 'https://pay.cloudtips.ru/p/0c990fdb',
    cloudtipsFeeApiUrl: 'https://api.cloudtips.ru/api/payment/fee',
    scheduleMaintenance: false,
    scheduleMaintenanceMessage: 'Ведутся технические работы',
    crewApi: {
        baseUrl: 'https://api.digipom.ru',
        enabled: true
    },
    sheduleMax: {
        s3BaseUrl: '',
        functionUrl: '',
        useCrewDataMirror: true,
        useDirectS3: false,
        preferStopsApi: false,
        preferBoardApi: false,
        threadRev: 14
    }
};

window.daYandexProxyBase = function daYandexProxyBase() {
    return '';
};

window.daBuildProxyFetchInit = function daBuildProxyFetchInit(init = {}) {
    return { ...init };
};

window.daIsYandexProxyUrl = function daIsYandexProxyUrl() {
    return false;
};
