// ==================== CONFIG ====================
const CONFIG = {
    jsonURL: "https://cdn-vn.iof.vn/api/channels/list",
    updateInterval: 30 * 1000,
    maxRetries: 3,
    numberInputTimeout: 1000,
    hlsConfig: {
        // Tối ưu nhẹ + mượt giống IPTV app — TV box thường ít RAM
        enableWorker: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,   // 60 MB
        maxBufferHole: 0.3,
        liveSyncDurationCount: 3,          // ~12s sau live edge
        liveMaxLatencyDurationCount: 8,
        liveDurationInfinity: true,
        abrEwmaDefaultEstimate: 2000000,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        abrBandWidthUpFactor: 0.85,
        abrBandWidthFactor: 0.9,
        startFragPrefetch: true,
        lowLatencyMode: false,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 500,
        nudgeMaxRetry: 5,
        backBufferLength: 10
    }
};

// ==================== GLOBAL STATE ====================
let hlsInstance = null;
let allChannels = [];
let currentChannel = null;
let isFetching = false;
let lastModified = null;
let watchTimer = null;
let _heartbeatTimer = null;
let _heartbeatChannelId = null;
let numberInputBuffer = '';
let numberInputTimeout = null;
let isChangingChannel = false;
let channelURLCache = new Map();
let _m3uMode = false;
const GROUP_ORDER = ['VTV', 'V\u0129nh Long', 'HTV', 'VTVcab', 'SCTV', 'Qu\u1ed1c t\u1ebf', 'Thi\u1ebfu nhi', 'Th\u1ec3 thao', '\u0110\u1ecba ph\u01b0\u01a1ng', 'K\u00eanh Qu\u1ed1c gia'];

// ==================== UTILS ====================
const getVideo = () => document.getElementById('video-player');

// ==================== SITE WATERMARK PROTECTION ====================
// Logo chìm — render bằng canvas overlay, anti-tamper đa lớp
(function() {
    const _wSrc = 'https://cdn-vn.iof.vn/TV/1563x1563_Xemtv.png';
    const _wImg = new Image(); _wImg.crossOrigin = 'anonymous'; _wImg.src = _wSrc;
    let _wCanvas = null, _wCtx = null, _wRAF = null;
    const _wId = '_vc' + Math.random().toString(36).substr(2, 6); // random id mỗi session

    const _wCreate = () => {
        const c = document.getElementById('player-container');
        if (!c) return null;
        const existing = c.querySelector('canvas[data-r="' + _wId + '"]');
        if (existing) return existing;
        const cv = document.createElement('canvas');
        cv.setAttribute('data-r', _wId);
        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:7;opacity:1;';
        c.appendChild(cv);
        return cv;
    };

    const _wDraw = () => {
        if (!_wCanvas || !_wCanvas.parentNode) _wCanvas = _wCreate();
        if (!_wCanvas) return;
        const c = _wCanvas.parentNode;
        const w = c.clientWidth, h = c.clientHeight;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _wCanvas.width = w * dpr; _wCanvas.height = h * dpr;
        _wCanvas.style.width = w + 'px'; _wCanvas.style.height = h + 'px';
        _wCtx = _wCanvas.getContext('2d');
        _wCtx.scale(dpr, dpr);
        _wCtx.clearRect(0, 0, w, h);
        if (_wImg.complete && _wImg.naturalWidth > 0) {
            const sz = Math.max(w * 0.09, 56);
            const x = w - sz - w * 0.03;
            const y = h - sz - h * 0.04;
            _wCtx.globalAlpha = 1.0;
            _wCtx.drawImage(_wImg, x, y, sz, sz);
        }
    };

    const _wLoop = () => { _wDraw(); _wRAF = requestAnimationFrame(_wLoop); };

    // Anti-tamper: kiểm tra mỗi 800ms
    const _wCheck = () => {
        const c = document.getElementById('player-container');
        if (!c) return;
        const cv = c.querySelector('canvas[data-r="' + _wId + '"]');
        const video = document.getElementById('video-player');
        let tampered = false;
        if (!cv) { tampered = true; }
        else {
            const cs = getComputedStyle(cv);
            if (cs.display === 'none' || cs.visibility === 'hidden' ||
                parseFloat(cs.opacity) < 0.3 || cs.zIndex < 1 ||
                cv.width === 0 || cv.height === 0 ||
                cv.style.display === 'none' || cv.style.visibility === 'hidden') {
                tampered = true;
            }
        }
        if (tampered) {
            // Re-tạo canvas
            _wCanvas = _wCreate();
            _wDraw();
            // Pause video tạm 2s rồi play lại (nhắc nhở)
            if (video && !video.paused) {
                video.pause();
                setTimeout(() => { try { video.play(); } catch(e){} }, 2000);
            }
        }
    };

    // MutationObserver: detect childList changes trên player-container
    const _wObserve = () => {
        const c = document.getElementById('player-container');
        if (!c) return;
        const obs = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of m.removedNodes) {
                    if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-r') === _wId) {
                        // Canvas bị xóa → tái tạo ngay
                        _wCanvas = _wCreate();
                        _wDraw();
                    }
                }
            }
        });
        obs.observe(c, { childList: true, subtree: true });
        // Observe attribute changes trên canvas
        const obs2 = new MutationObserver(() => { _wCheck(); });
        if (_wCanvas) obs2.observe(_wCanvas, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    };

    // Override removeChild / remove trên canvas element (chống element.remove())
    const _wProtectElement = (cv) => {
        if (!cv) return;
        const origRemove = cv.remove.bind(cv);
        Object.defineProperty(cv, 'remove', { value: () => { /* no-op */ }, writable: false, configurable: false });
        try {
            const parent = cv.parentNode;
            if (parent) {
                const origRemoveChild = parent.removeChild.bind(parent);
                const wrapped = function(child) {
                    if (child === cv || (child && child.getAttribute && child.getAttribute('data-r') === _wId)) {
                        return child; // block removal
                    }
                    return origRemoveChild(child);
                };
                // Chỉ patch tạm — không gây side effect cho các element khác
                parent.removeChild = wrapped;
            }
        } catch(e) {}
    };

    // Init
    const _wInit = () => {
        _wCanvas = _wCreate();
        if (_wCanvas) {
            _wProtectElement(_wCanvas);
            _wDraw();
            _wLoop();
            _wObserve();
            setInterval(_wCheck, 800);
        }
    };

    // Chờ DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _wInit);
    } else {
        setTimeout(_wInit, 100);
    }

    // Resize → redraw
    window.addEventListener('resize', () => { _wDraw(); });
    document.addEventListener('fullscreenchange', () => setTimeout(_wDraw, 150));
})();
// ==================== END WATERMARK ====================

const hasValidURL = (ch) => !!(ch.URL || ch.playlist || ch.src || ch.mytvDrm || ch.drm || ch.channelId);
const getChannelURL = (ch) => {
    if (channelURLCache.has(ch.name)) return channelURLCache.get(ch.name);
    const url = ch.src || ch.URL || ch.playlist || '';
    channelURLCache.set(ch.name, url);
    return url;
};
const clearChannelCache = () => channelURLCache.clear();

// ==================== STORAGE ====================
const getFavorites = () => { try { return JSON.parse(localStorage.getItem('favoriteChannels') || '[]'); } catch { return []; } };
const saveFavorites = (f) => localStorage.setItem('favoriteChannels', JSON.stringify(f));
const isFavorite = (name) => getFavorites().some(c => c.name === name);
const toggleFavorite = (event, channel) => {
    event.stopPropagation();
    const favs = getFavorites();
    const isFav = isFavorite(channel.name);
    saveFavorites(isFav ? favs.filter(c => c.name !== channel.name) : [...favs, channel]);
    if (isPickerVisible()) renderPickerChannels();
};

// ==================== HEARTBEAT ====================
const _heartbeatApiBase = () => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(location.origin)
    ? location.origin : 'https://cdn-vn.iof.vn';
const _heartbeatSid = 'tv_' + Math.random().toString(36).substr(2, 10) + Date.now().toString(36);
const _updateViewerCount = (count) => {
    const el = document.getElementById('tib-viewers');
    if (!el) return;
    if (count && count > 1) { el.textContent = '👁 ' + count + ' người xem'; el.style.display = ''; }
    else el.style.display = 'none';
};
const startHeartbeat = (ch) => {
    stopHeartbeat();
    if (!ch || !ch.channelId) return;
    _heartbeatChannelId = ch.channelId;
    const send = () => fetch(_heartbeatApiBase() + '/heartbeat/' + ch.channelId + '?sid=' + _heartbeatSid)
        .then(r => r.json()).then(d => { if (d && d.viewers != null) _updateViewerCount(d.viewers); }).catch(() => {});
    send();
    _heartbeatTimer = setInterval(send, 15000);
};
const stopHeartbeat = () => {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    if (_heartbeatChannelId) {
        const url = _heartbeatApiBase() + '/leave/' + _heartbeatChannelId + '?sid=' + _heartbeatSid;
        try { navigator.sendBeacon(url); } catch(e) { fetch(url).catch(() => {}); }
    }
    _heartbeatChannelId = null;
};

// ==================== AUTO FAV ====================
const startWatchTimer = (ch) => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        if (!isFavorite(ch.name)) { saveFavorites([...getFavorites(), ch]); renderFavorites(); }
    }, 60000);
};

// ==================== OVERLAY ====================
const showBufferingOverlay = (show, label, logoUrl) => {
    label = label || '\u0110ang t\u1ea3i...';
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('buffer-overlay');
    if (show) {
        if (!ov) { ov = document.createElement('div'); ov.id = 'buffer-overlay'; container.appendChild(ov); }
        ov.innerHTML = (logoUrl ? '<img class="buffer-channel-logo" src="' + logoUrl + '" alt="" onerror="this.style.display=\'none\'">' : '') +
            '<div class="buffer-spinner"></div><p>' + label + '</p>';
        ov.style.display = 'flex';
    } else if (ov) {
        ov.style.display = 'none';
    }
};
const showError = (msg, retryFn) => {
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('buffer-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'buffer-overlay'; container.appendChild(ov); }
    ov.innerHTML = '<i class="fas fa-exclamation-circle" style="font-size:48px;color:#ff3d00;margin-bottom:12px"></i><p>' + msg + '</p>' +
        (retryFn ? '<button class="retry-btn" style="margin-top:12px;background:#ff3d00;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:1rem;cursor:pointer">Th\u1eed l\u1ea1i</button>' : '');
    ov.style.display = 'flex';
    if (retryFn) ov.querySelector('.retry-btn').addEventListener('click', retryFn);
};

// ==================== TOAST ====================
let _toastTimer = null;
const showToast = (msg, type, duration) => {
    type = type || 'warn';
    duration = duration || 4000;
    let box = document.getElementById('stream-toast');
    if (!box) { box = document.createElement('div'); box.id = 'stream-toast'; document.body.appendChild(box); }
    const icon = type === 'error' ? 'fa-circle-xmark' : type === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation';
    const cls = 'stream-toast show ' + type;
    box.className = cls;
    box.innerHTML = '<i class="fas ' + icon + '"></i> ' + msg;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { box.classList.remove('show'); }, duration);
};

// ==================== HLS PLAYER ====================
let _playingHandler = null;
let _waitingHandler = null;
let _canplayHandler = null;

const clearVideoListeners = () => {
    const v = getVideo();
    if (!v) return;
    if (_playingHandler) { v.removeEventListener('playing', _playingHandler); _playingHandler = null; }
    if (_waitingHandler) { v.removeEventListener('waiting', _waitingHandler); _waitingHandler = null; }
    if (_canplayHandler) { v.removeEventListener('canplay', _canplayHandler); _canplayHandler = null; }
};

const destroyHls = () => {
    clearVideoListeners();
    if (hlsInstance) { try { hlsInstance.destroy(); } catch(e) {} hlsInstance = null; }
    destroyShakaPlayer();
    const v = getVideo();
    if (v) { v.pause(); }
};

const playChannelDirect = (channel, retryCount) => {
    retryCount = retryCount || 0;
    const url = getChannelURL(channel);
    if (!url) { showError('K\u00eanh kh\u00f4ng c\u00f3 \u0111\u01b0\u1eddng d\u1eabn.'); return; }
    const video = getVideo();
    if (!video) return;
    destroyHls();
    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);

    video.muted = true;
    video.volume = 0.9;

    _playingHandler = () => {
        const v = getVideo();
        if (_playingHandler && v) v.removeEventListener('playing', _playingHandler);
        _playingHandler = null;
        showBufferingOverlay(false);
        updateChannelInfoBar(channel);
        video.muted = false;
    };
    _waitingHandler = () => showBufferingOverlay(true, '\u0110ang t\u1ea3i...', channel.logo);
    _canplayHandler = () => showBufferingOverlay(false);
    video.addEventListener('playing', _playingHandler);
    video.addEventListener('waiting', _waitingHandler);
    video.addEventListener('canplay', _canplayHandler);

    if (typeof Hls !== 'undefined' && Hls.isSupported() && !_isIOS) {
        hlsInstance = new Hls(CONFIG.hlsConfig);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => {
            hlsInstance.loadSource(url);
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            video.muted = true;
            const tryPlay = (attempt) => {
                video.muted = true;
                video.play().catch((e) => {
                    console.warn('play() b\u1ecb ch\u1eb7n (l\u1ea7n ' + attempt + '):', e && e.message);
                    if (attempt < 4) setTimeout(() => tryPlay(attempt + 1), 600);
                    else {
                        showBufferingOverlay(false);
                        updateChannelInfoBar(channel);
                    }
                });
            };
            tryPlay(1);
        });
        let _fragErrCount = 0, _fragErrTimer = null;
        hlsInstance.on(Hls.Events.ERROR, (ev, data) => {
            if (!data.fatal) {
                if (data.details === 'fragLoadError' || data.details === 'fragLoadTimeOut') {
                    const status = data.response ? data.response.code : 0;
                    if (status === 404) {
                        const live = hlsInstance.liveSyncPosition;
                        if (live) {
                            video.currentTime = live;
                            hlsInstance.startLoad(live);
                        }
                        _fragErrCount = 0;
                        return;
                    }
                    _fragErrCount++;
                    clearTimeout(_fragErrTimer);
                    _fragErrTimer = setTimeout(() => { _fragErrCount = 0; }, 10000);
                    if (_fragErrCount >= 3) {
                        const live = hlsInstance.liveSyncPosition;
                        if (live && video.currentTime < live - 2) video.currentTime = live;
                        _fragErrCount = 0;
                    }
                } else if (data.details === 'levelLoadError') {
                    const live = hlsInstance.liveSyncPosition;
                    if (live && video.currentTime < live - 2) video.currentTime = live;
                }
                return;
            }
            // Fatal errors
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                showToast('L\u1ed7i m\u1ea1ng \u2013 \u0111ang k\u1ebft n\u1ed1i l\u1ea1i...', 'error');
                hlsInstance.startLoad();
                const live = hlsInstance.liveSyncPosition;
                if (live) video.currentTime = live;
                setTimeout(() => {
                    if (retryCount < CONFIG.maxRetries) playChannelDirect(channel, retryCount + 1);
                    else showError('Kh\u00f4ng th\u1ec3 ph\u00e1t k\u00eanh.', () => playChannelDirect(channel));
                }, 3000);
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                showToast('L\u1ed7i media \u2013 \u0111ang kh\u00f4i ph\u1ee5c...', 'error');
                try { hlsInstance.recoverMediaError(); } catch(e) {}
                setTimeout(() => {
                    if (video.paused && retryCount < CONFIG.maxRetries) playChannelDirect(channel, retryCount + 1);
                }, 3000);
            } else {
                if (retryCount < CONFIG.maxRetries) setTimeout(() => playChannelDirect(channel, retryCount + 1), 2000);
                else showError('Kh\u00f4ng th\u1ec3 ph\u00e1t k\u00eanh.', () => playChannelDirect(channel));
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => { setTimeout(() => video.play().catch(() => {}), 500); });
    } else {
        showError('Tr\u00ecnh duy\u1ec7t kh\u00f4ng h\u1ed7 tr\u1ee3 HLS.');
    }
};

// ==================== UNMUTE ====================
const showUnmuteHint = () => {};
const hideUnmuteHint = () => {};
const unmutePlayer = () => { const v = getVideo(); if (v) { v.muted = false; v.volume = 0.9; } };

// ==================== SHAKA / MyTV DRM ====================
let _shakaPlayer = null;
let _mytvDrmCustomData = null;
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const _obfEncode = (str) => {
    const key = 'xTv2026sEg';
    const enc = new TextEncoder();
    const buf = enc.encode(str);
    const k   = enc.encode(key);
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
    let b64 = btoa(String.fromCharCode(...out));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const destroyShakaPlayer = () => {
    if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(e) {} _shakaPlayer = null; }
};

const destroyHlsAndShaka = () => {
    clearVideoListeners();
    if (hlsInstance) { try { hlsInstance.destroy(); } catch(e) {} hlsInstance = null; }
    destroyShakaPlayer();
    const v = getVideo();
    if (v) v.pause();
};

// Ghi d� destroyHls d? cung h?y Shaka
const _origDestroyHls = destroyHls;

const playMytvDrmChannel = (channel) => {
    // iOS/macOS Safari không hỗ trợ Widevine → fallback sang m3u8 (qua drm_relay.py)
    if (_isIOS || _isSafari) {
        playChannelDirect(channel);
        return;
    }
    const video = getVideo();
    if (!video) return;
    destroyHlsAndShaka();
    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
    video.muted = true;

    const abort = new AbortController();
    const apiBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(location.origin)
        ? location.origin : 'https://cdn-vn.iof.vn';
    const segProxy = (url) => {
        if (!url || url.includes('/seg?')) return url;
        const cdnMatch = url.match(/^https?:\/\/cdn-vn\.iof\.vn\/cdn\/(.+)/);
        if (cdnMatch) return apiBase + '/seg?e=' + _obfEncode('https://' + cdnMatch[1]);
        if (!url.includes('mytvnet') && !url.includes('mytv')) return url;
        if (url.startsWith(apiBase)) return url;
        return apiBase + '/seg?e=' + _obfEncode(url);
    };

    const rawId  = (channel.channelId || '').replace(/^mytv_/, '');
    const apiUrl = apiBase + '/api/mytv-stream/' + rawId;

    (async () => {
        const _start = Date.now();
        while (!abort.signal.aborted) {
            try {
                const r = await fetch(apiUrl, { signal: abort.signal });
                const data = await r.json();
                if (abort.signal.aborted) return;
                if (!data.ok || !data.mpdProxy) {
                    if (Date.now() - _start > 120000) break;
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    await new Promise(resolve => {
                        _drmStreamReadyCallbacks.set(rawId, resolve);
                        setTimeout(() => { _drmStreamReadyCallbacks.delete(rawId); resolve(); }, 30000);
                        if (abort.signal) abort.signal.addEventListener('abort', () => {
                            _drmStreamReadyCallbacks.delete(rawId); resolve();
                        }, { once: true });
                    });
                    continue;
                }
                if (abort.signal.aborted) return;

                shaka.polyfill.installAll();
                if (!shaka.Player.isBrowserSupported()) {
                    showError('Trình duyệt không hỗ trợ DASH/DRM.'); return;
                }

                destroyShakaPlayer();
                _shakaPlayer = new shaka.Player();
                await _shakaPlayer.attach(video);
                _shakaPlayer.addEventListener('error', (e) => {
                    if (abort.signal.aborted) return;
                    const code = e.detail && e.detail.code;
                    if (code === 1001) {
                        try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = Math.max(sr.start, sr.end - 10); } catch(ex) {}
                        return;
                    }
                    console.warn('[TV MyTV DRM]', e.detail);
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    const delay = (code === 6007) ? 8000 : 4000;
                    if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(_) {} _shakaPlayer = null; }
                    setTimeout(() => { if (!abort.signal.aborted) playMytvDrmChannel(channel); }, delay);
                });

                _shakaPlayer.getNetworkingEngine().registerRequestFilter((type, req) => {
                    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
                        if (_mytvDrmCustomData) req.headers['x-dt-custom-data'] = _mytvDrmCustomData;
                        return;
                    }
                    req.uris[0] = segProxy(req.uris[0]);
                    delete req.headers['Range'];
                });

                _shakaPlayer.getNetworkingEngine().registerResponseFilter((type, resp) => {
                    if (type !== shaka.net.NetworkingEngine.RequestType.LICENSE) return;
                    try {
                        const txt = new TextDecoder().decode(resp.data);
                        if (txt.startsWith('{')) {
                            const j = JSON.parse(txt);
                            if (j.license) {
                                const bin = atob(j.license);
                                const arr = new Uint8Array(bin.length);
                                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                                resp.data = arr.buffer;
                            }
                        }
                    } catch(e) {}
                });

                const mpdUrl = apiBase + data.mpdProxy;
                const licUrl = data.licenseProxy ? apiBase + data.licenseProxy : null;

                if (licUrl) {
                    _shakaPlayer.configure({
                        drm: {
                            servers: {
                                'com.widevine.alpha': licUrl,
                                'com.microsoft.playready': licUrl
                            },
                            advanced: {
                                'com.widevine.alpha': { audioRobustness: ['SW_SECURE_CRYPTO'], videoRobustness: ['SW_SECURE_CRYPTO'] },
                                'com.microsoft.playready': { audioRobustness: [], videoRobustness: [] }
                            }
                        }
                    });
                }
                _shakaPlayer.configure({
                    drm: { retryParameters: { maxAttempts: 1, baseDelay: 500, fuzzFactor: 0 } },
                    streaming: { bufferingGoal: 6, rebufferingGoal: 2, stallEnabled: true, stallThreshold: 1,
                        retryParameters: { maxAttempts: 4, baseDelay: 500, fuzzFactor: 0.3 } },
                    manifest: { retryParameters: { maxAttempts: 4, baseDelay: 500, fuzzFactor: 0.5 },
                        dash: { ignoreSuggestedPresentationDelay: false } }
                });

                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                await _shakaPlayer.load(mpdUrl);
                if (abort.signal.aborted) return;

                try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = sr.end; } catch(e) {}

                _playingHandler = () => { showBufferingOverlay(false); updateChannelInfoBar(channel); video.muted = false; };
                _waitingHandler = () => { if (!abort.signal.aborted) showBufferingOverlay(true, 'Đang kết nối...', channel.logo); };
                video.addEventListener('playing', _playingHandler);
                video.addEventListener('waiting', _waitingHandler);

                video.muted = true;
                const _tryPlay = (n) => {
                    if (abort.signal.aborted || !_shakaPlayer) return;
                    video.play().catch(() => { if (n < 5) setTimeout(() => _tryPlay(n + 1), 800); });
                };
                _tryPlay(1);
                return;
            } catch(e) {
                if (abort.signal.aborted) return;
                if (Date.now() - _start > 120000) break;
                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                await new Promise(resolve => {
                    _drmStreamReadyCallbacks.set(rawId, resolve);
                    setTimeout(() => { _drmStreamReadyCallbacks.delete(rawId); resolve(); }, 30000);
                    if (abort.signal) abort.signal.addEventListener('abort', () => {
                        _drmStreamReadyCallbacks.delete(rawId); resolve();
                    }, { once: true });
                });
            }
        }
        _drmStreamReadyCallbacks.delete(rawId);
        if (!abort.signal.aborted) playMytvDrmChannel(channel);
    })();
};

// ==================== INFO BAR ====================
const _fmtTimeTv = (unix) => {
    const d = new Date(unix * 1000);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
};

let _tvEpgTimer = null;
const _updateTibProgram = (programs) => {
    const el = document.getElementById('tib-program');
    if (!el) return;
    const now = Math.floor(Date.now() / 1000);
    const cur = programs.find(p => p.startTime <= now && p.endTime > now);
    if (cur) {
        const pct = Math.round(((now - cur.startTime) / (cur.endTime - cur.startTime)) * 100);
        el.textContent = '▶ ' + cur.title + '  ' + _fmtTimeTv(cur.startTime) + '–' + _fmtTimeTv(cur.endTime) + ' (' + pct + '%)';
    } else {
        el.textContent = 'Đang phát trực tiếp';
    }
};

const fetchEpgForTv = (ch) => {
    clearInterval(_tvEpgTimer);
    const el = document.getElementById('tib-program');
    if (el) el.textContent = 'Đang phát trực tiếp';
    const channelId = ch.channelId;
    if (!channelId) return;
    const isFptOrMytv = channelId.startsWith('fpt_') || channelId.startsWith('mytv_');
    if (!isFptOrMytv && !ch.epgMytvId) return;
    const now = new Date();
    const d2 = new Date(now); d2.setDate(d2.getDate() - 1);
    const dateStr = d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0');
    fetch(_remoteApiBase + '/api/epg/' + encodeURIComponent(channelId) + '?date=' + dateStr + '&days=3',
          { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(data => {
            if (!data.programs || !data.programs.length) return;
            const programs = data.programs;
            _updateTibProgram(programs);
            // Cập nhật lại mỗi 30s
            _tvEpgTimer = setInterval(() => _updateTibProgram(programs), 30000);
        })
        .catch(() => {});
};

const updateChannelInfoBar = (ch) => {
    document.title = (ch.TV || ch.name) + ' | XEMTV.VN';
    const bar = document.getElementById('current-channel-info');
    if (bar) bar.innerHTML = '<img src="' + ch.logo + '" alt="' + (ch.TV || ch.name) + '" onerror="this.src=\'https://via.placeholder.com/48\'"><div><h2>' + (ch.TV || ch.name) + '</h2><p>\u0110ang ph\u00e1t tr\u1ef1c ti\u1ebfp</p></div>';
    // Cập nhật TV info bar
    const tibLogo = document.getElementById('tib-logo');
    const tibName = document.getElementById('tib-chname');
    const tibNum  = document.getElementById('tib-chnum');
    if (tibLogo) { tibLogo.src = ch.logo || ''; tibLogo.alt = ch.TV || ch.name; }
    if (tibName) tibName.textContent = ch.TV || ch.name;
    const chIdx = allChannels.filter(hasValidURL).findIndex(c => c.name === ch.name);
    if (tibNum) tibNum.textContent = chIdx >= 0 ? 'Kênh ' + (chIdx + 1) : '--';

    // Fetch EPG lấy chương trình đang phát
    fetchEpgForTv(ch);
};

// ==================== SELECT ====================
const selectChannel = (channel) => {
    if (isChangingChannel) return;
    isChangingChannel = true;
    const ch = allChannels.find(c => c.name === channel.name) || channel;
    currentChannel = ch;
    localStorage.setItem('lastChannel', JSON.stringify({ name: ch.name, TV: ch.TV }));
    showBufferingOverlay(true, 'Đang kết nối...', ch.logo);
    // Luôn dùng m3u8 (HLS) — drm_relay.py đã tạo sẵn file .m3u8 cho kênh DRM
    playChannelDirect(ch);
    updateChannelInfoBar(ch);
    startHeartbeat(ch);
    startWatchTimer(ch);
    showInfoBar(5000);
    isChangingChannel = false;
    // Push trạng thái kênh tới phone remote
    _pushTvStateToPhone();
};

const setupTVNavigation = () => {
    window.addEventListener('keydown', (e) => {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const k = e.keyCode;
        const isEnter = k === 13 || k === 23;                                        // Enter, Android DPAD_CENTER
        const isDown  = k === 40;
        const isUp    = k === 38;
        const isLeft  = k === 37;
        const isRight = k === 39;
        const isBack  = k === 27 || k === 8 || k === 10009 || k === 461;             // ESC/BS/Samsung Back/LG Back
        const isCHup   = k === 33 || k === 427 || k === 166;                        // PageUp / Samsung CH+ / Android CH+
        const isCHdown = k === 34 || k === 428 || k === 167;                        // PageDown / Samsung CH- / Android CH-
        const isPlayPause = k === 32 || k === 179 || k === 415 || k === 19 || k === 10252; // Space/MediaPlayPause
        if (isEnter || isDown || isUp || isLeft || isRight || isBack || isCHup || isCHdown || isPlayPause) e.preventDefault();

        // Đóng Remote Pairing Overlay bằng bất kỳ phím nào
        const rpoOv = document.getElementById('remote-pairing-overlay');
        if (rpoOv && !rpoOv.classList.contains('rpo-hidden')) {
            rpoOv.classList.add('rpo-hidden');
            // Reset focus về kênh cuối danh sách
            const remBtn = document.querySelector('.picker-remote-btn');
            if (remBtn) remBtn.classList.remove('picker-tab-focused');
            const items = pickerGetItems();
            if (items.length) pickerFocusItem(items.length - 1);
            else pickerFocusTab();
            return;
        }

        // === CH+ / CH- === (h? tr? c? khi picker dang m?)
        if (isCHup)   { hideChannelPicker(); channelUp();   showInfoBar(5000); return; }
        if (isCHdown) { hideChannelPicker(); channelDown(); showInfoBar(5000); return; }

        // === Play/Pause ===
        if (isPlayPause) { const v = getVideo(); if (v) { if (v.paused) v.play().catch(()=>{}); else v.pause(); } return; }

        // === Picker dang m?: di?u hu?ng trong picker ===
        if (isPickerVisible()) {
            const isSide = document.body.classList.contains('picker-sidebar-mode');
            if (pickerTabFocus) {
                if (isLeft)  { pickerSwitchTab(-1); if (isSide) resetPickerSidebarTimer(); }
                else if (isRight) { pickerSwitchTab(1); if (isSide) resetPickerSidebarTimer(); }
                else if (isDown || isEnter) { pickerFocusItem(0); if (isSide) resetPickerSidebarTimer(); }
                else if (isUp) {
                    // Focus nút Kết nối Remote
                    const remBtn = document.querySelector('.picker-remote-btn');
                    if (remBtn) { pickerTabFocus = false; remBtn.focus(); remBtn.classList.add('picker-tab-focused'); }
                }
                else if (isBack) { if (currentChannel) hideChannelPicker(); }
            } else {
                // Check nếu đang focus nút Remote → Enter mở, Down quay lại tab
                const remBtn = document.querySelector('.picker-remote-btn');
                const isRemFocused = remBtn && (document.activeElement === remBtn || remBtn.classList.contains('picker-tab-focused'));
                if (isRemFocused) {
                    // Bất kỳ phím nào → quay lại danh sách kênh
                    remBtn.classList.remove('picker-tab-focused');
                    const items = pickerGetItems();
                    if (items.length) pickerFocusItem(items.length - 1);
                    else pickerFocusTab();
                } else if (isDown) {
                    const items = pickerGetItems();
                    const cols = _getPickerGridCols();
                    const next = pickerFocusIndex + cols;
                    if (next < items.length) pickerFocusItem(next);
                    else {
                        // Cuối danh sách → mở QR Remote luôn
                        showRemotePairingOverlay();
                    }
                    if (isSide) resetPickerSidebarTimer();
                } else if (isUp) {
                    const cols = _getPickerGridCols();
                    const prev = pickerFocusIndex - cols;
                    if (prev >= 0) pickerFocusItem(prev);
                    else pickerFocusTab();
                    if (isSide) resetPickerSidebarTimer();
                } else if (isLeft) {
                    if (isSide) { pickerSwitchTab(-1); resetPickerSidebarTimer(); }
                    else if (pickerFocusIndex > 0) pickerFocusItem(pickerFocusIndex - 1);
                } else if (isRight) {
                    if (isSide) { pickerSwitchTab(1); resetPickerSidebarTimer(); }
                    else {
                        const items = pickerGetItems();
                        if (pickerFocusIndex < items.length - 1) pickerFocusItem(pickerFocusIndex + 1);
                    }
                } else if (isEnter) {
                    const items = pickerGetItems();
                    if (items[pickerFocusIndex]) items[pickerFocusIndex].click();
                } else if (isBack) {
                    if (currentChannel) hideChannelPicker();
                }
            }
            return;
        }

        const hint = document.getElementById('unmute-hint');
        if (isEnter && hint && hint.style.display === 'block') { unmutePlayer(); return; }

        if (isRight) {
            if (currentChannel) showChannelPicker(true);
        } else if (isBack) {
            hideChannelPicker();
        }

        // Hi?n info bar khi nh?n ph�m di?u hu?ng
        if (isUp || isDown || isLeft || isRight) showInfoBar(4000);

        const numMap = {Digit0:'0',Digit1:'1',Digit2:'2',Digit3:'3',Digit4:'4',Digit5:'5',Digit6:'6',Digit7:'7',Digit8:'8',Digit9:'9',Numpad0:'0',Numpad1:'1',Numpad2:'2',Numpad3:'3',Numpad4:'4',Numpad5:'5',Numpad6:'6',Numpad7:'7',Numpad8:'8',Numpad9:'9'};
        if (numMap[e.code]) handleNumberInput(numMap[e.code]);
    }, true);
};

// ==================== NUMBER INPUT ====================
const handleNumberInput = (num) => {
    clearTimeout(numberInputTimeout);
    numberInputBuffer += num;
    let fb = document.getElementById('number-input-feedback');
    if (!fb) { fb = document.createElement('div'); fb.id = 'number-input-feedback'; document.body.appendChild(fb); }
    fb.textContent = numberInputBuffer;
    fb.style.display = 'block';
    numberInputTimeout = setTimeout(() => {
        const idx = parseInt(numberInputBuffer) - 1;
        if (idx >= 0 && idx < allChannels.length) selectChannel(allChannels[idx]);
        numberInputBuffer = '';
        fb.style.display = 'none';
    }, CONFIG.numberInputTimeout);
};

// ==================== CHANNEL PICKER ====================
let pickerActiveTab = '';
let pickerFocusIndex = 0;
let pickerTabFocus = false; // true = focus dang ? tab bar, false = focus ? danh s�ch k�nh

const isPickerVisible = () => { const p = document.getElementById('channel-picker-overlay'); return !!(p && p.style.display !== 'none'); };

const showChannelPicker = (sideMode) => {
    let picker = document.getElementById('channel-picker-overlay');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'channel-picker-overlay';
        picker.innerHTML = '<div class="picker-inner"><div class="picker-header"><h1><img src="/Image_WEB/xemtv_logo.png" alt="XemTV" style="height:36px;vertical-align:middle;margin-right:10px" onerror="this.style.display=\'none\'"> Ch\u1ecdn k\u00eanh \u0111\u1ec3 xem</h1></div><div id="picker-tab-bar" class="picker-tab-bar"></div><div id="picker-grid" class="picker-grid"></div><div style="text-align:center;padding:20px 0"><button class="picker-remote-btn" tabindex="0" onclick="showRemotePairingOverlay()"><i class="fas fa-mobile-alt"></i> K\u1ebft n\u1ed1i Remote</button></div></div>';
        document.body.appendChild(picker);
    }
    // Chế độ M3U: ẩn nút Remote (cần backend), hiện nút Đổi playlist
    if (_m3uMode && picker) {
        const remBtn = picker.querySelector('.picker-remote-btn');
        if (remBtn) {
            remBtn.style.display = 'none';
            if (!picker.querySelector('.picker-m3u-btn')) {
                const b = document.createElement('button');
                b.className = 'picker-remote-btn picker-m3u-btn';
                b.tabIndex = 0;
                b.innerHTML = '<i class="fas fa-list-ul"></i> \u0110\u1ed5i playlist';
                b.onclick = () => { hideChannelPicker(); showM3uEntry(); };
                remBtn.parentNode.appendChild(b);
            }
        }
    }
    if (sideMode) document.body.classList.add('picker-sidebar-mode');
    else document.body.classList.remove('picker-sidebar-mode');
    // Focus v�o k�nh dang xem
    if (sideMode && currentChannel) {
        const tabChannels = allChannels.filter(ch => hasValidURL(ch) && (() => {
            const g = ch.group || '�?a phuong';
            return g === pickerActiveTab || (!GROUP_ORDER.includes(g) && pickerActiveTab === 'Kh�c');
        })());
        const idx = tabChannels.findIndex(c => c.name === currentChannel.name);
        pickerFocusIndex = idx >= 0 ? idx : 0;
    } else {
        pickerFocusIndex = 0;
    }
    picker.style.display = 'flex';
    renderPickerChannels();
    if (sideMode) resetPickerSidebarTimer();
    if (sideMode && currentChannel) {
        setTimeout(() => {
            const focused = document.querySelector('.picker-list-item.picker-focused');
            if (focused) focused.scrollIntoView({ block: 'center', behavior: 'auto' });
        }, 30);
    }
};

const hideChannelPicker = () => {
    clearTimeout(pickerSidebarHideTimer);
    const picker = document.getElementById('channel-picker-overlay');
    if (picker) picker.style.display = 'none';
    document.body.classList.remove('picker-sidebar-mode');
};

let pickerSidebarHideTimer = null;
const PICKER_SIDEBAR_TIMEOUT = 5000;

const resetPickerSidebarTimer = () => {
    if (!document.body.classList.contains('picker-sidebar-mode')) return;
    clearTimeout(pickerSidebarHideTimer);
    pickerSidebarHideTimer = setTimeout(() => hideChannelPicker(), PICKER_SIDEBAR_TIMEOUT);
};
const pickerGetItems = () => Array.from(document.querySelectorAll('#picker-grid .picker-item, #picker-grid .picker-list-item'));
const _getPickerGridCols = () => {
    const grid = document.getElementById('picker-grid');
    if (!grid) return 1;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return cols || 1;
};

const pickerFocusItem = (index) => {
    const items = pickerGetItems();
    if (!items.length) return;
    items.forEach(el => el.classList.remove('picker-focused'));
    document.querySelectorAll('.picker-tab-btn').forEach(el => el.classList.remove('picker-tab-focused'));
    pickerTabFocus = false;
    pickerFocusIndex = ((index % items.length) + items.length) % items.length;
    items[pickerFocusIndex].classList.add('picker-focused');
    items[pickerFocusIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Preview thông tin kênh được focus
    const ch = _pickerItemToChannel(pickerFocusIndex);
    if (ch) _previewChannelInfo(ch);
};

// Lấy channel object tương ứng với vị trí focus trong picker
// Nhóm kênh cho picker. Ở chế độ M3U: nhóm động theo group-title + tab "Tất cả".
const _buildPickerGroups = () => {
    const channels = allChannels.filter(hasValidURL);
    const groups = {};
    let keys;
    if (_m3uMode) {
        groups['Tất cả'] = channels;
        const order = [];
        channels.forEach(c => {
            const g = (c.group || '').trim() || 'Khác';
            if (!groups[g]) { groups[g] = []; order.push(g); }
            groups[g].push(c);
        });
        keys = ['Tất cả', ...order];
    } else {
        GROUP_ORDER.forEach(g => { const items = channels.filter(c => (c.group || 'Địa phương') === g); if (items.length) groups[g] = items; });
        const ungrouped = channels.filter(c => !GROUP_ORDER.includes(c.group || 'Địa phương'));
        if (ungrouped.length) groups['Khác'] = ungrouped;
        keys = [...GROUP_ORDER.filter(g => groups[g]), ...(groups['Khác'] ? ['Khác'] : [])];
    }
    return { groups, keys };
};
const _pickerItemToChannel = (index) => {
    const { groups } = _buildPickerGroups();
    return (groups[pickerActiveTab] || [])[index] || null;
};

let _previewEpgTimer = null;
const _previewChannelInfo = (ch) => {
    // Cập nhật tib-logo, tib-chname, tib-chnum ngay lập tức
    const tibLogo = document.getElementById('tib-logo');
    const tibName = document.getElementById('tib-chname');
    const tibNum  = document.getElementById('tib-chnum');
    const tibProg = document.getElementById('tib-program');
    if (tibLogo) { tibLogo.src = ch.logo || ''; tibLogo.alt = ch.TV || ch.name; }
    if (tibName) tibName.textContent = ch.TV || ch.name;
    const chIdx = allChannels.filter(hasValidURL).findIndex(c => c.name === ch.name);
    if (tibNum) tibNum.textContent = chIdx >= 0 ? 'Kênh ' + (chIdx + 1) : '--';
    if (tibProg) tibProg.textContent = 'Đang phát trực tiếp';
    showInfoBar(4000);
    // Fetch EPG với debounce 400ms (tránh gọi quá nhiều khi scroll nhanh)
    clearTimeout(_previewEpgTimer);
    _previewEpgTimer = setTimeout(() => fetchEpgForTv(ch), 400);
};

const pickerFocusTab = () => {
    pickerTabFocus = true;
    pickerGetItems().forEach(el => el.classList.remove('picker-focused'));
    const tabs = Array.from(document.querySelectorAll('.picker-tab-btn'));
    tabs.forEach(el => el.classList.remove('picker-tab-focused'));
    const active = tabs.find(t => t.classList.contains('active'));
    if (active) { active.classList.add('picker-tab-focused'); active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
};

const pickerSwitchTab = (dir) => {
    const tabs = Array.from(document.querySelectorAll('.picker-tab-btn'));
    const idx = tabs.findIndex(t => t.classList.contains('active'));
    const next = ((idx + dir + tabs.length) % tabs.length);
    tabs[next] && tabs[next].click();
};

const renderPickerChannels = () => {
    const isSide = document.body.classList.contains('picker-sidebar-mode');
    const { groups, keys } = _buildPickerGroups();
    if (!pickerActiveTab || !groups[pickerActiveTab]) pickerActiveTab = keys[0];
    const tabBar = document.getElementById('picker-tab-bar');
    const grid = document.getElementById('picker-grid');
    if (!tabBar || !grid) return;
    tabBar.innerHTML = '';
    keys.forEach(g => {
        const btn = document.createElement('button');
        btn.className = 'picker-tab-btn' + (g === pickerActiveTab ? ' active' : '');
        btn.textContent = g;
        btn.addEventListener('click', () => { pickerActiveTab = g; pickerFocusIndex = 0; pickerTabFocus = false; renderPickerChannels(); });
        tabBar.appendChild(btn);
    });
    grid.innerHTML = '';
    grid.className = isSide ? 'picker-list' : 'picker-grid';
    (groups[pickerActiveTab] || []).forEach((ch, i) => {
        const globalIdx = allChannels.indexOf(ch);
        const isFav = isFavorite(ch.name);
        const item = document.createElement('div');
        if (isSide) {
            item.className = 'picker-list-item' + (i === pickerFocusIndex ? ' picker-focused' : '') + (currentChannel && currentChannel.name === ch.name ? ' picker-active' : '');
            item.innerHTML =
                '<span class="picker-list-num">' + (globalIdx + 1) + '</span>' +
                '<img src="' + ch.logo + '" alt="" onerror="this.src=\'https://via.placeholder.com/40\'">' +
                '<span class="picker-list-name">' + (ch.TV || ch.name) + '</span>' +
                '<button class="fav-btn ' + (isFav ? 'favorited' : '') + '" tabindex="-1"><i class="fas ' + (isFav ? 'fa-heart' : 'fa-plus') + '"></i></button>';
            item.querySelector('.fav-btn').addEventListener('click', e => { toggleFavorite(e, ch); });
        } else {
            item.className = 'picker-item' + (i === pickerFocusIndex ? ' picker-focused' : '');
            item.innerHTML = '<div class="picker-num">' + (globalIdx + 1) + '</div>' +
                '<img src="' + ch.logo + '" alt="' + (ch.TV || ch.name) + '" onerror="this.src=\'https://via.placeholder.com/60\'">' +
                '<div class="picker-name">' + (ch.TV || ch.name) + '</div>';
        }
        item.addEventListener('click', e => { if (!e.target.closest('.fav-btn')) { hideChannelPicker(); selectChannel(ch); } });
        grid.appendChild(item);
    });
};

// Set MyTV DRM IDs (k�nh qu?c t? MyTV d�ng DASH+Widevine)
const DRM_MYTV_IDS = new Set([
    208, 203, 441, 415, 745,
    632, 633,
    589, 590, 592, 593, 594, 595, 596, 597, 598,
    553, 739,
]);

// ==================== FETCH ====================
const applyChannelData = (data) => {
    allChannels = data.map(ch => {
        // ��nh d?u k�nh MyTV DRM
        if (ch.channelId && ch.channelId.startsWith('mytv_')) {
            const rid = parseInt(ch.channelId.replace('mytv_', ''));
            if (DRM_MYTV_IDS.has(rid)) ch.mytvDrm = true;
        }
        if (ch.drm) ch.mytvDrm = true;
        return ch;
    }).filter(hasValidURL);
    clearChannelCache();
    if (!currentChannel) showChannelPicker(false);
};

const fetchChannels = async () => {
    if (isFetching) return;
    isFetching = true;
    try {
        const headers = {};
        if (lastModified) headers['If-Modified-Since'] = lastModified;
        const res = await fetch(CONFIG.jsonURL, { headers, cache: 'no-cache' });
        if (res.status === 304) return;
        if (res.ok) {
            const lm = res.headers.get('Last-Modified');
            if (lm) lastModified = lm;
            let data = await res.json();
            // H? tr? format m?i: { srcBase, channels }
            if (data && !Array.isArray(data) && data.channels) {
                const base = data.srcBase || '';
                data = data.channels.map(ch => ({ ...ch, src: base + ch.channelId + '.m3u8', pass: true }));
            }
            applyChannelData(data);
        }
    } catch(e) {
        console.error('L\u1ed7i t\u1ea3i k\u00eanh:', e);
    } finally {
        isFetching = false;
    }
};

// ==================== THEME ====================
const initTheme = () => document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'dark');
const toggleTheme = () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('theme', t);
};

// ==================== CHANNEL UP / DOWN ====================
const channelUp = () => {
    if (!allChannels.length) return;
    const valid = allChannels.filter(hasValidURL);
    if (!valid.length) return;
    const idx = currentChannel ? valid.findIndex(c => c.name === currentChannel.name) : -1;
    selectChannel(valid[idx < valid.length - 1 ? idx + 1 : 0]);
};
const channelDown = () => {
    if (!allChannels.length) return;
    const valid = allChannels.filter(hasValidURL);
    if (!valid.length) return;
    const idx = currentChannel ? valid.findIndex(c => c.name === currentChannel.name) : 0;
    selectChannel(valid[idx > 0 ? idx - 1 : valid.length - 1]);
};

// ==================== TV INFO BAR ====================
let _infoBarTimer = null;
const showInfoBar = (duration) => {
    const bar = document.getElementById('tv-info-bar');
    if (!bar) return;
    _updateTibTime();
    bar.classList.add('tib-visible');
    clearTimeout(_infoBarTimer);
    if (duration !== 0) _infoBarTimer = setTimeout(() => bar.classList.remove('tib-visible'), duration != null ? duration : 5000);
};
const hideInfoBar = () => {
    clearTimeout(_infoBarTimer);
    document.getElementById('tv-info-bar')?.classList.remove('tib-visible');
};
const _updateTibTime = () => {
    const el = document.getElementById('tib-time');
    if (!el) return;
    const d = new Date();
    el.textContent = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
};

// ==================== ON-SCREEN REMOTE ====================
window._remoteVisible = false;
let _remoteHideTimer = null;
const _showRemote = () => {
    const r = document.getElementById('tv-remote');
    if (!r) return;
    r.classList.remove('remote-hidden');
    window._remoteVisible = true;
    clearTimeout(_remoteHideTimer);
    _remoteHideTimer = setTimeout(_hideRemote, 12000);
};
const _hideRemote = () => {
    document.getElementById('tv-remote')?.classList.add('remote-hidden');
    window._remoteVisible = false;
};
const _simulateKey = (keyCode) => {
    const evt = new KeyboardEvent('keydown', { keyCode, which: keyCode, bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'keyCode', { get: () => keyCode });
    window.dispatchEvent(evt);
};
const setupOnScreenRemote = () => {
    const remote = document.getElementById('tv-remote');
    const toggleBtn = document.getElementById('remote-toggle-btn');
    if (!remote) return;

    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window._remoteVisible ? _hideRemote() : _showRemote();
        });
    }

    // Action buttons (D-pad, CH, menu, info, back)
    remote.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearTimeout(_remoteHideTimer);
            _remoteHideTimer = setTimeout(_hideRemote, 12000);
            switch (btn.dataset.action) {
                case 'up':    _simulateKey(38); break;
                case 'down':  _simulateKey(40); break;
                case 'left':  _simulateKey(37); break;
                case 'right': _simulateKey(39); break;
                case 'ok':    _simulateKey(13); break;
                case 'back':  _simulateKey(27); break;
                case 'ch_up':   channelUp();   showInfoBar(5000); break;
                case 'ch_down': channelDown(); showInfoBar(5000); break;
                case 'menu':    showChannelPicker(false); break;
                case 'guide':   showChannelPicker(true);  break;
                case 'info':    showInfoBar(0); break;  // hi?n c? d?nh cho d?n khi nh?n ph�m kh�c
                case 'delete': {
                    numberInputBuffer = numberInputBuffer.slice(0, -1);
                    const fb = document.getElementById('number-input-feedback');
                    if (fb) { fb.textContent = numberInputBuffer || ''; if (!numberInputBuffer) fb.style.display = 'none'; }
                    break;
                }
            }
        });
    });

    // Number buttons
    remote.querySelectorAll('[data-num]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearTimeout(_remoteHideTimer);
            _remoteHideTimer = setTimeout(_hideRemote, 12000);
            handleNumberInput(btn.dataset.num);
        });
    });

    // Hi?n n�t toggle khi di chu?t / ch?m m�n h�nh
    let _tglTimer = null;
    const _peekToggle = () => {
        if (!toggleBtn) return;
        toggleBtn.classList.add('rtb-peek');
        clearTimeout(_tglTimer);
        _tglTimer = setTimeout(() => { if (!window._remoteVisible) toggleBtn.classList.remove('rtb-peek'); }, 3500);
    };
    document.addEventListener('mousemove', _peekToggle, { passive: true });
    document.addEventListener('touchstart', _peekToggle, { passive: true });
};

// ==================== INIT ====================
// ==================== REMOTE SSE (phone → TV) ====================
const _remoteApiBase = 'https://cdn-vn.iof.vn';
let _remoteCode = null;
let _remoteSSE  = null;
let _remoteConnected = false;

// Push trạng thái TV (kênh đang xem) tới phone remote
const _pushTvStateToPhone = () => {
    if (!_remoteCode || !currentChannel) return;
    const ch = currentChannel;
    const payload = { name: ch.name, TV: ch.TV || ch.name, logo: ch.logo, channelId: ch.channelId, group: ch.group };
    fetch(_remoteApiBase + '/api/remote/tv-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: _remoteCode, channel: payload })
    }).catch(() => {});
};

// DRM stream-ready callbacks — unblocked instantly when extension injects via SSE
const _drmStreamReadyCallbacks = new Map();

// Main SSE connection — listens for stream_ready push events (no heartbeat needed in TV mode)
const _tvSseId = Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
let _tvSse = null;
const _initTvSse = () => {
    if (_tvSse) return;
    if (typeof EventSource === 'undefined') return;
    _tvSse = new EventSource(_remoteApiBase + '/sse?sid=tv_' + _tvSseId);
    _tvSse.addEventListener('stream_ready', (e) => {
        try {
            const data = JSON.parse(e.data);
            const rawId = data && data.rawId;
            if (rawId && _drmStreamReadyCallbacks.has(rawId)) {
                const resolve = _drmStreamReadyCallbacks.get(rawId);
                _drmStreamReadyCallbacks.delete(rawId);
                resolve();
            }
        } catch(_) {}
    });
    _tvSse.onerror = () => {}; // auto-reconnects
};

const _handleRemoteCmd = (cmd) => {
    const { action, payload } = cmd;
    switch (action) {
        case 'up':       _simulateKey(38); break;
        case 'down':     _simulateKey(40); break;
        case 'left':     _simulateKey(37); break;
        case 'right':    _simulateKey(39); break;
        case 'ok':       _simulateKey(13); break;
        case 'back':     _simulateKey(27); break;
        case 'ch_up':    channelUp();   showInfoBar(5000); break;
        case 'ch_down':  channelDown(); showInfoBar(5000); break;
        case 'menu':     showChannelPicker(false); break;
        case 'guide':    showChannelPicker(true);  break;
        case 'info':     showInfoBar(0); break;
        case 'num':      if (payload) handleNumberInput(String(payload)); break;
        case 'select': {
            // Phone chọn kênh → TV chuyển kênh
            if (payload) {
                const ch = allChannels.find(c => c.channelId === payload.channelId || c.name === payload.name);
                if (ch) { hideChannelPicker(); selectChannel(ch); }
            }
            break;
        }
        case 'delete': {
            numberInputBuffer = numberInputBuffer.slice(0, -1);
            const fb = document.getElementById('number-input-feedback');
            if (fb) { fb.textContent = numberInputBuffer || ''; if (!numberInputBuffer) fb.style.display = 'none'; }
            break;
        }
    }
    // Feedback trên màn hình TV khi nhận lệnh từ remote
    _showRemoteCmdFeedback(action, payload);
};

const _showRemoteCmdFeedback = (action, payload) => {
    let label = null;
    if (action === 'num' && payload) label = payload;
    else if (action === 'ch_up') label = 'CH ?';
    else if (action === 'ch_down') label = 'CH ?';
    // Ch? hi?n feedback cho s? v� CH
    if (!label) return;
    const fb = document.getElementById('number-input-feedback');
    if (!fb) return;
    fb.textContent = label;
    fb.style.display = 'block';
    clearTimeout(fb._timer);
    fb._timer = setTimeout(() => { if (action !== 'num') { fb.style.display = 'none'; } }, 2000);
};

const _updateRemotePairingUI = () => {
    // Cập nhật code
    const codeEl = document.getElementById('rpo-code');
    if (codeEl) codeEl.textContent = _remoteCode || '—';
    // Cập nhật trạng thái kết nối
    const connEl = document.getElementById('rpo-conn');
    if (connEl) {
        connEl.textContent = _remoteConnected ? '● Điện thoại đã kết nối' : '○ Chờ điện thoại kết nối';
        connEl.className = 'rpo-conn' + (_remoteConnected ? ' online' : ' offline');
    }
    // Vẽ QR nếu chưa có
    if (_remoteCode) {
        const qrWrap = document.getElementById('rpo-qr-wrap');
        if (qrWrap && qrWrap.dataset.code !== _remoteCode) {
            qrWrap.dataset.code = _remoteCode;
            _drawQR(qrWrap, 'https://xemtv.vn/remote.html?code=' + _remoteCode, 200);
        }
    }
};

const showRemotePairingOverlay = () => {
    const ov = document.getElementById('remote-pairing-overlay');
    if (!ov) return;
    ov.classList.remove('rpo-hidden');
    _updateRemotePairingUI();
    // Đóng khi click bên ngoài card (backdrop)
    const onBdClick = (e) => {
        if (e.target === ov) { ov.classList.add('rpo-hidden'); ov.removeEventListener('click', onBdClick); }
    };
    ov.removeEventListener('click', ov._bdClick);
    ov._bdClick = onBdClick;
    ov.addEventListener('click', onBdClick);
};
window.showRemotePairingOverlay = showRemotePairingOverlay;

const _drawQR = (container, text, size) => {
    if (!container) return;
    size = size || 200;
    if (typeof QRCode !== 'undefined') {
        try {
            const canvas = document.createElement('canvas');
            container.innerHTML = '';
            container.appendChild(canvas);
            QRCode.toCanvas(canvas, text, { width: size, margin: 2, color: { dark: '#000', light: '#fff' } });
            canvas.style.cssText = 'border-radius:10px;display:block';
            return;
        } catch(e) {}
    }
    const img = document.createElement('img');
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(text);
    img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;display:block;border-radius:10px;background:#fff';
    img.alt = 'QR';
    container.innerHTML = '';
    container.appendChild(img);
};

const initRemoteSSE = async () => {
    try {
        const r = await fetch(_remoteApiBase + '/api/remote/pair', { method: 'POST' });
        const d = await r.json();
        if (!d.ok || !d.code) return;
        _remoteCode = d.code;
        _updateRemotePairingUI();

        const sse = new EventSource(_remoteApiBase + '/api/remote/events?code=' + _remoteCode);
        _remoteSSE = sse;

        sse.onopen = () => {
            console.log('[Remote SSE] connected, code=' + _remoteCode);
        };
        sse.onmessage = (e) => {
            try {
                const cmd = JSON.parse(e.data);
                if (cmd.type === 'connected') return;
                if (cmd.action === 'phone_connected') {
                    _remoteConnected = true;
                    _updateRemotePairingUI();
                    showToast('📱 Đã kết nối điều khiển từ xa', 'ok', 3000);
                    // Tự ẩn overlay sau 1.5s
                    setTimeout(() => {
                        const ov = document.getElementById('remote-pairing-overlay');
                        if (ov) ov.classList.add('rpo-hidden');
                    }, 1500);
                    return;
                }
                if (cmd.action === 'phone_disconnected') {
                    _remoteConnected = false;
                    _updateRemotePairingUI();
                    return;
                }
                _remoteConnected = true;
                _handleRemoteCmd(cmd);
            } catch(err) {}
        };
        sse.onerror = () => {
            _remoteConnected = false;
            _updateRemotePairingUI();
            // T? reconnect sau 10s
            setTimeout(() => { sse.close(); initRemoteSSE(); }, 10000);
        };
    } catch(e) {
        setTimeout(initRemoteSSE, 15000);
    }
};

// ==================== M3U / IPTV PLAYLIST MODE (TV / lean-back) ====================
const M3U_STORE_KEY = 'xemtv_m3u_source';

const saveM3uSource = (source) => {
    try { localStorage.setItem(M3U_STORE_KEY, JSON.stringify(source)); } catch (e) {}
};
const loadM3uSource = () => {
    try { return JSON.parse(localStorage.getItem(M3U_STORE_KEY) || 'null'); } catch (e) { return null; }
};
const clearM3uSource = () => { try { localStorage.removeItem(M3U_STORE_KEY); } catch (e) {} };

// Proxy quản lý M3U (tách biệt khỏi player tĩnh). Mọi playlist/stream đều đi qua đây.
// Đổi URL proxy: thêm ?proxy=https://host vào trang, hoặc localStorage 'xemtv_m3u_proxy'.
const M3U_PROXY_BASE = (() => {
    const q = new URLSearchParams(location.search).get('proxy');
    if (q) { try { localStorage.setItem('xemtv_m3u_proxy', q); } catch (e) {} return q.replace(/\/+$/, ''); }
    return (localStorage.getItem('xemtv_m3u_proxy') || 'https://cdn-vn.iof.vn/mproxy').replace(/\/+$/, '');
})();
const _viaProxy = (u) => M3U_PROXY_BASE ? (M3U_PROXY_BASE + '/p?url=' + encodeURIComponent(u)) : u;
const _rawProxy = (u) => M3U_PROXY_BASE ? (M3U_PROXY_BASE + '/raw?url=' + encodeURIComponent(u)) : u;

// Parse nội dung M3U/M3U8 → mảng kênh { name, TV, src, logo, group, m3uDirect }
const parseM3U = (text, baseUrl) => {
    text = text || '';
    if (!/#EXTM3U/i.test(text) && !/#EXTINF/i.test(text)) return [];
    const lines = text.split(/\r?\n/);
    const channels = [];
    const used = new Set();
    let cur = null;
    const hasScheme = (u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
    const resolve = (u) => {
        u = (u || '').trim();
        if (!u) return '';
        let out;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^[a-z]+:/i.test(u)) out = u;
        else if (baseUrl) { try { out = new URL(u, baseUrl).href; } catch (e) { out = u; } }
        else out = u;
        return out;
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#EXTINF/i.test(line)) {
            const attrs = {};
            const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
            let m; while ((m = attrRe.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2];
            const ci = line.indexOf(',');
            const name = (ci >= 0 ? line.slice(ci + 1) : '').trim();
            cur = {
                name: name || attrs['tvg-name'] || 'Kênh',
                logo: attrs['tvg-logo'] || '',
                group: (attrs['group-title'] || '').split(';')[0].trim()
            };
        } else if (/^#EXTGRP/i.test(line)) {
            const g = line.split(':')[1];
            if (cur && g) cur.group = g.split(';')[0].trim();
        } else if (line[0] === '#') {
            continue;
        } else {
            if (!cur && !hasScheme(line) && !baseUrl) { continue; }
            const url = resolve(line);
            if (!url || !hasScheme(url)) { cur = null; continue; }
            const base = cur || { name: 'Kênh', logo: '', group: '' };
            let nm = base.name, k = 2;
            while (used.has(nm)) nm = base.name + ' (' + (k++) + ')';
            used.add(nm);
            channels.push({ name: nm, TV: base.name, src: _viaProxy(url), logo: base.logo, group: base.group, m3uDirect: true });
            cur = null;
        }
    }
    return channels;
};

const _revealApp = () => {
    document.documentElement.style.visibility = 'visible';
};

// Chuyển sang chế độ M3U: nạp danh sách kênh & phát kênh đầu
const enterM3uMode = (channels) => {
    _m3uMode = true;
    allChannels = channels;
    clearChannelCache();
    pickerActiveTab = '';
    currentChannel = null;

    let target = null;
    try {
        const last = JSON.parse(localStorage.getItem('lastChannel') || 'null');
        if (last) target = allChannels.find(c => c.name === last.name);
    } catch (e) {}
    if (!target) target = allChannels[0];

    hideM3uEntry();
    _revealApp();
    if (target) selectChannel(target);
};

const loadM3uFromSource = async (source) => {
    _setM3uBusy(true, 'Đang quét kênh...');
    try {
        let text;
        if (source.type === 'text') {
            text = source.value;
        } else {
            const res = await fetch(_rawProxy(source.value), { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            text = await res.text();
        }
        const channels = parseM3U(text, source.type === 'url' ? source.value : '');
        if (!channels.length) throw new Error('Không tìm thấy kênh — link/nội dung không phải playlist M3U hợp lệ');
        saveM3uSource(source);
        _setM3uBusy(true, 'Đã quét ' + channels.length + ' kênh...');
        enterM3uMode(channels);
    } catch (e) {
        _setM3uBusy(false);
        _showM3uError('Không tải được playlist: ' + e.message + (source.type === 'url' ? ' — kiểm tra link hoặc proxy M3U.' : ''));
        _revealApp();
    }
};

// ---- Overlay nhập M3U ----
const _buildM3uEntry = () => {
    if (document.getElementById('m3u-entry')) return;
    const ov = document.createElement('div');
    ov.id = 'm3u-entry';
    ov.innerHTML = `
      <div class="m3u-box">
        <button class="m3u-close" id="m3u-close" title="Đóng" style="display:none">&times;</button>
        <div class="m3u-hero">
          <div class="m3u-logo-wrap">
            <img class="m3u-logo" src="/Image_WEB/xemtv_logo.png" alt="XemTV" onerror="this.style.display='none';this.parentNode.innerHTML='<i class=\'fas fa-tv\'></i>'" />
          </div>
          <div class="m3u-brand">XemTV<span>.vn</span></div>
          <div class="m3u-tagline">Trình phát IPTV &middot; Mở mọi playlist M3U / M3U8 của bạn</div>
        </div>
        <div class="m3u-tabs">
          <button class="m3u-tab active" data-tab="url"><i class="fas fa-link"></i> Link M3U</button>
          <button class="m3u-tab" data-tab="file"><i class="fas fa-folder-open"></i> Tải file</button>
          <button class="m3u-tab" data-tab="text"><i class="fas fa-paste"></i> Dán nội dung</button>
        </div>
        <div class="m3u-pane" data-pane="url">
          <input id="m3u-url" type="url" placeholder="https://.../playlist.m3u" autocomplete="off" />
        </div>
        <div class="m3u-pane" data-pane="file" style="display:none">
          <label class="m3u-file">
            <i class="fas fa-folder-open"></i> <span id="m3u-file-name">Chọn file .m3u / .m3u8</span>
            <input id="m3u-file" type="file" accept=".m3u,.m3u8,text/plain" hidden />
          </label>
        </div>
        <div class="m3u-pane" data-pane="text" style="display:none">
          <textarea id="m3u-text" rows="6" placeholder="#EXTM3U&#10;#EXTINF:-1 tvg-logo=&quot;...&quot; group-title=&quot;...&quot;,Tên kênh&#10;https://.../stream.m3u8"></textarea>
        </div>
        <div class="m3u-err" id="m3u-err"></div>
        <button class="m3u-go" id="m3u-go"><i class="fas fa-play"></i> Xem ngay</button>
        <div class="m3u-foot"><i class="fas fa-shield-halved"></i> Hỗ trợ HLS &middot; M3U8 &middot; Phát qua proxy bảo mật</div>
      </div>`;
    document.body.appendChild(ov);

    let fileText = '', fileName = '';
    ov.querySelectorAll('.m3u-tab').forEach(btn => btn.addEventListener('click', () => {
        ov.querySelectorAll('.m3u-tab').forEach(b => b.classList.toggle('active', b === btn));
        ov.querySelectorAll('.m3u-pane').forEach(p => p.style.display = p.dataset.pane === btn.dataset.tab ? '' : 'none');
        _showM3uError('');
    }));
    const fileInput = ov.querySelector('#m3u-file');
    fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        fileName = f.name;
        ov.querySelector('#m3u-file-name').textContent = f.name;
        const rd = new FileReader();
        rd.onload = () => { fileText = String(rd.result || ''); };
        rd.readAsText(f);
    });
    const submit = () => {
        const active = ov.querySelector('.m3u-tab.active').dataset.tab;
        _showM3uError('');
        if (active === 'url') {
            const u = ov.querySelector('#m3u-url').value.trim();
            if (!u) return _showM3uError('Hãy nhập link M3U.');
            loadM3uFromSource({ type: 'url', value: u, name: u });
        } else if (active === 'file') {
            if (!fileText) return _showM3uError('Hãy chọn file .m3u/.m3u8.');
            loadM3uFromSource({ type: 'text', value: fileText, name: fileName || 'File M3U' });
        } else {
            const t = ov.querySelector('#m3u-text').value.trim();
            if (!t) return _showM3uError('Hãy dán nội dung M3U.');
            loadM3uFromSource({ type: 'text', value: t, name: 'Playlist dán tay' });
        }
    };
    ov.querySelector('#m3u-go').addEventListener('click', submit);
    ov.querySelector('#m3u-url').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    ov.querySelector('#m3u-close').addEventListener('click', hideM3uEntry);
};

const showM3uEntry = () => {
    _buildM3uEntry();
    const ov = document.getElementById('m3u-entry');
    if (!ov) return;
    ov.style.display = 'flex';
    const close = document.getElementById('m3u-close');
    if (close) close.style.display = _m3uMode ? 'block' : 'none';
    _setM3uBusy(false);
    const url = document.getElementById('m3u-url');
    if (url) setTimeout(() => url.focus(), 50);
};
const hideM3uEntry = () => {
    const ov = document.getElementById('m3u-entry');
    if (ov) ov.style.display = 'none';
};
const _showM3uError = (msg) => {
    const el = document.getElementById('m3u-err');
    if (el) el.textContent = msg || '';
};
const _setM3uBusy = (busy, msg) => {
    const go = document.getElementById('m3u-go');
    if (go) {
        go.disabled = !!busy;
        go.innerHTML = busy
            ? '<i class="fas fa-spinner fa-spin"></i> ' + (msg || 'Đang tải...')
            : '<i class="fas fa-play"></i> Xem ngay';
    }
};

// Điểm vào: có playlist đã lưu → nạp lại; chưa có → hiện màn nhập
const initPlaylistMode = () => {
    const saved = loadM3uSource();
    if (saved && saved.value) {
        loadM3uFromSource(saved);
    } else {
        showM3uEntry();
        _revealApp();
    }
};
window.changePlaylist = showM3uEntry;

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    const style = document.createElement('style');
    style.textContent = '#video-player{width:100%!important;height:100vh!important;max-width:100%!important;display:block!important;background:#000;object-fit:fill;}' +
        '#channel-picker-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.96);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px;}' +
        '.picker-inner{width:100%;max-width:1400px;}' +
        '.picker-header{display:flex;align-items:center;justify-content:space-between;padding:30px 0 22px;color:#fff;}' +
        '.picker-header h1{font-size:1.8rem;font-weight:700;letter-spacing:1px;}' +
        '.picker-header h1 i{color:#ff3d00;margin-right:12px;}' +
        '.picker-tab-bar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:24px;}' +
        '.picker-tab-btn{background:rgba(255,255,255,0.1);color:#fff;border:none;padding:10px 22px;border-radius:24px;font-size:1rem;cursor:pointer;transition:background .2s;}' +
        '.picker-tab-btn.active,.picker-tab-btn:hover{background:#ff3d00;}' +
        '.picker-tab-btn.picker-tab-focused{outline:2px solid #fff;outline-offset:2px;}' +
        '.picker-remote-btn.picker-tab-focused{outline:2px solid #fff;outline-offset:2px;background:rgba(255,107,53,0.25);color:#ff8a65;}' +
        '.picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:16px;padding-bottom:40px;}' +
        '.picker-item{background:rgba(255,255,255,0.07);border-radius:12px;padding:16px 8px 12px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;transition:background .2s,transform .15s;position:relative;}' +
        '.picker-item:hover{background:rgba(255,61,0,0.3);transform:scale(1.05);}' +
        '.picker-item.picker-focused{background:rgba(255,61,0,0.55);transform:scale(1.08);outline:2px solid #ff3d00;}' +
        '.picker-item img{width:60px;height:60px;object-fit:contain;border-radius:8px;}' +
        '.picker-num{position:absolute;top:6px;left:8px;font-size:.7rem;color:rgba(255,255,255,.4);}' +
        '.picker-name{font-size:.82rem;color:#fff;text-align:center;line-height:1.3;}' +
        'body.picker-sidebar-mode #channel-picker-overlay{align-items:stretch;justify-content:flex-end;padding:0;background:transparent;}' +
        'body.picker-sidebar-mode .picker-inner{width:380px;max-width:50vw;height:100vh;overflow-y:auto;background:rgba(12,12,12,0.97);padding:0;border-left:2px solid #ff3d00;display:flex;flex-direction:column;}' +
        'body.picker-sidebar-mode .picker-header{padding:18px 16px 12px;border-bottom:1px solid rgba(255,255,255,.08);}' +
        'body.picker-sidebar-mode .picker-header h1{font-size:1.1rem;text-align:left;}' +
        'body.picker-sidebar-mode .picker-tab-bar{padding:10px 12px;gap:8px;justify-content:flex-start;flex-wrap:wrap;margin-bottom:0;border-bottom:1px solid rgba(255,255,255,.08);}' +
        'body.picker-sidebar-mode .picker-tab-btn{padding:7px 14px;font-size:.85rem;}' +
        'body.picker-sidebar-mode .picker-list{flex:1;overflow-y:auto;padding:6px 0;}' +
        '.picker-list-item{display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;transition:background .15s;border-bottom:1px solid rgba(255,255,255,.05);}' +
        '.picker-list-item:hover{background:rgba(255,255,255,.07);}' +
        '.picker-list-item.picker-focused{background:rgba(139,35,0,0.6);outline:none;}' +
        '.picker-list-item.picker-active{background:rgba(255,61,0,0.18);}' +
        '.picker-list-item.picker-active.picker-focused{background:rgba(139,35,0,0.7);}' +
        '.picker-list-num{min-width:28px;font-size:.8rem;color:rgba(255,255,255,.45);text-align:right;}' +
        '.picker-list-item img{width:42px;height:42px;object-fit:contain;border-radius:6px;background:#1a1a1a;}' +
        '.picker-list-name{flex:1;font-size:.92rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.picker-list-item .fav-btn{flex-shrink:0;background:rgba(255,255,255,.08);border:none;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.85rem;}' +
        '.picker-list-item .fav-btn.favorited{background:rgba(255,61,0,.3);color:#ff3d00;}';
    document.head.appendChild(style);
    document.body.classList.add('tv-mode');
    setupTVNavigation();
    // Player IPTV tĩnh: nạp playlist M3U thay vì gọi backend
    initPlaylistMode();
    document.getElementById('theme-toggle') && document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    setupOnScreenRemote();
    _updateTibTime();
    setInterval(_updateTibTime, 30000);

    // Gửi leave khi user đóng tab / tắt màn hình
    window.addEventListener('beforeunload', () => stopHeartbeat());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stopHeartbeat();
        else if (currentChannel) startHeartbeat(currentChannel);
    });
});