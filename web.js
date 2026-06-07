// ==================== CONFIG ====================
const CONFIG = {
    jsonURL: "https://cdn-vn.iof.vn/api/channels/list",
    updateInterval: 30 * 1000,
    maxRetries: 20,
    debounceMs: 300,
    numberInputTimeout: 1000,
    hlsConfig: {
        // Tối ưu nhẹ + mượt giống IPTV app (VLC/TiviMate)
        enableWorker: true,
        // Buffer vừa đủ — tránh tốn RAM trên mobile/TV
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,   // 60 MB
        maxBufferHole: 0.3,
        // Gần live edge hơn → ABR ổn định, ít rebuffer
        liveSyncDurationCount: 3,          // ~12s sau live (segment 4s)
        liveMaxLatencyDurationCount: 8,
        liveDurationInfinity: true,
        // ABR: bắt đầu ở mid, switch up nhanh
        abrEwmaDefaultEstimate: 2000000,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        abrBandWidthUpFactor: 0.85,
        abrBandWidthFactor: 0.9,
        startFragPrefetch: true,
        lowLatencyMode: false,
        // Network resilience
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
        // Back buffer nhỏ → trả RAM sớm
        backBufferLength: 10
    }
};

// ==================== GLOBAL VARIABLES ====================
let hlsInstance = null;
let allChannels = [];
let _m3uMode = false; // true khi đang xem playlist M3U do người dùng nhập
let currentChannel = null;
let currentChannelIndex = -1;
let fetchInterval = null;
let isFetching = false;
let abortController = new AbortController();
let numberInputBuffer = '';
let numberInputTimeout = null;
let isChangingChannel = false;
let channelURLCache = new Map();
let heartbeatInterval = null;
let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches);
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
// Gán class ngay khi parse JS (trước DOMContentLoaded) để CSS áp dụng sớm
if (isMobile) document.documentElement.classList.add('is-mobile');
let activeTab = 'VTV';
const GROUP_ORDER = ['VTV', 'Vĩnh Long', 'HTV', 'VTVcab', 'SCTV', 'Quốc tế', 'Thiếu nhi', 'Thể thao', 'Địa phương'];

// TV360 Shaka Player
let _shakaPlayer = null;
let _tv360RefreshTimer = null;
let _mytvDrmCustomData = null; // dt-custom-data cho DRMtoday license request
const _tv360ProxyBase = (() => {
    const m = window.location.href.match(/^(https?:\/\/[^\/]+)/);
    return m ? m[1] : '';
})();
const _tv360ProxyUrl = (url) => {
    if (!url) return url;
    if (url.includes('tv360.vn') && !url.startsWith(_tv360ProxyBase)) {
        return _tv360ProxyBase + '/seg?e=' + _obfEncode(url);
    }
    return url;
};

// ==================== URL ROUTING ====================
const toSlug = (str) => {
    return (str || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'd')
        .replace(/\+/g, 'plus')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};
const CHANNEL_PATH_PREFIX = '/truyen-hinh-truc-tuyen/';

const updateUrlForChannel = (channel) => {
    if (!channel) return;
    const slug = toSlug(channel.TV || channel.name);
    const newPath = CHANNEL_PATH_PREFIX + slug;
    if (window.location.pathname !== newPath) {
        history.pushState({ channel: channel.name }, '', newPath);
    }
};

const getChannelFromUrl = () => {
    const path = window.location.pathname;
    if (!path.startsWith(CHANNEL_PATH_PREFIX)) return null;
    const slug = path.slice(CHANNEL_PATH_PREFIX.length).replace(/\/$/, '');
    if (!slug) return null;
    return slug;
};

// ==================== SITE WATERMARK PROTECTION (logo chìm) ====================
// Canvas overlay anti-tamper — không thể xóa bằng F12
(function() {
    const _wSrc = 'https://cdn-vn.iof.vn/TV/1563x1563_Xemtv.png';
    // KHÔNG dùng crossOrigin='anonymous': ảnh chỉ vẽ (drawImage), không đọc pixel.
    // crossOrigin yêu cầu header CORS mà route /TV không gửi → iOS/Safari chặn ảnh → logo không hiện.
    const _wImg = new Image(); _wImg.src = _wSrc;
    let _wCanvas = null, _wCtx = null, _wRAF = null;
    const _wId = '_wc' + Math.random().toString(36).substr(2, 6);

    const _wCreate = () => {
        const c = document.getElementById('player-container');
        if (!c) return null;
        const existing = c.querySelector('canvas[data-w="' + _wId + '"]');
        if (existing) return existing;
        const cv = document.createElement('canvas');
        cv.setAttribute('data-w', _wId);
        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:7;opacity:1;transform:translateZ(0);-webkit-transform:translateZ(0);';
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

    const _wCheck = () => {
        const c = document.getElementById('player-container');
        if (!c) return;
        const cv = c.querySelector('canvas[data-w="' + _wId + '"]');
        const video = document.getElementById('video-player');
        let tampered = false;
        if (!cv) { tampered = true; }
        else {
            const cs = getComputedStyle(cv);
            if (cs.display === 'none' || cs.visibility === 'hidden' ||
                parseFloat(cs.opacity) < 0.3 || cs.zIndex < 1 ||
                cv.width === 0 || cv.height === 0) {
                tampered = true;
            }
        }
        if (tampered) {
            _wCanvas = _wCreate();
            _wDraw();
            if (video && !video.paused) {
                video.pause();
                setTimeout(() => { try { video.play(); } catch(e){} }, 2000);
            }
        }
    };

    const _wObserve = () => {
        const c = document.getElementById('player-container');
        if (!c) return;
        new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of m.removedNodes) {
                    if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-w') === _wId) {
                        _wCanvas = _wCreate(); _wDraw();
                    }
                }
            }
        }).observe(c, { childList: true, subtree: true });
        if (_wCanvas) {
            new MutationObserver(() => _wCheck()).observe(_wCanvas, { attributes: true, attributeFilter: ['style','class','hidden'] });
        }
    };

    const _wProtect = (cv) => {
        if (!cv) return;
        Object.defineProperty(cv, 'remove', { value: () => {}, writable: false, configurable: false });
        try {
            const p = cv.parentNode;
            if (p) {
                const orig = p.removeChild.bind(p);
                p.removeChild = function(child) {
                    if (child === cv || (child?.getAttribute?.('data-w') === _wId)) return child;
                    return orig(child);
                };
            }
        } catch(e) {}
    };

    const _wInit = () => {
        _wCanvas = _wCreate();
        if (_wCanvas) { _wProtect(_wCanvas); _wDraw(); _wLoop(); _wObserve(); setInterval(_wCheck, 800); }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wInit);
    else setTimeout(_wInit, 100);
    window.addEventListener('resize', _wDraw);
    document.addEventListener('fullscreenchange', () => setTimeout(_wDraw, 150));
})();
// ==================== END SITE WATERMARK ====================

// ==================== UTILITY FUNCTIONS ====================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// URL obfuscation (XOR + base64url) - ẩn URL CDN trong network tab
const _OBF_KEY = 'xTv2026sEg';
const _obfEncode = (str) => {
    const enc = new TextEncoder();
    const buf = enc.encode(str);
    const key = enc.encode(_OBF_KEY);
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    let b64 = btoa(String.fromCharCode(...out));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
};

const getChannelURL = (channel) => {
    if (channelURLCache.has(channel.name)) {
        return channelURLCache.get(channel.name);
    }
    const url = channel.src || '';
    channelURLCache.set(channel.name, url);
    return url;
};

const clearChannelCache = () => {
    channelURLCache.clear();
};

// ==================== HEARTBEAT / SSE ====================
const HEARTBEAT_URL = 'https://cdn-vn.iof.vn/heartbeat';
const SSE_URL = 'https://cdn-vn.iof.vn/sse';
const SESSION_ID = (() => {
    let sid = sessionStorage.getItem('xemtv_sid');
    if (!sid) { sid = Math.random().toString(36).substr(2, 12) + Date.now().toString(36); sessionStorage.setItem('xemtv_sid', sid); }
    return sid;
})();

// DRM stream-ready callbacks (rawId → resolve fn) — unblocked by SSE stream_ready event
const _drmStreamReadyCallbacks = new Map();

// SSE connection (replaces Web Worker heartbeat polling)
let _sse = null;
let _sseChannel = null; // current channel SSE is tracking

const _handleHeartbeatResponse = (d) => {
    if (d && d.broadcast) handleBroadcast(d.broadcast);
    else if (d && d.broadcast === null) hideBroadcast && hideBroadcast();
    if (d && d.forceLogout) {
        localStorage.removeItem('xemtv_activated');
        stopHeartbeat();
        showActivationScreen();
    }
};

const _handleSseEvent = (event, data) => {
    if (event === 'connected' || event === 'tick') {
        _handleHeartbeatResponse(data);
    } else if (event === 'broadcast') {
        _handleHeartbeatResponse({ broadcast: data });
    } else if (event === 'force_logout') {
        _handleHeartbeatResponse({ forceLogout: true });
    } else if (event === 'stream_ready') {
        const rawId = data && data.rawId;
        if (rawId && _drmStreamReadyCallbacks.has(rawId)) {
            const resolve = _drmStreamReadyCallbacks.get(rawId);
            _drmStreamReadyCallbacks.delete(rawId);
            resolve();
        }
    }
};

const startHeartbeat = (channel) => {
    stopHeartbeat();
    const chId = channel.channelId || '';
    if (!chId) return;
    const fp = getFingerprint();
    _sseChannel = chId;

    if (typeof EventSource !== 'undefined') {
        // SSE: server push — viewer count, broadcast, force_logout, stream_ready
        const url = SSE_URL + '?sid=' + SESSION_ID + '&fp=' + encodeURIComponent(fp) + '&ch=' + encodeURIComponent(chId);
        _sse = new EventSource(url);
        _sse.addEventListener('connected', (e) => { try { _handleSseEvent('connected', JSON.parse(e.data)); } catch(_) {} });
        _sse.addEventListener('tick',      (e) => { try { _handleSseEvent('tick',      JSON.parse(e.data)); } catch(_) {} });
        _sse.addEventListener('broadcast', (e) => { try { _handleSseEvent('broadcast', JSON.parse(e.data)); } catch(_) {} });
        _sse.addEventListener('force_logout', (e) => { _handleSseEvent('force_logout', {}); });
        _sse.addEventListener('stream_ready', (e) => { try { _handleSseEvent('stream_ready', JSON.parse(e.data)); } catch(_) {} });
        _sse.onerror = () => {}; // EventSource auto-reconnects on error

        // Presence heartbeat THẬT — server đếm "đang xem" theo heartbeat này, KHÔNG theo tick SSE.
        // Khi máy khóa / chuyển app / đóng tab → trình duyệt dừng timer → ngừng heartbeat
        // → viewer tự hết hạn (~90s). SSE chỉ còn để nhận push (broadcast/force_logout).
        const hbUrl = HEARTBEAT_URL + '/' + encodeURIComponent(chId) + '?sid=' + SESSION_ID + '&fp=' + encodeURIComponent(fp);
        const _ping = () => fetch(hbUrl, { keepalive: true, signal: AbortSignal.timeout(6000) }).then(r => r.json()).then(_handleHeartbeatResponse).catch(() => {});
        _ping(); // đăng ký viewer ngay (SSE connect không còn đăng ký)
        heartbeatInterval = setInterval(_ping, 30000);
    } else {
        // Fallback: polling heartbeat (older browsers)
        const hbUrl = HEARTBEAT_URL + '/' + encodeURIComponent(chId) + '?sid=' + SESSION_ID + '&fp=' + encodeURIComponent(fp);
        fetch(hbUrl, { keepalive: true, signal: AbortSignal.timeout(6000) }).then(r => r.json()).then(_handleHeartbeatResponse).catch(() => {});
        heartbeatInterval = setInterval(() => {
            fetch(hbUrl, { keepalive: true, signal: AbortSignal.timeout(6000) }).then(r => r.json()).then(_handleHeartbeatResponse).catch(() => {});
        }, 20000);
    }
};
const stopHeartbeat = () => {
    if (_sse) { _sse.close(); _sse = null; }
    if (_sseChannel) {
        const leaveUrl = 'https://cdn-vn.iof.vn/leave/' + encodeURIComponent(_sseChannel) + '?sid=' + SESSION_ID;
        try { navigator.sendBeacon(leaveUrl); } catch(e) { fetch(leaveUrl).catch(() => {}); }
        _sseChannel = null;
    }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (typeof _epgInterval !== 'undefined' && _epgInterval) { clearInterval(_epgInterval); _epgInterval = null; }
    if (typeof _recoInterval !== 'undefined' && _recoInterval) { clearInterval(_recoInterval); _recoInterval = null; }
    _stopWatchdog();
};

// ==================== BROADCAST NOTIFICATION ====================
let _broadcastShownAt = 0;
let _broadcastDismissTimer = null;
let _dismissedBroadcastId = null; // createdAt của broadcast user đã tự tắt — không hiện lại nữa
let _currentBroadcastId = null;   // createdAt của broadcast đang hiện

const handleBroadcast = (broadcast) => {
    if (!broadcast || !broadcast.message) return;
    // Dùng createdAt làm unique ID; fallback sang message nếu không có
    const bcId = broadcast.createdAt || broadcast.message;
    // User đã tự tắt broadcast này → không hiện lại trong suốt thời gian broadcast còn sống
    if (bcId === _dismissedBroadcastId) return;
    // Đang hiện broadcast này rồi → bỏ qua
    if (document.getElementById('broadcast-notif') && bcId === _currentBroadcastId) return;
    _broadcastShownAt = Date.now();
    _currentBroadcastId = bcId;
    showBroadcastNotification(broadcast.message, broadcast.dismissAfter || 30);
};

const showBroadcastNotification = (message, dismissAfter) => {
    dismissBroadcastNotification(); // đóng cái cũ nếu có
    const el = document.createElement('div');
    el.id = 'broadcast-notif';
    // Đặt giữa player (nếu có) hoặc giữa màn hình
    const player = document.getElementById('player') || document.querySelector('video');
    const container = player ? player.parentElement : document.body;
    el.style.cssText = [
        'position:absolute', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
        'background:rgba(15,20,30,0.95)', 'border:1.5px solid #ff6b35',
        'border-radius:14px', 'padding:20px 28px', 'z-index:99999',
        'max-width:480px', 'width:85%', 'text-align:center',
        'font-family:inherit', 'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
        'backdrop-filter:blur(8px)', 'animation:bcFadeIn 0.3s ease'
    ].join(';');
    if (container !== document.body) container.style.position = 'relative';
    const secs = parseInt(dismissAfter) || 30;
    el.innerHTML = `
        <style>
            @keyframes bcFadeIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.95)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
            #broadcast-notif .bc-title{font-size:0.72rem;color:#ff6b35;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px}
            #broadcast-notif .bc-title svg{width:16px;height:16px;fill:#ff6b35}
            #broadcast-notif .bc-msg{color:#f0f0f0;font-size:1rem;line-height:1.6;margin-bottom:16px;font-weight:400}
            #broadcast-notif .bc-footer{display:flex;justify-content:space-between;align-items:center}
            #broadcast-notif .bc-timer{font-size:0.72rem;color:#7a8a9a}
            #broadcast-notif .bc-close{background:rgba(255,107,53,0.12);border:1px solid rgba(255,107,53,0.4);color:#ff6b35;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:0.8rem;font-weight:600;transition:all 0.2s}
            #broadcast-notif .bc-close:hover{background:rgba(255,107,53,0.25);border-color:#ff6b35}
        </style>
        <div class="bc-title"><svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg> THÔNG BÁO HỆ THỐNG</div>
        <div class="bc-msg">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        <div class="bc-footer">
            <span class="bc-timer" id="bc-countdown">Tự đóng sau ${secs}s</span>
            <button class="bc-close" onclick="dismissBroadcastNotification(true)">Đóng</button>
        </div>`;
    container.appendChild(el);
    let remaining = secs;
    const countdown = document.getElementById('bc-countdown');
    _broadcastDismissTimer = setInterval(() => {
        remaining--;
        if (countdown) countdown.textContent = `Tự đóng sau ${remaining}s`;
        if (remaining <= 0) dismissBroadcastNotification();
    }, 1000);
};

const dismissBroadcastNotification = (manual) => {
    if (_broadcastDismissTimer) { clearInterval(_broadcastDismissTimer); _broadcastDismissTimer = null; }
    const el = document.getElementById('broadcast-notif');
    if (el) el.remove();
    // Nếu user tự tay đóng → đánh dấu không hiện lại broadcast này
    if (manual && _currentBroadcastId) _dismissedBroadcastId = _currentBroadcastId;
};

// ==================== ACTIVATION & MAINTENANCE CHECK ====================
const SYSTEM_API = 'https://cdn-vn.iof.vn/api';

// Generate browser fingerprint (stable per browser+device)
const getFingerprint = () => {
    let fp = localStorage.getItem('xemtv_fp');
    if (fp) return fp;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('xemtv-fp', 2, 2);
    const canvasData = canvas.toDataURL();
    const raw = navigator.userAgent + '|' + screen.width + 'x' + screen.height + '|' +
        (navigator.language || '') + '|' + new Date().getTimezoneOffset() + '|' + canvasData;
    // Simple hash
    let hash = 0;
    for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
    fp = 'fp_' + Math.abs(hash).toString(36) + '_' + raw.length.toString(36);
    localStorage.setItem('xemtv_fp', fp);
    return fp;
};

const showActivationScreen = () => {
    const existing = document.getElementById('activation-overlay');
    if (existing) return;
    const overlay = document.createElement('div');
    overlay.id = 'activation-overlay';
    overlay.innerHTML = `
        <style>
            #activation-overlay{position:fixed;inset:0;background:#000;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:'Roboto',system-ui,sans-serif;}
            #activation-overlay .code-digit{width:46px;height:56px;text-align:center;font-size:1.5rem;font-weight:700;background:#111;border:2px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;outline:none;transition:border-color .15s,box-shadow .15s;}
            #activation-overlay .code-digit:focus{border-color:#ff3d00!important;box-shadow:0 0 0 3px rgba(255,61,0,0.18);}
            #activate-btn{width:100%;padding:13px;background:#ff3d00;color:#fff;border:none;border-radius:10px;font-size:0.95rem;font-weight:700;cursor:pointer;letter-spacing:0.3px;transition:opacity .15s;}
            #activate-btn:hover:not(:disabled){opacity:0.84;}
            #activate-btn:disabled{opacity:0.4;cursor:not-allowed;}
        </style>
        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(255,61,0,0.09) 0%,transparent 55%);pointer-events:none;"></div>
        <div style="text-align:center;width:100%;max-width:400px;padding:32px 20px;position:relative;">
            <img src="https://cdn-vn.iof.vn/TV/Xemtv_cat_Toi.png" alt="XemTV.vn" style="max-width:160px;height:auto;margin-bottom:28px;" onerror="this.style.display='none'">
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:30px 24px;">
                <div style="font-size:1.05rem;font-weight:600;color:#fff;margin-bottom:6px;">Nhập mã kích hoạt</div>
                <p style="color:#555;font-size:0.82rem;margin-bottom:24px;line-height:1.55;">Vui lòng nhập mã 6 số để kích hoạt thiết bị xem TV</p>
                <div style="display:flex;gap:8px;justify-content:center;margin-bottom:20px;" id="code-inputs">
                    <input type="tel" maxlength="1" class="code-digit">
                    <input type="tel" maxlength="1" class="code-digit">
                    <input type="tel" maxlength="1" class="code-digit">
                    <input type="tel" maxlength="1" class="code-digit">
                    <input type="tel" maxlength="1" class="code-digit">
                    <input type="tel" maxlength="1" class="code-digit">
                </div>
                <button id="activate-btn">Kích hoạt</button>
                <p id="activate-error" style="color:#ff4757;font-size:0.78rem;margin-top:12px;display:none;"></p>
                <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);">
                    <p style="color:#555;font-size:0.78rem;margin-bottom:10px;">Chưa có mã kích hoạt?</p>
                    <a href="/payment?autostart=1" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,61,0,0.12);border:1px solid rgba(255,61,0,0.3);color:#ff6a3d;border-radius:8px;padding:9px 18px;font-size:0.82rem;font-weight:600;text-decoration:none;">
                        <i class="fas fa-qrcode" style="font-size:0.78rem;"></i> Kích hoạt ngay — 29.000đ / 30 ngày
                    </a>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Auto-focus & auto-advance
    const digits = overlay.querySelectorAll('.code-digit');

    // Tự động điền nếu có code từ trang thanh toán
    const _pendingCode = localStorage.getItem('pendingActivationCode');
    if (_pendingCode && /^\d{6}$/.test(_pendingCode)) {
        for (let j = 0; j < 6; j++) digits[j].value = _pendingCode[j] || '';
        localStorage.removeItem('pendingActivationCode');
        digits[5].focus();
        // Tự động kích hoạt sau 500ms
        setTimeout(() => { document.getElementById('activate-btn')?.click(); }, 500);
    } else {
        digits[0].focus();
    }
    digits.forEach((inp, i) => {
        inp.addEventListener('input', () => {
            inp.value = inp.value.replace(/\D/g, '');
            if (inp.value && i < 5) digits[i + 1].focus();
        });
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !inp.value && i > 0) digits[i - 1].focus();
        });
        inp.addEventListener('paste', (e) => {
            const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
            if (paste.length >= 6) {
                for (let j = 0; j < 6; j++) digits[j].value = paste[j] || '';
                digits[5].focus();
                e.preventDefault();
            }
        });
    });

    document.getElementById('activate-btn').addEventListener('click', async () => {
        const code = [...digits].map(d => d.value).join('');
        if (code.length !== 6) {
            showActivateError('Vui lòng nhập đủ 6 số');
            return;
        }
        const btn = document.getElementById('activate-btn');
        btn.textContent = 'Đang xác nhận...';
        btn.disabled = true;
        try {
            const r = await fetch(SYSTEM_API + '/activate', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ code, fingerprint: getFingerprint() })
            });
            const data = await r.json();
            if (data.ok) {
                localStorage.setItem('xemtv_activated', '1');
                overlay.remove();
                // Reload lại danh sách kênh sau khi kích hoạt thành công
                if (typeof loadChannels === 'function') loadChannels();
                else if (typeof fetchChannels === 'function') fetchChannels();
                else if (typeof initApp === 'function') initApp();
                else location.reload();
            } else {
                showActivateError(data.error || 'Mã không hợp lệ');
                btn.textContent = 'Kích hoạt';
                btn.disabled = false;
            }
        } catch(e) {
            showActivateError('Lỗi kết nối, thử lại');
            btn.textContent = 'Kích hoạt';
            btn.disabled = false;
        }
    });
};

const showActivateError = (msg) => {
    const el = document.getElementById('activate-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
};

const showMaintenanceScreen = (message) => {
    const existing = document.getElementById('maintenance-overlay');
    if (existing) return;
    const overlay = document.createElement('div');
    overlay.id = 'maintenance-overlay';
    overlay.innerHTML = `
        <style>
            #maintenance-overlay{position:fixed;inset:0;background:#000;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:'Roboto',system-ui,sans-serif;}
            @keyframes xmaint-pulse{0%,80%,100%{opacity:.2;transform:scale(.75)}40%{opacity:1;transform:scale(1)}}
            .xmaint-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff3d00;margin:0 3px;animation:xmaint-pulse 1.4s ease-in-out infinite;}
            .xmaint-dot:nth-child(2){animation-delay:.2s;}.xmaint-dot:nth-child(3){animation-delay:.4s;}
        </style>
        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(255,61,0,0.07) 0%,transparent 60%);pointer-events:none;"></div>
        <div style="text-align:center;max-width:400px;padding:32px 20px;position:relative;">
            <img src="https://cdn-vn.iof.vn/TV/Xemtv_cat_Toi.png" alt="XemTV.vn" style="max-width:160px;height:auto;margin-bottom:36px;" onerror="this.style.display='none'">
            <h2 style="color:#fff;font-size:1.35rem;font-weight:700;margin:0 0 14px;">Đang bảo trì</h2>
            <p style="color:#555;font-size:0.88rem;line-height:1.8;max-width:280px;margin:0 auto 32px;">${message || 'Hệ thống đang bảo trì, vui lòng quay lại sau.'}</p>
            <div><span class="xmaint-dot"></span><span class="xmaint-dot"></span><span class="xmaint-dot"></span></div>
        </div>
    `;
    document.body.appendChild(overlay);
};

const checkSystemStatus = async () => {
    try {
        const r = await fetch(SYSTEM_API + '/system-status?client=web');
        const data = await r.json();

        if (data.maintenance) {
            showMaintenanceScreen(data.maintenanceMessage);
            return false;
        }

        if (data.codeRequired) {
            // Check if already activated
            const activated = localStorage.getItem('xemtv_activated');
            if (activated) {
                // Verify with server
                const r2 = await fetch(SYSTEM_API + '/check-activation', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ fingerprint: getFingerprint() })
                });
                const d2 = await r2.json();
                if (d2.ok) {
                    // Hiện broadcast ngay khi vào trang (trước khi chọn kênh)
                    if (data.broadcast) setTimeout(() => handleBroadcast(data.broadcast), 1500);
                    return true;
                }
                // Invalid → remove local flag, show activation
                localStorage.removeItem('xemtv_activated');
            }
            showActivationScreen();
            return false;
        }
        // Không cần kích hoạt → cũng hiện broadcast nếu có
        if (data.broadcast) setTimeout(() => handleBroadcast(data.broadcast), 1500);
        return true;
    } catch(e) {
        // If API fails, allow access (graceful degradation)
        return true;
    }
};

// ==================== TERMS OF SERVICE ====================
const TOS_KEY = 'tos_v1';

const checkTosAcceptance = () => new Promise((resolve) => {
    if (localStorage.getItem(TOS_KEY)) { resolve(); return; }
    // Chỉ hiện trên trang app chính, không hiện trên trang con (giới thiệu, điều khoản, bảo mật...)
    const p = location.pathname.replace(/\/index\.html$/, '/');
    const isAppPage = p === '/' || p === '' || p.startsWith('/truyen-hinh-truc-tuyen/');
    if (!isAppPage) { resolve(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'tos-overlay';
    overlay.innerHTML = `
        <style>
            #tos-overlay{
                position:fixed;inset:0;background:rgba(0,0,0,0.97);
                z-index:99999;display:flex;align-items:center;justify-content:center;
                font-family:'Roboto',system-ui,sans-serif;
                padding:16px;box-sizing:border-box;
                animation:tosFadeIn 0.3s ease;
            }
            @keyframes tosFadeIn{from{opacity:0}to{opacity:1}}
            @keyframes tosSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
            #tos-card{
                position:relative;width:100%;max-width:540px;
                background:#111;border:1px solid rgba(255,107,53,0.28);
                border-radius:20px;padding:36px 32px 28px;
                max-height:92vh;overflow-y:auto;
                scrollbar-width:thin;scrollbar-color:rgba(255,61,0,0.25) transparent;
                animation:tosSlideUp 0.35s ease;
                box-shadow:0 24px 80px rgba(255,61,0,0.1),0 0 0 1px rgba(255,255,255,0.04);
            }
            #tos-card::-webkit-scrollbar{width:4px}
            #tos-card::-webkit-scrollbar-thumb{background:rgba(255,61,0,0.3);border-radius:2px}
            .tos-logo{text-align:center;margin-bottom:18px}
            .tos-logo img{max-width:100px;height:auto}
            .tos-brand{color:#ff3d00;font-size:1.45rem;font-weight:700;margin-top:6px;letter-spacing:-0.3px}
            .tos-line{height:1px;background:linear-gradient(90deg,transparent,rgba(255,61,0,0.5),transparent);margin:0 0 20px}
            .tos-h1{color:#fff;font-size:1.12rem;font-weight:700;text-align:center;margin:0 0 3px}
            .tos-sub{color:#777;font-size:0.8rem;text-align:center;margin:0 0 18px}
            .tos-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 18px;margin-bottom:14px}
            .tos-box>p{color:#aaa;font-size:0.87rem;line-height:1.75;margin:0 0 14px}
            .tos-ul{list-style:none;padding:0;margin:0 0 14px}
            .tos-ul li{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);color:#bbb;font-size:0.84rem;line-height:1.6}
            .tos-ul li:last-child{border-bottom:none;padding-bottom:0}
            .tos-ul li .ic{flex-shrink:0;width:32px;height:32px;border-radius:50%;background:rgba(255,61,0,0.1);border:1px solid rgba(255,61,0,0.18);display:flex;align-items:center;justify-content:center;margin-top:1px}
            .tos-ul li .ic svg{width:16px;height:16px;fill:#ff6e40;flex-shrink:0}
            .tos-warn{background:rgba(255,61,0,0.07);border-left:3px solid #ff3d00;border-radius:0 8px 8px 0;padding:10px 14px;margin:2px 0 0}
            .tos-warn p{color:#ffb499;font-size:0.82rem;line-height:1.65;margin:0;font-style:italic}
            .tos-chk{display:flex;align-items:flex-start;gap:10px;margin:14px 0 16px;cursor:pointer}
            .tos-chk input{width:17px;height:17px;flex-shrink:0;accent-color:#ff3d00;cursor:pointer;margin-top:2px}
            .tos-chk span{color:#ccc;font-size:0.85rem;line-height:1.6}
            .tos-chk a{color:#ff6e40;text-decoration:none}
            .tos-chk a:hover{text-decoration:underline}
            #tos-btn{
                width:100%;padding:13px;border:none;border-radius:12px;
                background:linear-gradient(135deg,#ff3d00,#ff6e40);
                color:#fff;font-size:1rem;font-weight:700;
                cursor:pointer;letter-spacing:0.2px;display:flex;align-items:center;
                justify-content:center;gap:8px;transition:opacity 0.2s,transform 0.15s;
                margin-bottom:12px;
            }
            #tos-btn:disabled{opacity:0.3;cursor:not-allowed;transform:none!important}
            #tos-btn:not(:disabled):hover{opacity:0.88;transform:translateY(-1px)}
            #tos-btn:not(:disabled):active{transform:translateY(0)}
            .tos-foot{text-align:center}
            .tos-foot a{color:#555;font-size:0.78rem;text-decoration:none;transition:color 0.2s}
            .tos-foot a:hover{color:#ff6e40}
            @media(max-width:500px){
                #tos-card{padding:24px 18px 22px;border-radius:16px}
                .tos-brand{font-size:1.25rem}
                .tos-h1{font-size:1rem}
                #tos-btn{padding:13px;font-size:0.95rem}
            }
        </style>
        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% -5%,rgba(255,61,0,0.12) 0%,transparent 55%);pointer-events:none"></div>
        <div id="tos-card">
            <div class="tos-logo">
                <img src="https://cdn-vn.iof.vn/TV/Xemtv_cat_Toi.png" alt="XemTV" onerror="this.style.display='none'">
                <div class="tos-brand">XemTV.vn</div>
            </div>
            <div class="tos-line"></div>
            <div class="tos-h1">Điều khoản sử dụng dịch vụ</div>
            <div class="tos-sub">Vui lòng đọc và chấp nhận trước khi sử dụng</div>
            <div class="tos-box">
                <p>Để sử dụng dịch vụ <strong style="color:#ff6e40">XemTV.vn</strong>, bạn cần đọc và chấp nhận đầy đủ các điều khoản sử dụng của chúng tôi.</p>
                <ul class="tos-ul">
                    <li><div class="ic"><svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/><path d="M10 8.5l6 3.5-6 3.5V8.5z"/></svg></div><div>Dịch vụ xem truyền hình trực tuyến miễn phí, chỉ dành cho mục đích giải trí cá nhân.</div></li>
                    <li><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 13l-3-3 1.41-1.41L10 11.17l5.59-5.58L17 7l-7 7z"/></svg></div><div>Thông tin người dùng được bảo mật theo chính sách bảo mật của XemTV.vn.</div></li>
                    <li><div class="ic"><svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg></div><div>Nghiêm cấm sao chép, phân phối lại nội dung dưới bất kỳ hình thức nào.</div></li>
                    <li><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.68L5.68 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.68l11.22-11.22C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg></div><div>Chúng tôi có quyền tạm ngừng dịch vụ nếu phát hiện hành vi vi phạm điều khoản.</div></li>
                </ul>
                <div class="tos-warn">
                    <p>Mọi người dùng không có nhận thức, hiểu biết về điều khoản hoặc không chấp nhận điều khoản thì <strong>không được sử dụng dịch vụ.</strong></p>
                </div>
            </div>
            <label class="tos-chk">
                <input type="checkbox" id="tos-cb">
                <span>Tôi đã đọc, hiểu và đồng ý với <a href="/dieu-khoan-su-dung.html" target="_blank" onclick="event.stopPropagation()">điều khoản sử dụng</a> của XemTV.vn</span>
            </label>
            <button id="tos-btn" disabled>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                Đồng ý &amp; Tiếp tục
            </button>
            <div class="tos-foot"><a href="/dieu-khoan-su-dung.html" target="_blank">Xem đầy đủ điều khoản sử dụng &rarr;</a></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const cb = document.getElementById('tos-cb');
    const btn = document.getElementById('tos-btn');
    cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
    btn.addEventListener('click', () => {
        if (!cb.checked) return;
        localStorage.setItem(TOS_KEY, '1');
        overlay.style.transition = 'opacity 0.25s';
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 280);
        resolve();
    });
});

// ==================== STORAGE FUNCTIONS ====================
const getFavorites = () => {
    try {
        return JSON.parse(localStorage.getItem('favoriteChannels') || '[]');
    } catch {
        return [];
    }
};

const saveFavorites = (favs) => {
    localStorage.setItem('favoriteChannels', JSON.stringify(favs));
};

const isFavorite = (name) => {
    return getFavorites().some(c => c.name === name);
};

const toggleFavorite = (event, channel) => {
    event.stopPropagation();
    const btn = event.currentTarget;
    let favs = getFavorites();
    const isFav = isFavorite(channel.name);

    if (isFav) {
        favs = favs.filter(c => c.name !== channel.name);
        btn.innerHTML = '<i class="fas fa-plus"></i>';
        btn.classList.remove('favorited');
        btn.title = 'Thêm vào yêu thích';
    } else {
        favs.push(channel);
        btn.innerHTML = '<i class="fas fa-heart"></i>';
        btn.classList.add('favorited', 'heart-beat');
        btn.title = 'Xóa khỏi yêu thích';
        setTimeout(() => btn.classList.remove('heart-beat'), 500);
    }

    saveFavorites(favs);
    syncFavoriteButtons(channel.name, !isFav);
    renderFavorites();
    renderSidebarChannels();
};

const syncFavoriteButtons = (name, isFav) => {
    document.querySelectorAll(`.channel-item[data-name="${name}"] .fav-btn`).forEach(btn => {
        btn.innerHTML = `<i class="fas ${isFav ? 'fa-heart' : 'fa-plus'}"></i>`;
        btn.classList.toggle('favorited', isFav);
        btn.title = isFav ? 'Xóa khỏi yêu thích' : 'Thêm vào yêu thích';
    });
};

// ==================== HLS PLAYER ====================
const getVideo = () => document.getElementById('video-player');
let _playingHandler = null;
let _waitingHandler = null;
let _canplayHandler = null;
let _stallTimer = null;
let _pauseHandler = null;
const STALL_SEEK_TIMEOUT = 6000; // 6s stall → seek live edge

const setPlayerMode = (mode) => {
    const video = getVideo();
    const container = document.getElementById('player-container');
    if (!video || !container) return;
    const isCatchup = mode === 'catchup';
    document.body.classList.toggle('catchup-mode', isCatchup);
    container.classList.toggle('catchup-mode', isCatchup);
    video.controls = false;
    video.removeAttribute('controls');
    if (isCatchup) {
        video.style.display = 'none';
        let catchupVideo = document.getElementById('catchup-player');
        if (!catchupVideo) {
            catchupVideo = document.createElement('video');
            catchupVideo.id = 'catchup-player';
            catchupVideo.setAttribute('playsinline', '');
            catchupVideo.setAttribute('preload', 'auto');
            catchupVideo.controls = true;
            container.insertBefore(catchupVideo, container.firstChild);
        }
        catchupVideo.style.display = 'block';
    } else {
        destroyCatchupPlayer();
        video.style.display = '';
    }
};

// ===== Catchup Player (HTML5 + HLS.js) =====
let _catchupHlsInstance = null;
let _ccHideTimer = null;
let _ccSeekInterval = null;

const getCatchupVideo = () => document.getElementById('catchup-player');

const fmtDur = (seconds) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hour = Math.floor(total / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const second = total % 60;
    if (hour > 0) return `${hour}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    return `${minute}:${String(second).padStart(2, '0')}`;
};

const destroyCatchupChrome = () => {
    clearInterval(_ccSeekInterval); _ccSeekInterval = null;
    clearTimeout(_ccHideTimer); _ccHideTimer = null;
    document.querySelector('.catchup-controls')?.remove();
};

const createCatchupControls = () => {
    const container = document.getElementById('player-container');
    const video = getCatchupVideo();
    if (!container || !video) return;
    video.controls = false;
    let controls = container.querySelector('.catchup-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'catchup-controls';
        controls.innerHTML = `
            <div class="cc-seek-row">
                <input type="range" class="cc-seek-bar" min="0" max="1000" value="0" step="1">
            </div>
            <div class="cc-bottom-row">
                <button class="cc-btn cc-btn-play" type="button" title="Phát/Dừng"><i class="fas fa-pause"></i></button>
                <span class="cc-time">0:00 / 0:00</span>
                <span class="cc-title"></span>
                <span class="cc-spacer"></span>
                <button class="cc-speed" type="button" title="Tốc độ">1x</button>
                <button class="cc-btn cc-btn-fs" type="button" title="Toàn màn hình"><i class="fas fa-expand"></i></button>
                <button class="cc-live-btn" type="button" title="Trở lại trực tiếp">● Trực tiếp</button>
            </div>`;
        container.appendChild(controls);
    }

    const seekBar = controls.querySelector('.cc-seek-bar');
    const timeEl = controls.querySelector('.cc-time');
    const playBtn = controls.querySelector('.cc-btn-play');
    const titleEl = controls.querySelector('.cc-title');
    const speedBtn = controls.querySelector('.cc-speed');
    const fsBtn = controls.querySelector('.cc-btn-fs');
    const liveBtn = controls.querySelector('.cc-live-btn');
    titleEl.textContent = _catchupProgram?.title || '';

    const speeds = [0.75, 1, 1.25, 1.5, 2];
    let speedIdx = speeds.indexOf(1);
    let isSeeking = false;

    const updateUi = () => {
        if (!video || isSeeking) return;
        const duration = video.duration || 0;
        const current = video.currentTime || 0;
        seekBar.max = Math.floor(duration) || 1000;
        seekBar.value = Math.floor(current);
        const pct = duration > 0 ? (current / duration) * 100 : 0;
        seekBar.style.background = `linear-gradient(90deg, #ff6a3d ${pct}%, rgba(255,255,255,0.18) ${pct}%)`;
        timeEl.textContent = `${fmtDur(current)} / ${fmtDur(duration)}`;
        playBtn.querySelector('i').className = video.paused ? 'fas fa-play' : 'fas fa-pause';
    };

    clearInterval(_ccSeekInterval);
    _ccSeekInterval = setInterval(updateUi, 300);
    video.onloadedmetadata = updateUi;
    video.ontimeupdate = updateUi;
    video.onplay = updateUi;
    video.onpause = updateUi;

    seekBar.oninput = () => { isSeeking = true; };
    seekBar.onchange = () => {
        video.currentTime = Number(seekBar.value || 0);
        isSeeking = false;
        updateUi();
    };

    playBtn.onclick = (e) => {
        e.stopPropagation();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        updateUi();
    };

    speedBtn.onclick = (e) => {
        e.stopPropagation();
        speedIdx = (speedIdx + 1) % speeds.length;
        video.playbackRate = speeds[speedIdx];
        speedBtn.textContent = `${speeds[speedIdx]}x`;
    };

    fsBtn.onclick = (e) => {
        e.stopPropagation();
        const el = container;
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (isFs) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            screen.orientation?.unlock?.();
            if (_isIOS) { container.style.cssText = ''; document.body.style.overflow = ''; }
            fsBtn.querySelector('i').className = 'fas fa-expand';
        } else {
            const cv = getCatchupVideo();
            if (_isIOS && window.innerHeight > window.innerWidth) {
                const w = window.innerWidth, h = window.innerHeight;
                container.style.cssText = `position:fixed;top:0;left:0;width:${h}px;height:${w}px;transform:rotate(90deg);transform-origin:top left;translate:${w}px 0;z-index:99999;background:#000;`;
                document.body.style.overflow = 'hidden';
                if (cv && cv.webkitEnterFullscreen) cv.webkitEnterFullscreen();
            } else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
            else if (cv && cv.webkitEnterFullscreen) cv.webkitEnterFullscreen();
            screen.orientation?.lock?.('landscape').catch(() => {});
            fsBtn.querySelector('i').className = 'fas fa-compress';
        }
    };
    // Đồng bộ icon khi thoát fullscreen
    const onCatchupFsChange = () => {
        const inFs = document.fullscreenElement || document.webkitFullscreenElement;
        fsBtn.querySelector('i').className = inFs ? 'fas fa-compress' : 'fas fa-expand';
        if (!inFs) { container.style.cssText = ''; document.body.style.overflow = ''; }
    };
    document.addEventListener('fullscreenchange', onCatchupFsChange);
    document.addEventListener('webkitfullscreenchange', onCatchupFsChange);
    const catchupVidFs = getCatchupVideo();
    if (catchupVidFs) catchupVidFs.addEventListener('webkitendfullscreen', () => {
        container.style.cssText = ''; document.body.style.overflow = '';
        fsBtn.querySelector('i').className = 'fas fa-expand';
    });

    liveBtn.onclick = (e) => { e.stopPropagation(); stopCatchup(); };

    const showControls = () => {
        controls.classList.remove('cc-hidden');
        clearTimeout(_ccHideTimer);
        _ccHideTimer = setTimeout(() => {
            if (!video.paused) {
                controls.classList.add('cc-hidden');
            }
        }, 3200);
    };

    container.onmousemove = showControls;
    container.ontouchstart = showControls;
    container.onclick = (e) => {
        if (e.target === video || e.target === container) showControls();
    };
    showControls();
    updateUi();
};

const destroyCatchupPlayer = () => {
    const catchupVideo = getCatchupVideo();
    destroyCatchupChrome();
    if (_catchupHlsInstance) {
        try { _catchupHlsInstance.destroy(); } catch(e) {}
        _catchupHlsInstance = null;
    }
    if (catchupVideo) {
        catchupVideo.pause();
        catchupVideo.removeAttribute('src');
        catchupVideo.load();
        catchupVideo.style.display = 'none';
        catchupVideo.onplaying = null;
        catchupVideo.onended = null;
        catchupVideo.onerror = null;
    }
};

const initCatchupPlayer = (url) => {
    destroyCatchupPlayer();
    let catchupVideo = getCatchupVideo();
    if (!catchupVideo) {
        const container = document.getElementById('player-container');
        catchupVideo = document.createElement('video');
        catchupVideo.id = 'catchup-player';
        catchupVideo.setAttribute('playsinline', '');
        catchupVideo.setAttribute('preload', 'auto');
        catchupVideo.controls = true;
        container.insertBefore(catchupVideo, container.firstChild);
    }
    catchupVideo.style.display = 'block';
    catchupVideo.controls = false;

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        _catchupHlsInstance = new Hls({
            enableWorker: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            manifestLoadingTimeOut: 60000,
            manifestLoadingMaxRetry: 2,
            manifestLoadingRetryDelay: 2000,
            levelLoadingTimeOut: 30000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            lowLatencyMode: false,
            abrEwmaDefaultEstimate: 8000000,
            startLevel: -1
        });
        _catchupHlsInstance.loadSource(url);
        _catchupHlsInstance.attachMedia(catchupVideo);
        _catchupHlsInstance.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                console.warn('[Catchup HLS Fatal]', data.type, data.details);
                showBufferingOverlay(true, 'Lỗi tải xem lại. Thử lại...', null);
                setTimeout(() => {
                    if (_catchupHlsInstance) {
                        _catchupHlsInstance.destroy();
                        _catchupHlsInstance = null;
                    }
                    if (_isCatchupMode && _catchupProgram && currentChannel) {
                        playCatchup(_catchupProgram, currentChannel.channelId);
                    }
                }, 3000);
            }
        });
        _catchupHlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            const lvls = _catchupHlsInstance.levels || [];
            if (lvls.length > 1) {
                _catchupHlsInstance.currentLevel = lvls.length - 1;
            }
            catchupVideo.play().catch(() => {});
        });
    } else if (catchupVideo.canPlayType('application/vnd.apple.mpegurl')) {
        catchupVideo.src = url;
        catchupVideo.play().catch(() => {});
    }

    return catchupVideo;
};

// Pause overlay: hiện nút play khi video dừng (CHỈ KHI TAB ĐANG HIỂN THỊ)
const showPauseOverlay = () => {
    // Không hiện overlay khi tab ẩn (browser tự pause)
    if (document.hidden) return;
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('pause-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'pause-overlay';
        ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);z-index:10;cursor:pointer;transition:opacity 0.2s';
        ov.innerHTML = '<div style="width:64px;height:64px;border-radius:50%;background:rgba(255,61,0,0.9);display:flex;align-items:center;justify-content:center"><i class="fas fa-play" style="font-size:24px;color:#fff;margin-left:4px"></i></div>';
        ov.addEventListener('click', () => {
            const v = getVideo();
            if (!v) return;
            hidePauseOverlay();
            if (v.paused) v.play().catch(() => {});
            else v.pause();
        });
        container.appendChild(ov);
    }
    ov.style.display = 'flex';
};
const hidePauseOverlay = () => {
    const ov = document.getElementById('pause-overlay');
    if (ov) ov.style.display = 'none';
};

const clearVideoListeners = () => {
    const v = getVideo();
    if (!v) return;
    if (_playingHandler) { v.removeEventListener('playing', _playingHandler); _playingHandler = null; }
    if (_waitingHandler) { v.removeEventListener('waiting', _waitingHandler); _waitingHandler = null; }
    if (_canplayHandler) { v.removeEventListener('canplay', _canplayHandler); _canplayHandler = null; }
    if (_pauseHandler) { v.removeEventListener('pause', _pauseHandler); _pauseHandler = null; }
    if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null; }
    hidePauseOverlay();
};

let _loadAbort = null;

const destroyHls = () => {
    if (_loadAbort) { _loadAbort.abort(); _loadAbort = null; }
    clearVideoListeners();
    if (_tv360RefreshTimer) { clearInterval(_tv360RefreshTimer); _tv360RefreshTimer = null; }
    if (hlsInstance) { try { hlsInstance.destroy(); } catch(e) {} hlsInstance = null; }
    if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(e) {} _shakaPlayer = null; }
    const v = getVideo();
    if (v) v.pause();
};

const showError = (message, retryCallback, btnLabel) => {
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('buffer-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'buffer-overlay'; container.appendChild(ov); }
    ov.innerHTML = '<i class="fas fa-exclamation-circle" style="font-size:48px;color:#ff3d00;margin-bottom:12px"></i><p style="white-space:pre-line">' + message + '</p>' +
        (retryCallback ? '<button class="retry-btn" style="margin-top:12px;background:#ff3d00;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:1rem;cursor:pointer">' + (btnLabel || 'Thử lại') + '</button>' : '');
    ov.style.display = 'flex';
    if (retryCallback) ov.querySelector('.retry-btn').addEventListener('click', retryCallback);
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

const showBufferingOverlay = (show, label, logoUrl) => {
    label = label || 'Đang kết nối...';
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('buffer-overlay');
    if (show) {
        if (!ov) { ov = document.createElement('div'); ov.id = 'buffer-overlay'; container.appendChild(ov); }
        // Chỉ rebuild nếu logo thay đổi, còn label thì update text node
        const currentLogo = ov.querySelector('.buffer-channel-logo');
        const currentLabel = ov.querySelector('p');
        const currentLogoSrc = currentLogo ? currentLogo.getAttribute('src') : '';
        const newLogoSrc = logoUrl || '';
        if (currentLabel && currentLogoSrc === newLogoSrc) {
            // Logo giống → chỉ update text
            if (currentLabel.textContent !== label) currentLabel.textContent = label;
        } else {
            const bars = '<div class="buf-bars"><div class="buf-bar"></div><div class="buf-bar"></div><div class="buf-bar"></div><div class="buf-bar"></div><div class="buf-bar"></div></div>';
            ov.innerHTML = '<div class="buf-logo-ring">' +
                (logoUrl ? '<img class="buffer-channel-logo" src="' + logoUrl + '" alt="" onerror="this.style.display=\'none\'">' : '') +
                '<div class="buf-ring"></div><div class="buf-ring"></div><div class="buf-ring"></div></div>' +
                bars + '<p>' + label + '</p>';
        }
        ov.style.display = 'flex';
    } else if (ov) {
        ov.style.display = 'none';
    }
};

const showPlayButton = (channel) => {
    const container = document.getElementById('player-container');
    if (!container) return;
    let ov = document.getElementById('buffer-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'buffer-overlay'; container.appendChild(ov); }
    ov.innerHTML = (channel && channel.logo ? '<img class="buffer-channel-logo" src="' + channel.logo + '" alt="" onerror="this.style.display=\'none\'">' : '') +
        '<button style="background:#ff3d00;color:#fff;border:none;padding:14px 36px;border-radius:30px;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;gap:8px"><i class="fas fa-play"></i> Nhấn để xem</button>';
    ov.style.display = 'flex';
    ov.querySelector('button').addEventListener('click', () => {
        const video = getVideo();
        if (video) {
            video.muted = false;
            video.play().then(() => {
                showBufferingOverlay(false);
            }).catch(() => {
                video.muted = true;
                video.play().then(() => showBufferingOverlay(false)).catch(() => {});
            });
        }
    });
};

const playTv360Channel = (channel) => {
    const video = getVideo();
    if (!video) return;
    destroyHls();
    setPlayerMode('live');
    video.muted = true;
    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);

    const abort = new AbortController();
    _loadAbort = abort;

    // cdn-vn.iof.vn là server có API tv360, fallback localhost khi dev
    const apiBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(location.origin)
        ? location.origin : 'https://cdn-vn.iof.vn';
    const segProxy = (url) => {
        if (!url || url.startsWith(apiBase)) return url;
        if (!url.includes('tv360.vn') && !/\/tok_ey/.test(url)) return url;
        return apiBase + '/api/tv360-proxy?url=' + encodeURIComponent(url);
    };

    const apiUrl = apiBase + '/api/tv360-stream/' + encodeURIComponent(channel.channelId);

    (async () => {
        // ==================== iOS: FairPlay HLS thay DASH+Widevine ====================
        if (_isIOS) {
            try {
                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                const iosApiUrl = apiBase + '/api/tv360-stream-ios/' + encodeURIComponent(channel.channelId);
                const r = await fetch(iosApiUrl, { signal: abort.signal });
                const data = await r.json();
                if (abort.signal.aborted) return;

                if (!data.ok || !data.hlsProxy) {
                    showError('Không lấy được stream TV360 trên iOS.', () => playTv360Channel(channel));
                    return;
                }

                const hlsUrl  = apiBase + data.hlsProxy;
                const certUrl = data.fpsCertProxy ? apiBase + data.fpsCertProxy : null;
                const licUrl  = data.fpsLicProxy  ? apiBase + data.fpsLicProxy  : null;

                shaka.polyfill.installAll();

                if (!shaka.Player.isBrowserSupported()) {
                    // Fallback: native HLS (unencrypted hoặc native FPS)
                    video.src = hlsUrl;
                    video.play().catch(() => {});
                    _playingHandler = () => { showBufferingOverlay(false); hidePauseOverlay(); updateWatermark(channel); video.muted = false; };
                    video.addEventListener('playing', _playingHandler);
                    return;
                }

                if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(e) {} _shakaPlayer = null; }
                _shakaPlayer = new shaka.Player();
                await _shakaPlayer.attach(video);

                _shakaPlayer.addEventListener('error', (e) => {
                    if (abort.signal.aborted) return;
                    console.warn('[TV360 iOS FPS]', e.detail);
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    setTimeout(() => { if (!abort.signal.aborted) playTv360Channel(channel); }, 4000);
                });

                // Proxy segment requests (TV360 CDN cần headers/cookies)
                _shakaPlayer.getNetworkingEngine().registerRequestFilter((type, req) => {
                    req.uris[0] = segProxy(req.uris[0]);
                    delete req.headers['Range'];
                });

                if (certUrl && licUrl) {
                    _shakaPlayer.configure({
                        drm: {
                            servers: { 'com.apple.fps.1_0': licUrl },
                            advanced: {
                                'com.apple.fps.1_0': { serverCertificateUri: certUrl }
                            }
                        }
                    });
                }

                _shakaPlayer.configure({
                    streaming: {
                        bufferingGoal: 4, rebufferingGoal: 1,
                        stallEnabled: true, stallThreshold: 1,
                        retryParameters: { maxAttempts: 3, baseDelay: 300, fuzzFactor: 0.3 }
                    },
                    manifest: {
                        retryParameters: { maxAttempts: 3, baseDelay: 500, fuzzFactor: 0.5 }
                    }
                });

                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                await _shakaPlayer.load(hlsUrl);
                if (abort.signal.aborted) return;

                // Seek to live edge
                try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = sr.end; } catch(e) {}

                _playingHandler = () => { showBufferingOverlay(false); hidePauseOverlay(); updateWatermark(channel); video.muted = false; };
                _waitingHandler = () => { if (!abort.signal.aborted) { hidePauseOverlay(); showBufferingOverlay(true, 'Đang kết nối...', channel.logo); } };
                _pauseHandler = () => { if (!abort.signal.aborted) { if (document.hidden) { video.play().catch(() => {}); return; } showPauseOverlay(channel); } };
                video.addEventListener('playing', _playingHandler);
                video.addEventListener('waiting', _waitingHandler);
                video.addEventListener('pause', _pauseHandler);

                video.muted = true;
                const _tryPlayFPS = (attempt) => {
                    if (abort.signal.aborted || !_shakaPlayer) return;
                    video.play().catch(() => {
                        if (attempt < 5) setTimeout(() => _tryPlayFPS(attempt + 1), 800);
                        else { showBufferingOverlay(false); showPlayButton(channel); }
                    });
                };
                _tryPlayFPS(1);
                return;

            } catch(e) {
                if (abort.signal.aborted) return;
                console.warn('[TV360 iOS FPS]', e);
                showError('Không phát được TV360 trên iOS.', () => playTv360Channel(channel));
                return;
            }
        }
        // ==================== Desktop/Android: DASH+Widevine ====================
        const _startTime = Date.now();
        const _maxWaitMs = 5 * 60 * 1000; // thử tối đa 5 phút (giống FPT/MyTV tự recover)
        let _delay = 3000;
        while (!abort.signal.aborted) {
            try {
                const r = await fetch(apiUrl, { signal: abort.signal });
                const data = await r.json();
                if (abort.signal.aborted) return;
                if (!data.ok || !data.mpdProxy) {
                    if (Date.now() - _startTime > _maxWaitMs) break;
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    await new Promise(res => setTimeout(res, _delay));
                    _delay = Math.min(_delay * 2, 30000);
                    continue;
                }
                _delay = 3000; // reset backoff khi thành công

                if (abort.signal.aborted) return;

                shaka.polyfill.installAll();
                if (!shaka.Player.isBrowserSupported()) {
                    showError('Trình duyệt không hỗ trợ DASH/DRM.'); return;
                }

                _shakaPlayer = new shaka.Player();
                await _shakaPlayer.attach(video);
                _shakaPlayer.addEventListener('error', (e) => {
                    if (abort.signal.aborted) return;
                    const code = e.detail && e.detail.code;
                    // 1001 = HTTP error (thường do segment hết hạn trên CDN live)
                    // Thay vì restart cả stream, chỉ seek về live edge
                    if (code === 1001) {
                        try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = Math.max(sr.start, sr.end - 25); } catch(ex) {}
                        return;
                    }
                    console.warn('[TV360 Shaka]', e.detail);
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    setTimeout(() => { if (!abort.signal.aborted) playTv360Channel(channel); }, 4000);
                });

                // Proxy tất cả segment/manifest CDN qua server
                _shakaPlayer.getNetworkingEngine().registerRequestFilter((type, req) => {
                    req.uris[0] = segProxy(req.uris[0]);
                    delete req.headers['Range'];
                });

                // Unwrap Sigma DRM JSON response → binary
                _shakaPlayer.getNetworkingEngine().registerResponseFilter((type, res) => {
                    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
                        try {
                            const text = shaka.util.StringUtils.fromUTF8(res.data);
                            const json = JSON.parse(text);
                            if (json.license) {
                                res.data = shaka.util.Uint8ArrayUtils.fromBase64(json.license).buffer;
                            }
                        } catch(e) {}
                    }
                });

                // mpdProxy/licenseProxy là relative path từ API → prepend apiBase
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
                // Streaming config: để Shaka tự dùng suggestedPresentationDelay từ MPD (proxy đã set PT4S).
                // CDN chỉ giữ ~30s segment → buả buffer nhỏ, stall skip nhanh.
                _shakaPlayer.configure({
                    streaming: {
                        bufferingGoal: 4,
                        rebufferingGoal: 1,
                        retryParameters: { maxAttempts: 3, baseDelay: 300, fuzzFactor: 0.3 },
                        stallEnabled: true,
                        stallThreshold: 1
                    },
                    manifest: {
                        retryParameters: { maxAttempts: 3, baseDelay: 500, fuzzFactor: 0.5 },
                        dash: { ignoreSuggestedPresentationDelay: false }
                    }
                });

                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                try {
                    await _shakaPlayer.load(mpdUrl);
                } catch(shakaErr) {
                    // 6007 = DRM không khả dụng (kênh không có DRM hoặc robustness sai)
                    // Thử lại không có DRM config
                    if (shakaErr.code === 6007 || (shakaErr.detail && shakaErr.detail.code === 6007)) {
                        console.warn('[TV360] 6007 → thử lại không DRM');
                        if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(e) {} }
                        _shakaPlayer = new shaka.Player();
                        await _shakaPlayer.attach(video);
                        _shakaPlayer.getNetworkingEngine().registerRequestFilter((type, req) => {
                            req.uris[0] = segProxy(req.uris[0]);
                            delete req.headers['Range'];
                        });
                        await _shakaPlayer.load(mpdUrl);
                    } else {
                        throw shakaErr;
                    }
                }
                if (abort.signal.aborted) return;

                // Seek to live edge ngay sau khi load
                try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = sr.end; } catch(e) {}

                // Dùng event-based unmute giống FPT/MyTV — không unmute trước khi play
                _playingHandler = () => {
                    showBufferingOverlay(false);
                    video.muted = false;
                    updateWatermark(channel);
                    if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null; }
                };
                _waitingHandler = () => {
                    if (!abort.signal.aborted) showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                };
                video.addEventListener('playing', _playingHandler);
                video.addEventListener('waiting', _waitingHandler);
                _pauseHandler = () => {
                    if (!abort.signal.aborted) {
                        if (document.hidden) { video.play().catch(() => {}); return; }
                        showPauseOverlay();
                    }
                };
                video.addEventListener('pause', _pauseHandler);

                video.muted = true;
                const _tryPlay360 = (attempt) => {
                    if (abort.signal.aborted || !_shakaPlayer) return;
                    video.play().catch(() => {
                        if (attempt < 5) setTimeout(() => _tryPlay360(attempt + 1), 800);
                        else { showBufferingOverlay(false); showPlayButton(channel); }
                    });
                };
                _tryPlay360(1);

                // Auto-refresh stream mỗi 5 phút (token TV360 hết hạn ~15 phút)
                if (_tv360RefreshTimer) clearInterval(_tv360RefreshTimer);
                _tv360RefreshTimer = setInterval(async () => {
                    if (abort.signal.aborted || !_shakaPlayer) { clearInterval(_tv360RefreshTimer); _tv360RefreshTimer = null; return; }
                    try {
                        const rr = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
                        const dd = await rr.json();
                        if (dd.ok && dd.mpdProxy && _shakaPlayer && !abort.signal.aborted) {
                            const newMpd = apiBase + dd.mpdProxy;
                            console.log('[TV360] Refresh stream:', newMpd.split('?')[0].split('/').pop());
                            await _shakaPlayer.load(newMpd);
                        }
                    } catch(e) { console.warn('[TV360] Refresh failed:', e.message); }
                }, 5 * 60 * 1000);

                return;

            } catch(e) {
                if (abort.signal.aborted) return;
                if (Date.now() - _startTime > _maxWaitMs) break;
                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                await new Promise(res => setTimeout(res, _delay));
                _delay = Math.min(_delay * 2, 30000);
            }
        }
        if (!abort.signal.aborted) {
            showError('Không lấy được stream TV360.', () => playTv360Channel(channel));
        }
    })();
};

// ==================== MyTV DRM (Shaka/DASH + Widevine) ====================
// ==================== MyTV DRM (Shaka/DASH + Widevine) ====================
const playMytvDrmChannel = (channel) => {
    // LUÔN phát m3u8 qua relay (drm_relay.py giải mã sẵn ở server) cho MỌI nền tảng.
    // Lý do: DASH+Widevine giải mã DRM từng segment trên client → nặng CPU, lag (nhất là mobile/máy yếu).
    // m3u8 relay = client chỉ decode H.264 như video thường + segment /ts/ đã được CDN cache (HIT) → mượt như IPTV.
    playChannelDirect(channel);
    return;
    const video = getVideo();
    if (!video) return;
    destroyHls();
    setPlayerMode('live');
    video.muted = true;
    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);

    const abort = new AbortController();
    _loadAbort = abort;

    const apiBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(location.origin)
        ? location.origin : 'https://cdn-vn.iof.vn';
    const segProxy = (url) => {
        if (!url) return url;
        if (url.includes('/seg?')) return url;
        const cdnMatch = url.match(/^https?:\/\/cdn-vn\.iof\.vn\/cdn\/(.+)/);
        if (cdnMatch) return apiBase + '/seg?e=' + _obfEncode('https://' + cdnMatch[1]);
        if (!url.includes('mytvnet') && !url.includes('mytv')) return url;
        if (url.startsWith(apiBase)) return url;
        return apiBase + '/seg?e=' + _obfEncode(url);
    };

    const rawId = channel.channelId.replace(/^mytv_/, '');
    const apiUrl = apiBase + '/api/mytv-stream/' + rawId;

    (async () => {
        const _startTime = Date.now();
        const _maxWaitMs = 2 * 60 * 1000;
        while (!abort.signal.aborted) {
            try {
                const r = await fetch(apiUrl, { signal: abort.signal });
                const data = await r.json();
                if (abort.signal.aborted) return;
                if (!data.ok || !data.mpdProxy) {
                    if (Date.now() - _startTime > _maxWaitMs) break;
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    await new Promise(resolve => {
                        _drmStreamReadyCallbacks.set(rawId, resolve);
                        setTimeout(() => {
                            if (_drmStreamReadyCallbacks.has(rawId)) {
                                _drmStreamReadyCallbacks.delete(rawId);
                                resolve();
                            }
                        }, 30000);
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

                if (_shakaPlayer) { try { _shakaPlayer.destroy(); } catch(e) {} _shakaPlayer = null; }
                _shakaPlayer = new shaka.Player();
                await _shakaPlayer.attach(video);
                _shakaPlayer.addEventListener('error', (e) => {
                    if (abort.signal.aborted) return;
                    const code = e.detail && e.detail.code;
                    if (code === 1001) {
                        try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = Math.max(sr.start, sr.end - 10); } catch(ex) {}
                        return;
                    }
                    console.warn('[MyTV DRM]', e.detail);
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
                    } catch(e) { /* not JSON, pass through */ }
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
                    drm: {
                        retryParameters: { maxAttempts: 1, baseDelay: 500, fuzzFactor: 0 }
                    },
                    streaming: {
                        bufferingGoal: 6,
                        rebufferingGoal: 2,
                        retryParameters: { maxAttempts: 4, baseDelay: 500, fuzzFactor: 0.3 },
                        stallEnabled: true,
                        stallThreshold: 1
                    },
                    manifest: {
                        retryParameters: { maxAttempts: 4, baseDelay: 500, fuzzFactor: 0.5 },
                        dash: { ignoreSuggestedPresentationDelay: false }
                    }
                });

                showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                try {
                    await _shakaPlayer.load(mpdUrl);
                } catch(loadErr) {
                    if (abort.signal.aborted) return;
                    console.warn('[MyTV DRM] Load error:', loadErr);
                    throw loadErr;
                }
                if (abort.signal.aborted) return;

                try { const sr = _shakaPlayer.seekRange(); if (sr && sr.end > 0) video.currentTime = sr.end; } catch(e) {}

                _playingHandler = () => {
                    showBufferingOverlay(false);
                    hidePauseOverlay();
                    updateWatermark(channel);
                    video.muted = false;
                };
                _waitingHandler = () => {
                    if (!abort.signal.aborted) {
                        hidePauseOverlay();
                        showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    }
                };
                _pauseHandler = () => {
                    if (!abort.signal.aborted) {
                        if (document.hidden) { video.play().catch(() => {}); return; }
                        showPauseOverlay(channel);
                    }
                };
                video.addEventListener('playing', _playingHandler);
                video.addEventListener('waiting', _waitingHandler);
                video.addEventListener('pause', _pauseHandler);

                video.muted = true;
                const _tryPlay = (attempt) => {
                    if (abort.signal.aborted || !_shakaPlayer) return;
                    video.play().catch(() => {
                        if (attempt < 5) setTimeout(() => _tryPlay(attempt + 1), 800);
                        else { showBufferingOverlay(false); showPlayButton(channel); }
                    });
                };
                _tryPlay(1);
                return;

            } catch(e) {
                if (abort.signal.aborted) return;
                if (Date.now() - _startTime > _maxWaitMs) break;
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
        if (!abort.signal.aborted) showError('Không kết nối được kênh DRM này.', () => playMytvDrmChannel(channel));
    })();
};

const playChannelDirect = (channel) => {
    const url = getChannelURL(channel);
    if (!url) { showError('Kênh không có đường dẫn.'); return; }
    const video = getVideo();
    if (!video) return;
    destroyHls(); // hủy load cũ + abort poll cũ
    setPlayerMode('live');

    video.muted = true;

    // Hiện loading ngay lập tức khi click kênh
    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);

    const abort = new AbortController();
    _loadAbort = abort;

    (async () => {
        // Poll stream URL cho đến khi sẵn sàng (200) hoặc hết timeout
        // Kênh M3U do user nhập: phát thẳng, không poll backend (tránh CORS preflight)
        let pollOk = channel.m3uDirect === true;
        for (let i = 0; i < 20 && !abort.signal.aborted && !pollOk; i++) {
            try {
                const _pollSig = typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])
                    : abort.signal;
                const r = await fetch(url, { cache: 'no-cache', signal: _pollSig });
                if (r.ok) {
                    // Kiểm tra nếu là kênh DRM/DASH → chuyển sang Shaka
                    const ct = r.headers.get('content-type') || '';
                    if (ct.includes('application/json')) {
                        const data = await r.json().catch(() => null);
                        if (data && data.type === 'dash') {
                            if (abort.signal.aborted) return;
                            channel.mytvDrm = true;
                            playMytvDrmChannel(channel);
                            return;
                        }
                    }
                    pollOk = true; break;
                }
                if (r.status !== 503) { pollOk = true; break; } // lỗi khác, cứ thử load
            } catch(e) {
                if (abort.signal.aborted) return; // user đổi kênh
            }
            showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
            await new Promise(r => setTimeout(r, 800)); // poll nhanh hơn (800ms thay vì 1500ms)
        }
        if (abort.signal.aborted) return;

        // Hết poll (30s) mà vẫn chưa sẵn sàng → báo lỗi + nút thử lại
        if (!pollOk) {
            showError('Kênh chưa sẵn sàng, vui lòng thử lại.', () => playChannelDirect(channel));
            return;
        }

        // Stream sẵn sàng → khởi tạo HLS.js
        showBufferingOverlay(true, 'Đang kết nối...', channel.logo);

        _playingHandler = () => {
            showBufferingOverlay(false);
            hidePauseOverlay();
            updateWatermark(channel);
            video.muted = false;
            if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null; }
        };
        _waitingHandler = () => {
            if (abort.signal.aborted) return;
            hidePauseOverlay();
            showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
            // Stall quá lâu → seek live edge thay vì đợi
            if (_stallTimer) clearTimeout(_stallTimer);
            _stallTimer = setTimeout(() => {
                if (abort.signal.aborted || !hlsInstance) return;
                const live = hlsInstance.liveSyncPosition;
                if (live && video.currentTime < live - 3) {
                    console.log('[Player] Stall > 6s, seek live edge:', live.toFixed(1));
                    video.currentTime = live;
                    hlsInstance.startLoad();
                }
            }, STALL_SEEK_TIMEOUT);
        };
        _canplayHandler = () => {
            if (!abort.signal.aborted) showBufferingOverlay(false);
            if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null; }
        };
        video.addEventListener('playing', _playingHandler);
        video.addEventListener('waiting', _waitingHandler);
        video.addEventListener('canplay', _canplayHandler);
        _pauseHandler = () => {
            if (!abort.signal.aborted) {
                if (document.hidden) { video.play().catch(() => {}); return; }
                showPauseOverlay();
            }
        };
        video.addEventListener('pause', _pauseHandler);

        if (typeof Hls !== 'undefined' && Hls.isSupported() && !_isIOS) {
            hlsInstance = new Hls(CONFIG.hlsConfig);
            hlsInstance.attachMedia(video);
            hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => {
                hlsInstance.loadSource(url);
            });
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                video.muted = true;
                video.setAttribute('muted', '');
                video.setAttribute('playsinline', '');
                
                const doPlay = () => {
                    if (abort.signal.aborted) return;
                    video.muted = true;
                    video.play().then(() => {
                        // play() thành công
                    }).catch(() => {
                        // Autoplay bị chặn → hiện nút nhấn để xem
                        showPlayButton(channel);
                    });
                };

                // Play ngay lập tức – không đợi canplay (HLS.js đã buffer đủ khi MANIFEST_PARSED)
                doPlay();
            });
            let _fragErrCount = 0, _fragErrTimer = null;
            hlsInstance.on(Hls.Events.ERROR, (ev, data) => {
                if (abort.signal.aborted) return;
                // Non-fatal: fragment/level load error
                if (!data.fatal) {
                    if (data.details === 'fragLoadError' || data.details === 'fragLoadTimeOut') {
                        const status = data.response ? data.response.code : 0;
                        // 404 = segment đã hết hạn → seek live edge ngay lập tức
                        if (status === 404) {
                            const live = hlsInstance.liveSyncPosition;
                            if (live) {
                                console.log('[HLS] Segment 404 (expired), seek live edge:', live.toFixed(1));
                                video.currentTime = live;
                                hlsInstance.startLoad(live);
                            }
                            _fragErrCount = 0;
                            return;
                        }
                        // Lỗi khác: đếm liên tiếp
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
                // Decrypt error → key file sai/chưa có → chờ server cập nhật key rồi recover
                if (data.details === 'fragDecryptError' || data.details === 'keyLoadError' || data.details === 'keyLoadTimeOut') {
                    showToast('Lỗi giải mã – đang khôi phục...', 'error');
                    showBufferingOverlay(true, 'Đang kết nối...', channel.logo);
                    setTimeout(() => {
                        if (abort.signal.aborted) return;
                        try { hlsInstance.recoverMediaError(); } catch(e) {}
                        setTimeout(() => {
                            if (!abort.signal.aborted && video.paused) playChannelDirect(channel);
                        }, 3000);
                    }, 4000);
                    return;
                }
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    // Network error: thử startLoad + seek live trước
                    showToast('Lỗi mạng – đang kết nối lại...', 'error');
                    showBufferingOverlay(true, 'Đang kết nối lại...', channel.logo);
                    hlsInstance.startLoad();
                    const live = hlsInstance.liveSyncPosition;
                    if (live) video.currentTime = live;
                    // Nếu 5s không phục hồi → reload toàn bộ
                    setTimeout(() => {
                        if (!abort.signal.aborted && video.paused) playChannelDirect(channel);
                    }, 5000);
                } else {
                    showToast('Lỗi phát – đang thử lại...', 'error');
                    showBufferingOverlay(true, 'Đang kết nối lại...', channel.logo);
                    setTimeout(() => {
                        if (!abort.signal.aborted) playChannelDirect(channel);
                    }, 2000);
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.play().catch(() => { setTimeout(() => video.play().catch(() => {}), 500); });
        } else {
            showError('Trình duyệt không hỗ trợ HLS.');
        }
    })();
};

// ==================== WATERMARK OVERLAY (che logo đài) ====================
let _wmChannel = null;
let _wmRafId = null;

const positionWatermark = () => {
    const wm = document.getElementById('watermark-overlay');
    const video = document.getElementById('video-player');
    if (!wm || !video || wm.style.display === 'none') return;
    
    const container = video.parentElement;
    if (!container) return;
    
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1080;
    
    if (!cw || !ch) return;
    
    // Tính vùng video thực tế render (object-fit: contain)
    const containerRatio = cw / ch;
    const videoRatio = vw / vh;
    
    let renderW, renderH, offsetX, offsetY;
    if (containerRatio > videoRatio) {
        renderH = ch;
        renderW = ch * videoRatio;
        offsetX = (cw - renderW) / 2;
        offsetY = 0;
    } else {
        renderW = cw;
        renderH = cw / videoRatio;
        offsetX = 0;
        offsetY = (ch - renderH) / 2;
    }
    
    const wmBottom = offsetY + renderH * 0.05;
    const wmRight = offsetX + renderW * 0.02;
    const wmSize = Math.max(renderW * 0.06, 36);
    
    wm.style.bottom = wmBottom + 'px';
    wm.style.right = wmRight + 'px';
    wm.style.left = 'auto';
    wm.style.width = wmSize + 'px';
    wm.style.height = wmSize + 'px';
    wm.style.fontSize = '';
};

const updateWatermark = (channel) => {
    const container = document.getElementById('player-container');
    if (!container) return;
    let wm = document.getElementById('watermark-overlay');
    _wmChannel = channel;
    
    if (!channel || !channel.watermark) {
        if (wm) wm.style.display = 'none';
        if (_wmRafId) { cancelAnimationFrame(_wmRafId); _wmRafId = null; }
        return;
    }
    
    if (!wm) {
        wm = document.createElement('div');
        wm.id = 'watermark-overlay';
        wm.style.cssText = `
            position:absolute;
            bottom:0;right:0;
            z-index:9;
            display:block;
            border-top-left-radius:6px;
            backdrop-filter:blur(12px);
            -webkit-backdrop-filter:blur(12px);
            background:rgba(30,30,30,0.45);
        `;
        container.appendChild(wm);
        
        // Detect removal (anti-tamper)
        const _wmObserver = new MutationObserver(() => {
            if (!document.getElementById('watermark-overlay') && _wmChannel && _wmChannel.watermark) {
                window.location.href = '/dieu-khoan-su-dung.html';
            }
        });
        _wmObserver.observe(container, { childList: true, subtree: true });
        
        const video = document.getElementById('video-player');
        if (video) {
            video.addEventListener('loadedmetadata', positionWatermark);
            video.addEventListener('resize', positionWatermark);
        }
        window.addEventListener('resize', positionWatermark);
        document.addEventListener('fullscreenchange', () => setTimeout(positionWatermark, 100));
    }
    wm.style.display = 'block';
    positionWatermark();
};

const updateChannelInfoBar = (channel) => {
    const infoBar = document.getElementById('current-channel-info');
    if (infoBar) {
        infoBar.innerHTML = `
            <img src="${channel.logo}" alt="${channel.name}" onerror="this.onerror=null;this.style.display='none'">
            <div>
                <h2>${channel.TV || channel.name}</h2>
                <p id="epg-current-program">Đang phát trực tiếp</p>
                <div class="info-time"></div>
            </div>
        `;
    }
    // Clear sidebar EPG khi chuyển kênh
    const sidebarList = document.getElementById('epg-sidebar-list');
    if (sidebarList) { sidebarList.innerHTML = ''; sidebarList._lastSbHtml = ''; }
    // Fetch EPG ngầm, cập nhật sau khi có dữ liệu
    fetchEPG(channel);
    // Đề xuất kênh ngay lập tức (dùng EPG đã cache), rồi lại sau khi EPG mới load
    fetchRecommendations(channel);
};

// ==================== EPG (Lịch phát sóng) ====================
let _epgInterval = null;

const fetchEPG = (channel) => {
    const channelId = channel.channelId;
    // Xóa dữ liệu EPG + reco cũ ngay khi chuyển kênh
    clearInterval(_epgInterval);
    clearInterval(_recoInterval); _recoInterval = null;
    _epgMytvId = null;
    _catchupEnabled = false;
    const oldPanel = document.getElementById('epg-panel');
    if (oldPanel) { oldPanel.innerHTML = ''; oldPanel._lastHtml = ''; }
    const oldSidebar = document.getElementById('epg-sidebar-list');
    if (oldSidebar) { oldSidebar.innerHTML = ''; oldSidebar._lastSbHtml = ''; }
    const oldReco = document.getElementById('reco-strip');
    if (oldReco) { oldReco._lastHtml = ''; }
    // Reset mobile EPG
    _mobileEpgActiveDate = null;
    const mepC = document.getElementById('mobile-epg-programs');
    if (mepC) mepC.innerHTML = '';
    const medC = document.getElementById('mobile-epg-dates');
    if (medC) medC.innerHTML = '';
    const cpEl = document.getElementById('epg-current-program');
    if (cpEl) { cpEl.textContent = 'Đang phát trực tiếp'; cpEl.title = ''; }

    if (!channelId) return;
    // Chỉ fetch EPG cho fpt_/mytv_ hoặc kênh có epgMytvId được cấu hình
    const isFptOrMytv = channelId.startsWith('fpt_') || channelId.startsWith('mytv_');
    if (!isFptOrMytv && !channel.epgMytvId) return;
    const _apiOrigin = 'https://cdn-vn.iof.vn';
    const dayBeforeYesterday = new Date(); dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
    const dateStr = `${dayBeforeYesterday.getFullYear()}-${String(dayBeforeYesterday.getMonth()+1).padStart(2,'0')}-${String(dayBeforeYesterday.getDate()).padStart(2,'0')}`;
    const epgUrl = _apiOrigin + '/api/epg/' + encodeURIComponent(channelId) + '?date=' + dateStr + '&days=4';
    fetch(epgUrl, { signal: AbortSignal.timeout(20000) })
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(data => {
            if (data.programs && data.programs.length > 0) {
                _allEpgPrograms = data.programs;
                _epgMytvId = data.mytvId || null;
                _catchupEnabled = !!data.catchupEnabled;
                renderEPG(data.programs, channelId);
                clearInterval(_epgInterval);
                // Render lại mỗi 30s (cập nhật % progress, highlight chương trình hiện tại)
                _epgInterval = setInterval(() => renderEPG(_allEpgPrograms, channelId), 30000);
                // Re-fetch EPG mỗi 5 phút để lấy lịch mới nhất
                setTimeout(function refetchEpg() {
                    if (!_epgInterval) return; // đã chuyển kênh
                    fetch(epgUrl, { signal: AbortSignal.timeout(20000) })
                        .then(r => r.ok ? r.json() : null)
                        .then(d => { if (d?.programs?.length) { _allEpgPrograms = d.programs; renderEPG(_allEpgPrograms, channelId); } })
                        .catch(() => {})
                        .finally(() => { if (_epgInterval) setTimeout(refetchEpg, 5 * 60 * 1000); });
                }, 5 * 60 * 1000);
                // EPG vừa load → server cache đã có → refresh recommendations
                setTimeout(() => fetchRecommendations(channel), 1500);
                // Nếu đang hiện lỗi (VD: iOS DRM) và kênh có catchup → tự động phát chương trình trước
                if (_catchupEnabled) {
                    const ov = document.getElementById('buffer-overlay');
                    if (ov && ov.style.display === 'flex' && ov.querySelector('.fa-exclamation-circle') && !ov.querySelector('.catchup-err-btn')) {
                        // iOS DRM: delay 3s rồi auto-play previous program
                        if (_isIOS && currentChannel) {
                            const now = Math.floor(Date.now() / 1000);
                            const pastProgs = data.programs.filter(p => p.endTime <= now);
                            const lastProg = pastProgs.length > 0 ? pastProgs[pastProgs.length - 1] : null;
                            if (lastProg) {
                                const msgEl = ov.querySelector('p');
                                let countdown = 3;
                                if (msgEl) msgEl.textContent = 'Đang chuyển sang xem lại... (' + countdown + ')';
                                const _cdTimer = setInterval(() => {
                                    countdown--;
                                    if (countdown <= 0) {
                                        clearInterval(_cdTimer);
                                        if (currentChannel) playCatchup(lastProg, currentChannel.channelId);
                                    } else if (msgEl) {
                                        msgEl.textContent = 'Đang chuyển sang xem lại... (' + countdown + ')';
                                    }
                                }, 1000);
                                return;
                            }
                        }
                        // Fallback: show button
                        const btn = document.createElement('button');
                        btn.className = 'catchup-err-btn';
                        btn.style.cssText = 'margin-top:8px;background:#1976d2;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:1rem;cursor:pointer';
                        btn.innerHTML = '<i class="fas fa-history"></i> Xem lại chương trình trước';
                        btn.addEventListener('click', () => {
                            const now = Math.floor(Date.now() / 1000);
                            const pastProgs = data.programs.filter(p => p.endTime <= now);
                            const lastProg = pastProgs.length > 0 ? pastProgs[pastProgs.length - 1] : null;
                            if (lastProg && currentChannel) playCatchup(lastProg, currentChannel.channelId);
                        });
                        ov.appendChild(btn);
                    }
                }
            }
        })
        .catch(() => {});
};

const renderEPG = (programs, channelId) => {
    const now = Math.floor(Date.now() / 1000);
    const current = programs.find(p => p.startTime <= now && p.endTime > now);
    const upcoming = programs.filter(p => p.startTime > now).slice(0, 8);
    const past = programs.filter(p => p.endTime <= now);

    // Cập nhật dòng trạng thái trong header
    const cpEl = document.getElementById('epg-current-program');
    if (cpEl && current) {
        const pct = Math.round(((now - current.startTime) / (current.endTime - current.startTime)) * 100);
        cpEl.textContent = `▶ ${current.title}`;
        cpEl.title = `${fmtTime(current.startTime)} – ${fmtTime(current.endTime)} (${pct}%)`;
    }

    // Cập nhật player-info-bar: thời gian + tên chương trình hiện tại
    const infoBar = document.getElementById('current-channel-info');
    if (infoBar && current) {
        const progEl = infoBar.querySelector('#epg-current-program');
        if (progEl) {
            const pct = Math.round(((now - current.startTime) / (current.endTime - current.startTime)) * 100);
            progEl.textContent = `▶ ${current.title}`;
            progEl.title = `${fmtTime(current.startTime)} – ${fmtTime(current.endTime)} (${pct}%)`;
        }
        const timeEl = infoBar.querySelector('.info-time');
        if (timeEl) {
            timeEl.textContent = `${fmtTime(current.startTime)} - ${fmtTime(current.endTime)}`;
        }
    }

    // ===== Sidebar + Main EPG data (shared) =====
    const sidebar = document.getElementById('epg-sidebar-list');
    const sidebarDate = document.getElementById('epg-sidebar-date');
    const canCatchup = channelId && _catchupEnabled;
    const allItems = [...past, current, ...upcoming].filter(Boolean);

    // Build EPG HTML (shared between sidebar + main column)
    let sbHtml = '';
    let sbLastDate = '';
    allItems.forEach((p, idx) => {
        const pDate = new Date(p.startTime * 1000).toDateString();
        if (pDate !== sbLastDate) {
            sbLastDate = pDate;
            const d = new Date(p.startTime * 1000);
            const todayD = new Date(); todayD.setHours(0,0,0,0);
            const yesterdayD = new Date(todayD); yesterdayD.setDate(yesterdayD.getDate()-1);
            const tomorrowD = new Date(todayD); tomorrowD.setDate(tomorrowD.getDate()+1);
            const ds = new Date(d); ds.setHours(0,0,0,0);
            let dlabel = '';
            if (ds.getTime() === todayD.getTime()) dlabel = 'Hôm nay';
            else if (ds.getTime() === yesterdayD.getTime()) dlabel = 'Hôm qua';
            else if (ds.getTime() === tomorrowD.getTime()) dlabel = 'Ngày mai';
            else dlabel = d.toLocaleDateString('vi-VN', {weekday:'short', day:'2-digit', month:'2-digit'});
            sbHtml += `<div class="epg-sb-date-divider">${dlabel}</div>`;
        }
        const isCurrent = current && p.startTime === current.startTime && p.endTime === current.endTime;
        const isPast = p.endTime <= now;
        const isPlaying = _catchupProgram && p.startTime === _catchupProgram.startTime && p.endTime === _catchupProgram.endTime;
        const pct = isCurrent ? Math.round(((now - p.startTime) / Math.max(1, p.endTime - p.startTime)) * 100) : 0;
        const clickable = isPast && canCatchup;
        const stateClass = isPlaying ? 'sb-playing' : isCurrent ? 'sb-current' : isPast ? 'sb-past' : '';
        let tag = '';
        if (isCurrent) tag = `<div class="epg-sb-tag" style="background:rgba(255,61,0,0.15);color:#ff6030;"><span style="animation:blink 1.5s infinite;">●</span> Đang phát sóng</div>`;
        else if (isPlaying) tag = `<div class="epg-sb-tag" style="color:#4fc3f7;">● Đang phát</div>`;
        else if (clickable) tag = `<div class="epg-sb-tag" style="background:rgba(79,195,247,0.1);color:#4fc3f7;">↺ Xem lại</div>`;
        let progress = '';
        if (isCurrent) progress = `<div class="epg-sb-progress" style="width:${pct}%;"></div>`;
        sbHtml += `<div class="epg-sb-item ${stateClass}${clickable ? ' sb-catchup' : ''}" data-idx="${idx}">
            <div class="epg-sb-time">${fmtTime(p.startTime)} - ${fmtTime(p.endTime)}</div>
            <div class="epg-sb-content">
                <div class="epg-sb-title">${esc(p.title)}</div>
                ${tag}
            </div>
            ${progress}
        </div>`;
    });

    // Helper: attach EPG click handlers to a container
    const attachEpgHandlers = (container) => {
        if (canCatchup) {
            container.querySelectorAll('.sb-catchup').forEach(el => {
                el.addEventListener('click', () => {
                    const i = parseInt(el.dataset.idx);
                    const prog = allItems[i];
                    if (prog) playCatchup(prog, channelId);
                });
            });
        }
        const liveCard = container.querySelector('.sb-current');
        if (liveCard && _isCatchupMode) {
            liveCard.style.cursor = 'pointer';
            liveCard.addEventListener('click', () => stopCatchup());
        }
    };

    if (sidebar) {
        if (sidebarDate) {
            const today = new Date();
            sidebarDate.textContent = `Hôm nay (${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')})`;
        }
        if (sidebar._lastSbHtml !== sbHtml) {
            sidebar._lastSbHtml = sbHtml;
            sidebar.innerHTML = sbHtml;
            attachEpgHandlers(sidebar);
            const scrollTarget = _catchupProgram
                ? sidebar.querySelector('.sb-playing')
                : sidebar.querySelector('.sb-current');
            if (scrollTarget) {
                setTimeout(() => { scrollTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); }, 50);
            }
        }
    }

    // ===== Bottom EPG panel (horizontal strip, kept for fallback/mobile) =====
    let panel = document.getElementById('epg-panel');
    if (!panel) { if (isMobile) renderMobileEPG(programs, channelId); return; }

    // Setup drag scroll 1 lần
    if (!panel._dragSetup) {
        panel._dragSetup = true;
        let isDragging = false, startX = 0, scrollLeft = 0, dragMoved = false;
        let touchMoved = false;
        panel.addEventListener('mousedown', e => {
            isDragging = true;
            dragMoved = false;
            panel.style.cursor = 'grabbing';
            startX = e.pageX - panel.offsetLeft;
            scrollLeft = panel.scrollLeft;
            e.preventDefault();
        });
        panel.addEventListener('mousemove', e => {
            if (!isDragging) return;
            const x = e.pageX - panel.offsetLeft;
            const dx = Math.abs(x - startX);
            if (dx > 5) dragMoved = true;
            panel.scrollLeft = scrollLeft - (x - startX);
        });
        panel.addEventListener('mouseup', () => { isDragging = false; panel.style.cursor = 'grab'; });
        panel.addEventListener('mouseleave', () => { isDragging = false; panel.style.cursor = 'grab'; });
        panel.addEventListener('touchstart', e => {
            isDragging = true;
            touchMoved = false;
            startX = e.touches[0].pageX - panel.offsetLeft;
            scrollLeft = panel.scrollLeft;
        }, { passive: true });
        panel.addEventListener('touchmove', e => {
            if (!isDragging) return;
            const x = e.touches[0].pageX - panel.offsetLeft;
            if (Math.abs(x - startX) > 5) touchMoved = true;
            panel.scrollLeft = scrollLeft - (x - startX);
        }, { passive: true });
        panel.addEventListener('touchend', () => { isDragging = false; });
        panel._wasDragged = () => dragMoved || touchMoved;
    }

    const divider = (label, color) => `<div class="epg-divider"><div class="epg-divider-line"></div><div class="epg-divider-dot" style="background:${color};box-shadow:0 0 6px ${color};"></div><div class="epg-divider-label" style="color:${color};">${label}</div><div class="epg-divider-line"></div></div>`;
    const dateLabel = (ts) => {
        const d = new Date(ts * 1000);
        const today = new Date(); today.setHours(0,0,0,0);
        const yesterday = new Date(today); yesterday.setDate(yesterday.getDate()-1);
        const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
        const ds = new Date(d); ds.setHours(0,0,0,0);
        let label = '';
        if (ds.getTime() === today.getTime()) label = 'Hôm nay';
        else if (ds.getTime() === yesterday.getTime()) label = 'Hôm qua';
        else if (ds.getTime() === tomorrow.getTime()) label = 'Ngày mai';
        else label = d.toLocaleDateString('vi-VN', {weekday:'short', day:'2-digit', month:'2-digit'});
        return `<div style="flex-shrink:0;display:flex;align-items:center;padding:0 10px;"><div style="writing-mode:vertical-lr;transform:rotate(180deg);font-size:0.58rem;font-weight:600;color:#ff8a65;letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap;">${label}</div></div>`;
    };

    const fmtDate = (ts) => { const d = new Date(ts * 1000); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0'); };

    let html = '';
    let lastGroup = '';
    let lastDateH = '';
    allItems.forEach((p, idx) => {
        const pDate = new Date(p.startTime * 1000).toDateString();
        if (pDate !== lastDateH) {
            lastDateH = pDate;
            html += dateLabel(p.startTime);
        }
        const isCurrent = current && p.startTime === current.startTime && p.endTime === current.endTime;
        const isPast = p.endTime <= now;
        const isFuture = p.startTime > now && !isCurrent;
        const isPlaying = _catchupProgram && p.startTime === _catchupProgram.startTime && p.endTime === _catchupProgram.endTime;
        const pct = isCurrent ? Math.round(((now - p.startTime) / Math.max(1, p.endTime - p.startTime)) * 100) : 0;
        const clickable = isPast && canCatchup;

        const group = isCurrent ? 'current' : isPast ? 'past' : 'future';
        if (group !== lastGroup && lastGroup !== '') {
            if (group === 'current') html += divider('LIVE', '#ff3d00');
            else if (group === 'future') html += divider('Tiếp', '#555');
        }
        lastGroup = group;

        const stateClass = isPlaying ? 'epg-playing' : isCurrent ? 'epg-current' : isPast ? 'epg-past' : 'epg-future';
        const timeColor = isPlaying ? '#4fc3f7' : isCurrent ? '#ff6030' : isPast ? '#888' : '#999';
        const titleColor = isPlaying ? '#fff' : isCurrent ? '#fff' : isPast ? '#aaa' : '#ccc';
        const titleWeight = isPlaying || isCurrent ? '500' : '400';

        let tag = '';
        if (isCurrent) tag = `<div class="epg-tag" style="background:rgba(255,61,0,0.15);color:#ff6030;"><span style="animation:blink 1.5s infinite;">●</span> Trực tiếp</div>`;
        else if (isPlaying) tag = `<div class="epg-tag" style="color:#4fc3f7;font-weight:500;">● Đang phát</div>`;
        else if (clickable) tag = `<div class="epg-tag" style="background:rgba(79,195,247,0.1);color:#4fc3f7;">↺ Xem lại</div>`;

        let progress = '';
        if (isCurrent) progress = `<div class="epg-progress" style="background:linear-gradient(90deg,#ff3d00,#ff8040);width:${pct}%;"></div>`;
        else if (isPlaying) progress = `<div class="epg-progress" style="background:linear-gradient(90deg,#4fc3f7,#03a9f4);width:100%;"></div>`;

        html += `<div class="epg-card ${stateClass}${clickable ? ' epg-catchup' : ''}" data-idx="${idx}" data-st="${p.startTime}">
            <div class="epg-time" style="color:${timeColor};"><span style="opacity:0.6;font-size:0.58rem;">${fmtDate(p.startTime)}</span> ${fmtTime(p.startTime)} – ${fmtTime(p.endTime)}</div>
            <div class="epg-title" style="color:${titleColor};font-weight:${titleWeight};">${esc(p.title)}</div>
            ${tag}${progress}
        </div>`;
    });
    if (panel._lastHtml !== html) {
        panel._lastHtml = html;
        panel.innerHTML = html;

        if (canCatchup) {
            panel.querySelectorAll('.epg-catchup').forEach(el => {
                el.addEventListener('click', () => {
                    if (panel._wasDragged && panel._wasDragged()) return;
                    const i = parseInt(el.dataset.idx);
                    const prog = allItems[i];
                    if (prog) playCatchup(prog, channelId);
                });
            });
        }
        const liveCard = panel.querySelector('.epg-current');
        if (liveCard && _isCatchupMode) {
            liveCard.style.cursor = 'pointer';
            liveCard.addEventListener('click', () => {
                if (panel._wasDragged && panel._wasDragged()) return;
                stopCatchup();
            });
        }

        const scrollTarget = _catchupProgram
            ? panel.querySelector('.epg-playing')
            : panel.querySelector('.epg-current');
        if (scrollTarget) {
            setTimeout(() => { scrollTarget.scrollIntoView({ inline: 'center', behavior: 'instant' }); }, 50);
        }
    }
    if (isMobile) renderMobileEPG(programs, channelId);
};

// ==================== MOBILE EPG VIEW ====================
let _mobileEpgActiveDate = null; // selected date string e.g. '2026-05-08'

const renderMobileEPG = (programs, channelId) => {
    if (!isMobile) return;
    const container = document.getElementById('mobile-epg-programs');
    const datesBar = document.getElementById('mobile-epg-dates');
    if (!container || !datesBar) return;
    if (!programs || programs.length === 0) {
        container.innerHTML = '<div class="mep-empty">Chưa có lịch phát sóng</div>';
        datesBar.innerHTML = '';
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const canCatchup = channelId && _catchupEnabled;

    // Group programs by date (Vietnam timezone)
    const dateGroups = {};
    const dateOrder = [];
    programs.forEach(p => {
        const d = new Date(p.startTime * 1000);
        const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
        if (!dateGroups[key]) { dateGroups[key] = []; dateOrder.push(key); }
        dateGroups[key].push(p);
    });

    // Date labels
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const dateName = (key) => {
        if (key === today) return 'Hôm nay';
        if (key === yesterday) return 'Hôm qua';
        if (key === tomorrow) return 'Ngày mai';
        const d = new Date(key + 'T00:00:00');
        return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    };

    // Default to today
    if (!_mobileEpgActiveDate || !dateGroups[_mobileEpgActiveDate]) {
        _mobileEpgActiveDate = dateGroups[today] ? today : dateOrder[dateOrder.length - 1];
    }

    // Render date buttons
    let datesHtml = '';
    dateOrder.forEach(key => {
        datesHtml += `<button class="med-btn${key === _mobileEpgActiveDate ? ' active' : ''}" data-date="${key}">${dateName(key)}</button>`;
    });
    if (datesBar.innerHTML !== datesHtml) {
        datesBar.innerHTML = datesHtml;
        datesBar.querySelectorAll('.med-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _mobileEpgActiveDate = btn.dataset.date;
                renderMobileEPG(programs, channelId);
            });
        });
        // Scroll active date into view
        const activeBtn = datesBar.querySelector('.med-btn.active');
        if (activeBtn) setTimeout(() => activeBtn.scrollIntoView({ inline: 'center', behavior: 'instant' }), 50);
    }

    // Render programs for selected date
    const dayProgs = dateGroups[_mobileEpgActiveDate] || [];
    let html = '';
    dayProgs.forEach((p, idx) => {
        const isCurrent = p.startTime <= now && p.endTime > now;
        const isPast = p.endTime <= now;
        const isPlaying = _catchupProgram && p.startTime === _catchupProgram.startTime && p.endTime === _catchupProgram.endTime;
        const clickable = isPast && canCatchup;
        const pct = isCurrent ? Math.round(((now - p.startTime) / Math.max(1, p.endTime - p.startTime)) * 100) : 0;
        const cls = isPlaying ? 'mep-playing' : isCurrent ? 'mep-current' : isPast ? 'mep-past' : '';

        let tag = '';
        if (isCurrent) tag = `<div class="mep-tag" style="background:rgba(255,61,0,0.15);color:#ff6030;"><span style="animation:blink 1.5s infinite;">●</span> Trực tiếp</div>`;
        else if (isPlaying) tag = `<div class="mep-tag" style="color:#4fc3f7;font-weight:500;">● Đang phát</div>`;
        else if (clickable) tag = `<div class="mep-tag" style="background:rgba(79,195,247,0.1);color:#4fc3f7;">↺ Xem lại</div>`;

        let progress = '';
        if (isCurrent) progress = `<div class="mep-progress"><div class="mep-progress-bar" style="width:${pct}%"></div></div>`;

        html += `<div class="mep-item ${cls}${clickable ? ' mep-catchup' : ''}" data-idx="${idx}">
            <div class="mep-time">${fmtTime(p.startTime)}</div>
            <div class="mep-body">
                <div class="mep-title">${esc(p.title)}</div>
                ${tag}${progress}
            </div>
        </div>`;
    });

    container.innerHTML = html;

    // Catchup click
    if (canCatchup) {
        container.querySelectorAll('.mep-catchup').forEach(el => {
            el.addEventListener('click', () => {
                const i = parseInt(el.dataset.idx);
                const prog = dayProgs[i];
                if (prog) playCatchup(prog, channelId);
            });
        });
    }

    // Click live card → stop catchup
    if (_isCatchupMode) {
        container.querySelectorAll('.mep-current').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => stopCatchup());
        });
    }

    // Scroll to playing (catchup) or current (live)
    const scrollTarget = container.querySelector('.mep-playing') || (_mobileEpgActiveDate === today ? container.querySelector('.mep-current') : null);
    if (scrollTarget) {
        setTimeout(() => scrollTarget.scrollIntoView({ block: 'center', behavior: 'instant' }), 80);
    }
};

// Setup mobile content tabs
const initMobileContentTabs = () => {
    if (!isMobile) return;
    const tabsContainer = document.getElementById('mobile-content-tabs');
    if (!tabsContainer) return;
    const btns = tabsContainer.querySelectorAll('.mct-btn');
    const mainEl = document.querySelector('main.main-layout');
    const epgView = document.getElementById('mobile-epg-view');

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            if (tab === 'epg') {
                document.documentElement.classList.add('epg-tab-active');
                if (mainEl) mainEl.style.display = 'none';
                if (epgView) epgView.style.display = '';
                _mobileEpgActiveDate = null; // reset to today
                if (_allEpgPrograms && currentChannel) {
                    renderMobileEPG(_allEpgPrograms, currentChannel.channelId);
                } else if (epgView) {
                    const c = document.getElementById('mobile-epg-programs');
                    if (c) c.innerHTML = '<div class="mep-empty">Chưa có lịch phát sóng cho kênh này</div>';
                }
            } else {
                document.documentElement.classList.remove('epg-tab-active');
                if (mainEl) mainEl.style.display = '';
                if (epgView) epgView.style.display = 'none';
                // Scroll tới kênh đang xem
                setTimeout(() => {
                    const activeItem = document.querySelector('.channel-item.active');
                    if (activeItem) {
                        activeItem.scrollIntoView({ block: 'center' });
                    } else {
                        window.scrollTo({ top: 0 });
                    }
                }, 50);
            }
        });
    });
};

const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const formatVietnamHHmm = (ts) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date(ts * 1000));
    const hour = parts.find(p => p.type === 'hour')?.value || '00';
    const minute = parts.find(p => p.type === 'minute')?.value || '00';
    return `${hour}${minute}`;
};

const esc = (s) => (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

// ==================== RECOMMENDATIONS ====================
let _recoInterval = null;
let _recoRetryTimer = null;
let _recoRafId = null;

const fetchRecommendations = (channel) => {
    if (!channel?.channelId) return;
    clearInterval(_recoInterval);
    clearTimeout(_recoRetryTimer);
    cancelAnimationFrame(_recoRafId);

    const _recoBase = 'https://cdn-vn.iof.vn';

    fetch(`${_recoBase}/api/recommendations/${encodeURIComponent(channel.channelId)}`,
        { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(data => {
            if (currentChannel?.channelId !== channel.channelId) return;
            if (data.recommendations?.length) {
                renderRecommendations(data.recommendations, channel.channelId, _recoBase);
                // Refresh mỗi 5 phút (khớp với server cache TTL)
                _recoInterval = setInterval(() => {
                    if (currentChannel?.channelId !== channel.channelId) return clearInterval(_recoInterval);
                    fetch(`${_recoBase}/api/recommendations/${encodeURIComponent(channel.channelId)}`,
                        { signal: AbortSignal.timeout(10000) })
                        .then(r => r.json())
                        .then(d => { if (d.recommendations?.length) renderRecommendations(d.recommendations, channel.channelId, _recoBase); })
                        .catch(() => {});
                }, 5 * 60 * 1000);
            } else {
                // EPG chưa sẵn sàng → thử lại sau 2 phút
                _recoRetryTimer = setTimeout(() => fetchRecommendations(channel), 2 * 60 * 1000);
            }
        })
        .catch(() => {});
};

const renderRecommendations = (recs, fromChannelId, streamBase) => {
    let strip = document.getElementById('reco-strip');
    if (!strip) return;

    // Build 1 set of cards
    const makeCards = () => {
        let h = '';
        recs.forEach((rec, i) => {
            const timeStr = rec.startTime ? fmtTime(rec.startTime) : '';
            const isActive = rec.channelId === fromChannelId;
            h += `${i > 0 ? '<div class="reco-sep"></div>' : ''}
        <div class="reco-card${isActive ? ' reco-active' : ''}" data-id="${esc(rec.channelId)}" title="${esc(rec.TV + ' – ' + rec.title)}">
            <img class="reco-logo" src="${esc(rec.logo)}" alt="" onerror="this.style.display='none'">
            <div class="reco-info">
                <div class="reco-ch">${esc(rec.TV)}</div>
                <div class="reco-prog">${timeStr ? `<span style="opacity:0.45;font-size:0.58rem">${timeStr} </span>` : ''}${esc(rec.title)}</div>
            </div>
        </div>`;
        });
        return h;
    };

    const cardsHtml = makeCards();
    // Chỉ update DOM khi nội dung thay đổi (tránh reset scroll position)
    if (strip._lastHtml === cardsHtml) return;
    strip._lastHtml = cardsHtml;

    // Duplicate cards for seamless loop
    strip.innerHTML = `<div class="reco-label">● Kênh đang phát</div><div id="reco-clip"><div id="reco-inner">${cardsHtml}<div class="reco-sep"></div>${cardsHtml}</div></div>`;

    // Tính duration sau khi layout ổn định rồi mới bật animation
    cancelAnimationFrame(_recoRafId);
    const inner = document.getElementById('reco-inner');
    if (!inner) return;

    const SPEED = 50; // px/giây
    const applyScroll = () => {
        const halfW = inner.scrollWidth / 2;
        if (halfW <= 10) { setTimeout(applyScroll, 200); return; }
        const duration = halfW / SPEED;
        inner.style.animationDuration = duration + 's';
        inner.classList.add('reco-scrolling');
    };
    setTimeout(applyScroll, 400);

    // ---- Click handler ----
    const cards = inner.querySelectorAll('.reco-card');
    cards.forEach((el, idx) => {
        if (idx >= recs.length) return; // bỏ qua clone
        el.addEventListener('click', e => {
            e.stopPropagation();
            const targetId = el.dataset.id;
            fetch(`${streamBase}/api/recommendations/click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: fromChannelId, to: targetId }),
            }).catch(() => {});
            const ch = allChannels.find(c => c.channelId === targetId);
            if (ch) {
                selectChannel(ch);
            } else {
                fetch(streamBase + '/api/channels/list')
                    .then(r => r.json())
                    .then(data => {
                        const channels = data.channels || data;
                        const found = channels.find(c => c.channelId === targetId);
                        if (found) selectChannel(found);
                    }).catch(() => {});
            }
        });
    });
};


const preloadAdjacentChannels = () => {};
const preloadChannel = (channel) => {};

// ==================== AUTO FAVORITE ====================
let watchTimer = null;
const startWatchTimer = (channel) => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        if (!isFavorite(channel.name)) {
            const favs = getFavorites();
            favs.push(channel);
            saveFavorites(favs);
            renderFavorites();
            renderSidebarChannels();
        }
    }, 60 * 60 * 1000); // 60 phút
};

const stopWatchTimer = () => { clearTimeout(watchTimer); };

// ==================== CATCHUP (Xem lại) ====================
let _isCatchupMode = false;
let _catchupProgram = null;
let _allEpgPrograms = null; // full EPG list for auto-next
let _epgMytvId = null; // MyTV channel ID mapped from FPT (for catchup)
let _catchupEnabled = false; // channel actually supports catchup

const findNextCatchupProgram = (currentProg) => {
    const progs = _allEpgPrograms;
    if (!progs || !currentProg) return null;
    const now = Math.floor(Date.now() / 1000);
    const idx = progs.findIndex(p => p.startTime === currentProg.startTime && p.endTime === currentProg.endTime);
    if (idx < 0 || idx >= progs.length - 1) return null;
    const next = progs[idx + 1];
    if (next.endTime > now) return null;
    return next;
};

const playCatchup = (program, channelId) => {
    const ch = currentChannel;
    if (!ch) return;
    const cid = channelId || ch.channelId;
    if (!cid) return;
    // Chỉ cho xem lại nếu kênh được đánh dấu catchupEnabled
    if (!_catchupEnabled) return;
    const stStr = formatVietnamHHmm(program.startTime);
    const etStr = formatVietnamHHmm(program.endTime);
    const catchupUrl = 'https://cdn-vn.iof.vn/api/catchup/' + encodeURIComponent(cid) + '?st=' + stStr + '&et=' + etStr + '&endTs=' + encodeURIComponent(program.endTime);

    _isCatchupMode = true;
    _catchupProgram = program;
    destroyHls();
    const video = getVideo();
    if (!video) return;
    setPlayerMode('catchup');
    showBufferingOverlay(true, 'Đang tải chương trình xem lại...', ch.logo);
    updateChannelInfoBar(ch);
    const cpEl = document.getElementById('epg-current-program');
    if (cpEl) cpEl.textContent = '▶ Xem lại: ' + (program.title || '');
    if (_allEpgPrograms) renderEPG(_allEpgPrograms, cid);

    // Mobile: chuyển sang tab EPG và scroll player lên
    if (isMobile) {
        // Giữ ngày của chương trình đang xem lại
        const progDate = new Date(program.startTime * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        _mobileEpgActiveDate = progDate;
        scrollToPlayer();
        const epgTabBtn = document.querySelector('#mobile-content-tabs .mct-btn[data-tab="epg"]');
        if (epgTabBtn && !epgTabBtn.classList.contains('active')) {
            // Chuyển tab mà không reset date
            const mainEl = document.querySelector('main.main-layout');
            const epgView = document.getElementById('mobile-epg-view');
            document.querySelectorAll('#mobile-content-tabs .mct-btn').forEach(b => b.classList.remove('active'));
            epgTabBtn.classList.add('active');
            document.documentElement.classList.add('epg-tab-active');
            if (mainEl) mainEl.style.display = 'none';
            if (epgView) epgView.style.display = '';
        }
    }

    // Truyền URL trực tiếp cho JW Player (như reference code)
    const catchupVideo = initCatchupPlayer(catchupUrl);
    createCatchupControls();
    catchupVideo.onplaying = () => { showBufferingOverlay(false); };
    catchupVideo.onended = () => {
        const next = findNextCatchupProgram(program);
        if (next) playCatchup(next, cid);
        else stopCatchup();
    };
    catchupVideo.onerror = (e) => {
        console.warn('[Catchup Video Error]', e);
        showBufferingOverlay(true, 'Lỗi xem lại - thử chương trình khác', ch.logo);
    };
};

const stopCatchup = () => {
    if (!_isCatchupMode) return;
    _isCatchupMode = false;
    _catchupProgram = null;
    destroyCatchupPlayer();
    setPlayerMode('live');
    if (currentChannel) {
        if (currentChannel.source === 'tv360') playTv360Channel(currentChannel);
        else if (currentChannel.mytvDrm) playMytvDrmChannel(currentChannel);
        else playChannelDirect(currentChannel);
        fetchEPG(currentChannel);
    }
};

// ==================== CHANNEL SELECTION ====================
const selectChannel = (channel) => {
    if (isChangingChannel) return;
    isChangingChannel = true;

    // Thoát catchup nếu đang xem lại
    if (_isCatchupMode) {
        _isCatchupMode = false;
        _catchupProgram = null;
        setPlayerMode('live');
    }

    const updatedChannel = allChannels.find(c => c.name === channel.name) || channel;

    // Hiện overlay NGAY LẬP TỨC trước khi bất kỳ DOM nào khác thay đổi
    showBufferingOverlay(true, 'Đang khởi động kênh...', updatedChannel.logo);

    // Để browser paint overlay trước, rồi mới làm các việc khác
    requestAnimationFrame(() => {
        currentChannel = updatedChannel;
        currentChannelIndex = allChannels.findIndex(c => c.name === updatedChannel.name);
        localStorage.setItem('lastChannel', JSON.stringify({ name: currentChannel.name, TV: currentChannel.TV }));
        document.title = `${updatedChannel.TV || updatedChannel.name} | XEMTV.VN`;
        updateUrlForChannel(updatedChannel);

        // Route đúng player theo source
        if (updatedChannel.source === 'tv360') {
            playTv360Channel(updatedChannel);
        } else if (updatedChannel.mytvDrm || updatedChannel.drm) {
            updatedChannel.mytvDrm = true;
            playMytvDrmChannel(updatedChannel);
        } else {
            playChannelDirect(updatedChannel);
        }
        scrollToPlayer();
        highlightCurrentChannel();
        highlightSidebarChannel();
        updateChannelInfoBar(updatedChannel);
        // Desktop: auto-switch sidebar to EPG tab only if channel has EPG
        if (!isMobile) {
            const chId = updatedChannel.channelId || '';
            const hasEpg = chId.startsWith('fpt_') || chId.startsWith('mytv_') || !!updatedChannel.epgMytvId;
            if (hasEpg) switchSidebarToEpg();
        }
        startWatchTimer(updatedChannel);
        startHeartbeat(updatedChannel);
        _startWatchdog();

        isChangingChannel = false;
    });
};

const navigateChannel = (direction) => {
    if (allChannels.length === 0 || isChangingChannel) return;

    let newIndex = currentChannelIndex + direction;
    if (newIndex < 0) newIndex = allChannels.length - 1;
    if (newIndex >= allChannels.length) newIndex = 0;

    const newChannel = allChannels[newIndex];
    showNumberInputFeedback((newIndex + 1).toString());
    setTimeout(hideNumberInputFeedback, CONFIG.numberInputTimeout);
    
    selectChannel(newChannel);
};

// ==================== RENDER FUNCTIONS ====================
const createChannelItem = (channel, isFavList = false) => {
    const channelIndex = allChannels.findIndex(c => c.name === channel.name);
    const isFav = isFavorite(channel.name);
    const item = document.createElement('div');
    item.className = `channel-item ${currentChannel?.name === channel.name ? 'active' : ''}`;
    item.dataset.name = channel.name;
    item.setAttribute('tabindex', '0');
    item.innerHTML = `
        <div class="channel-number">${channelIndex + 1}</div>
        <div class="channel-image">
            <img src="${channel.logo}" alt="${channel.name}" loading="lazy" onerror="this.onerror=null;this.style.display='none'">
            ${channel.catchup ? '<div class="ch-catchup-badge" title="Hỗ trợ xem lại">&#x21BA;</div>' : ''}
        </div>
        <div class="channel-info">
            <div class="channel-name">${channel.TV || channel.name}</div>
        </div>
        <button class="fav-btn ${isFav ? 'favorited' : ''}" title="${isFav ? 'Xóa khỏi yêu thích' : 'Thêm vào yêu thích'}">
            <i class="fas ${isFav ? 'fa-heart' : 'fa-plus'}"></i>
        </button>
    `;
    item.querySelector('.fav-btn').addEventListener('click', e => toggleFavorite(e, channel));
    item.addEventListener('click', e => {
        if (!e.target.closest('.fav-btn')) selectChannel(channel);
    });
    return item;
};

const hasValidURL = (channel) => !!(channel.URL || channel.playlist || channel.src || channel.mytvDrm);

const renderChannels = (channels) => {
    const list = document.getElementById('channel-list');
    if (!list) return;

    // Ẩn kênh không có link phát
    channels = channels.filter(hasValidURL);
    if (!channels.length) {
        list.innerHTML = '<div class="empty-message">Không tìm thấy kênh nào phù hợp</div>';
        const count = document.getElementById('all-count');
        if (count) count.textContent = '0 kênh';
        return;
    }

    const keyword = (document.getElementById('search-input')?.value || '').trim();
    const isSearching = !!keyword;

    if (isSearching) {
        // Chế độ tìm kiếm: hiện phẳng, không tab
        const count = document.getElementById('all-count');
        if (count) count.textContent = `${channels.length} kênh`;
        list.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'channel-grid';
        list.appendChild(grid);
        renderGridLazy(grid, list, channels);
        return;
    }

    // Xây dựng groups
    const groups = {};
    let groupKeys;
    if (_m3uMode) {
        // Chế độ M3U: tab "Tất cả" + tab theo group-title trong playlist (động)
        const order = [];
        channels.forEach(c => {
            const g = c.group || 'Khác';
            if (!groups[g]) { groups[g] = []; order.push(g); }
            groups[g].push(c);
        });
        groups['Tất cả'] = channels;
        groupKeys = ['Tất cả', ...order];
    } else {
        GROUP_ORDER.forEach(g => {
            const items = channels.filter(c => (c.group || 'Địa phương') === g);
            if (items.length) groups[g] = items;
        });
        const ungrouped = channels.filter(c => !GROUP_ORDER.includes(c.group || 'Địa phương'));
        if (ungrouped.length) groups['Khác'] = ungrouped;
        groupKeys = [...GROUP_ORDER.filter(g => groups[g]), ...(groups['Khác'] ? ['Khác'] : [])];
    }

    if (!activeTab || !groups[activeTab]) activeTab = groupKeys[0];

    const tabChannels = groups[activeTab] || [];
    const count = document.getElementById('all-count');
    if (count) count.textContent = `${allChannels.length} kênh`;

    list.innerHTML = '';

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'channel-tab-bar';
    groupKeys.forEach(g => {
        const btn = document.createElement('button');
        btn.className = `channel-tab-btn${g === activeTab ? ' active' : ''}`;
        btn.textContent = g;
        btn.dataset.group = g;
        btn.addEventListener('click', () => {
            activeTab = g;
            renderChannels(allChannels);
            highlightCurrentChannel();
        });
        tabBar.appendChild(btn);
    });
    list.appendChild(tabBar);

    // Grid kênh của tab đang chọn (render theo lô để không nghẽn khi nhiều kênh)
    const grid = document.createElement('div');
    grid.className = 'channel-grid';
    list.appendChild(grid);
    renderGridLazy(grid, list, tabChannels);
};

// Render lưới kênh theo lô, tự nạp thêm khi cuộn gần đáy (cho playlist nhiều kênh)
const _findScrollParent = (el) => {
    let p = el ? el.parentElement : null;
    while (p) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
        p = p.parentElement;
    }
    return null;
};
const renderGridLazy = (grid, list, items) => {
    // Gỡ handler cuộn cũ (khi đổi tab / render lại)
    if (list._lazyDetach) { list._lazyDetach(); list._lazyDetach = null; }
    const BATCH = 80;
    let rendered = 0;
    const renderMore = () => {
        const end = Math.min(rendered + BATCH, items.length);
        for (; rendered < end; rendered++) grid.appendChild(createChannelItem(items[rendered]));
        if (rendered >= items.length && list._lazyDetach) { list._lazyDetach(); list._lazyDetach = null; }
    };
    const scroller = _findScrollParent(list);
    const target = scroller || window;
    const onScroll = () => {
        if (rendered >= items.length) return;
        const se = scroller || document.scrollingElement || document.documentElement;
        const nearBottom = se.scrollHeight - (se.scrollTop + se.clientHeight) < 900;
        if (nearBottom) { renderMore(); setTimeout(onScroll, 0); }
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    list._lazyDetach = () => target.removeEventListener('scroll', onScroll);
    renderMore();
    // Nếu nội dung ngắn hơn màn hình → nạp tiếp cho đầy
    setTimeout(onScroll, 0);
};

const renderFavorites = () => {
    const list = document.getElementById('favorite-list');
    const count = document.getElementById('favorite-count');
    const favs = getFavorites().filter(hasValidURL);
    if (count) count.textContent = `${favs.length} kênh`;

    if (!list) return;

    if (!favs.length) {
        list.innerHTML = '<div class="empty-message">Chưa có kênh yêu thích</div>';
        return;
    }

    list.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'channel-grid';
    favs.forEach(channel => grid.appendChild(createChannelItem(channel, true)));
    list.appendChild(grid);
};

// ==================== SIDEBAR CHANNEL LIST (desktop) ====================
let _sbActiveGroup = 'VTV';

const renderSidebarChannels = () => {
    const container = document.getElementById('sidebar-channels-panel');
    if (!container) return;

    // Favorites
    const favList = document.getElementById('sb-fav-list');
    const favCount = document.getElementById('sb-fav-count');
    const favs = getFavorites().filter(hasValidURL);
    if (favCount) favCount.textContent = `${favs.length} kênh`;
    if (favList) {
        const emptyEl = favList.parentElement?.querySelector('.sb-fav-empty');
        if (!favs.length) {
            favList.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
        } else {
            if (emptyEl) emptyEl.style.display = 'none';
            favList.innerHTML = '';
            favs.forEach(ch => favList.appendChild(_createSbChItem(ch)));
        }
    }

    // All channels
    const channels = allChannels.filter(hasValidURL);
    const allCount = document.getElementById('sb-all-count');
    if (allCount) allCount.textContent = `${channels.length} kênh`;

    // Group tabs
    const tabBar = document.getElementById('sb-group-tabs');
    if (tabBar && !tabBar._rendered) {
        tabBar._rendered = true;
        const groups = {};
        GROUP_ORDER.forEach(g => {
            const items = channels.filter(c => (c.group || 'Địa phương') === g);
            if (items.length) groups[g] = items;
        });
        const groupKeys = GROUP_ORDER.filter(g => groups[g]);
        tabBar.innerHTML = '';
        groupKeys.forEach(g => {
            const btn = document.createElement('button');
            btn.className = `sb-group-btn${g === _sbActiveGroup ? ' active' : ''}`;
            btn.textContent = g;
            btn.addEventListener('click', () => {
                _sbActiveGroup = g;
                tabBar.querySelectorAll('.sb-group-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _renderSbGroupChannels();
            });
            tabBar.appendChild(btn);
        });
    }

    _renderSbGroupChannels();
};

const _renderSbGroupChannels = () => {
    const grid = document.getElementById('sb-channel-list');
    if (!grid) return;
    const channels = allChannels.filter(hasValidURL).filter(c => (c.group || 'Địa phương') === _sbActiveGroup);
    grid.innerHTML = '';
    channels.forEach(ch => grid.appendChild(_createSbChItem(ch)));
};

const _createSbChItem = (ch) => {
    const idx = allChannels.findIndex(c => c.name === ch.name);
    const isFav = isFavorite(ch.name);
    const isActive = currentChannel?.name === ch.name;
    const item = document.createElement('div');
    item.className = `sb-ch-item${isActive ? ' active' : ''}`;
    item.dataset.name = ch.name;
    item.innerHTML = `
        <span class="sb-ch-num">${idx + 1}</span>
        <button class="sb-ch-fav${isFav ? ' favorited' : ''}" title="${isFav ? 'Xóa yêu thích' : 'Thêm yêu thích'}">
            <i class="fas ${isFav ? 'fa-heart' : 'fa-plus'}"></i>
        </button>
        <img class="sb-ch-logo" src="${ch.logo}" alt="${ch.name}" loading="lazy" onerror="this.onerror=null;this.style.display='none'">
        ${ch.catchup ? '<span class="sb-ch-catchup">&#x21BA;</span>' : ''}
        <div class="sb-ch-name">${ch.TV || ch.name}</div>
    `;
    item.querySelector('.sb-ch-fav').addEventListener('click', e => {
        e.stopPropagation();
        toggleFavorite(e, ch);
        renderSidebarChannels();
    });
    item.addEventListener('click', e => {
        if (!e.target.closest('.sb-ch-fav')) selectChannel(ch);
    });
    return item;
};

const highlightSidebarChannel = () => {
    document.querySelectorAll('.sb-ch-item').forEach(el => {
        el.classList.toggle('active', currentChannel && el.dataset.name === currentChannel.name);
    });
};

const initSidebarTabs = () => {
    const tabs = document.querySelectorAll('.sidebar-tab');
    if (!tabs.length) return;
    const channelsPanel = document.getElementById('sidebar-channels-panel');
    const epgPanel = document.getElementById('sidebar-epg-panel');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.tab;
            if (channelsPanel) channelsPanel.style.display = which === 'channels' ? '' : 'none';
            if (epgPanel) epgPanel.style.display = which === 'epg' ? '' : 'none';
        });
    });
};

const switchSidebarToEpg = () => {
    const epgTab = document.querySelector('.sidebar-tab[data-tab="epg"]');
    if (epgTab && !epgTab.classList.contains('active')) {
        epgTab.click();
    }
};

const highlightCurrentChannel = () => {
    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
    });
    if (currentChannel) {
        document.querySelectorAll(`.channel-item[data-name="${currentChannel.name}"]`).forEach(item => {
            item.classList.add('active');
        });
    }
};

const scrollToPlayer = () => {
    const playerSection = document.querySelector('.player-section');
    if (playerSection) {
        if (isMobile) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
};

// ==================== SEARCH FUNCTIONS ====================
const filterChannels = () => {
    const input = document.getElementById('search-input');
    if (!input) return;
    
    const keyword = input.value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const filtered = keyword ? allChannels.filter(c => {
        const name = (c.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const tv = (c.TV || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return name.includes(keyword) || tv.includes(keyword);
    }) : allChannels;

    renderChannels(filtered);
    highlightCurrentChannel();

    if (keyword) {
        renderSuggestions(filtered);
    } else {
        const suggestions = document.getElementById('suggestions');
        if (suggestions) suggestions.style.display = 'none';
    }
};

const renderSuggestions = (results) => {
    const container = document.getElementById('suggestions');
    if (!container) return;

    if (!results.length) {
        container.innerHTML = '<div class="suggestion-item no-results">Không tìm thấy kênh</div>';
        container.style.display = 'block';
        return;
    }

    container.innerHTML = results.slice(0, 8).map(c => `
        <div class="suggestion-item" data-name="${c.name}">
            <img src="${c.logo}" alt="${c.name}" loading="lazy" onerror="this.onerror=null;this.style.display='none'">
            <div class="channel-name">${c.TV || c.name}</div>
        </div>
    `).join('');

    container.querySelectorAll('.suggestion-item:not(.no-results)').forEach(item => {
        item.addEventListener('click', () => {
            const channel = allChannels.find(c => c.name === item.dataset.name);
            if (channel) {
                selectChannel(channel);
                container.style.display = 'none';
                const searchInput = document.getElementById('search-input');
                if (searchInput) {
                    searchInput.value = '';
                    filterChannels();
                }
            }
        });
    });

    container.style.display = 'block';
};

// ==================== NUMBER INPUT ====================
const handleNumberInput = (number) => {
    clearTimeout(numberInputTimeout);
    numberInputBuffer += number;
    showNumberInputFeedback(numberInputBuffer);

    numberInputTimeout = setTimeout(() => {
        const channelIndex = parseInt(numberInputBuffer) - 1;
        if (channelIndex >= 0 && channelIndex < allChannels.length) {
            selectChannel(allChannels[channelIndex]);
        }
        numberInputBuffer = '';
        hideNumberInputFeedback();
    }, CONFIG.numberInputTimeout);
};

const showNumberInputFeedback = (numbers) => {
    let feedback = document.getElementById('number-input-feedback');
    if (!feedback) {
        feedback = document.createElement('div');
        feedback.id = 'number-input-feedback';
        feedback.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            z-index: 1000;
            font-size: 24px;
            font-weight: bold;
            font-family: monospace;
        `;
        document.body.appendChild(feedback);
    }
    feedback.textContent = numbers;
    feedback.style.display = 'block';
};

const hideNumberInputFeedback = () => {
    const feedback = document.getElementById('number-input-feedback');
    if (feedback) feedback.style.display = 'none';
};

// ==================== FETCH CHANNELS ====================
let lastModified = null;

const showLiveIndicator = (status) => {};

const applyChannelData = (data) => {
    const filtered = data.filter(hasValidURL);
    // So sánh chỉ name + channelId (không so src vì token thay đổi mỗi lần fetch)
    const changed = allChannels.length !== filtered.length ||
        [0, Math.floor(filtered.length / 2), filtered.length - 1].some(
            i => filtered[i] && (allChannels[i]?.name !== filtered[i].name || allChannels[i]?.channelId !== filtered[i].channelId)
        );
    // Luôn cập nhật src (token mới) cho tất cả kênh, kể cả khi danh sách không đổi
    if (!changed && allChannels.length > 0) {
        for (let i = 0; i < allChannels.length; i++) {
            if (filtered[i] && allChannels[i].name === filtered[i].name) {
                allChannels[i].src = filtered[i].src;
            }
        }
        clearChannelCache();
        if (currentChannel) {
            const up = filtered.find(c => c.name === currentChannel.name);
            if (up) currentChannel.src = up.src;
        }
        return;
    }
    if (!changed) return;
    allChannels = filtered;
    clearChannelCache();
    const sbGroupTabs = document.getElementById('sb-group-tabs');
    if (sbGroupTabs) sbGroupTabs._rendered = false;
    renderChannels(allChannels);
    renderFavorites();
    renderSidebarChannels();
    showLiveIndicator('updated');
    setTimeout(() => showLiveIndicator('live'), 2000);

    if (currentChannel) {
        const updatedCurrent = allChannels.find(c => c.name === currentChannel.name);
        // Chỉ restart nếu channelId thay đổi thực sự (không restart nếu chỉ URL/rkey đổi,
        // vì proxy tự cập nhật rkey — restart giữa chừng sẽ làm gãy stream)
        if (updatedCurrent && updatedCurrent.channelId !== currentChannel.channelId) {
            selectChannel(updatedCurrent);
        } else if (updatedCurrent) {
            // Cập nhật metadata nhưng không restart
            currentChannel = updatedCurrent;
        }
    }

    if (!currentChannel || !allChannels.some(c => c.name === currentChannel?.name)) {
        // Ưu tiên 1: URL path (chia sẻ link)
        const urlSlug = getChannelFromUrl();
        let matched = null;
        if (urlSlug) {
            matched = allChannels.find(c => toSlug(c.TV || c.name) === urlSlug);
        }
        if (matched) {
            selectChannel(matched);
        } else {
            // Ưu tiên 2: localStorage
            const lastChannel = JSON.parse(localStorage.getItem('lastChannel') || 'null');
            if (lastChannel && allChannels.some(c => c.name === lastChannel.name)) {
                selectChannel(allChannels.find(c => c.name === lastChannel.name));
            } else if (allChannels.length > 0) {
                selectChannel(allChannels[0]);
            }
        }
    }
};

const fetchChannels = async () => {
    if (_m3uMode) return; // chế độ M3U: không lấy kênh từ backend
    if (isFetching) return;
    isFetching = true;

    try {
        const headers = {};
        if (lastModified) headers['If-Modified-Since'] = lastModified;

        const res = await fetch(CONFIG.jsonURL, {
            headers,
            cache: 'no-cache',
            signal: abortController.signal
        });

        if (res.status === 304) {
            // Không có gì mới
            return;
        }

        if (res.ok) {
            const newLastModified = res.headers.get('Last-Modified');
            if (newLastModified) lastModified = newLastModified;
            let data = await res.json();
            // Hỗ trợ format mới: { srcBase, channels } — build src từ srcBase + channelId
            if (data && !Array.isArray(data) && data.channels) {
                const base = data.srcBase || '';
                data = data.channels.map(ch => ({ ...ch, src: base + ch.channelId, pass: true }));
            }
            applyChannelData(data);
        } else if (!lastModified && allChannels.length === 0) {
            // Lần đầu load mà server lỗi → báo user
            showError('Máy chủ đang tạm dừng. Vui lòng thử lại sau.', () => fetchChannels());
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Lỗi khi tải danh sách kênh:', err);
            if (allChannels.length === 0) {
                showError('Không thể kết nối máy chủ. Kiểm tra mạng và thử lại.', () => fetchChannels());
            }
        }
    } finally {
        isFetching = false;
    }
};

const startChannelUpdates = () => {
    fetchChannels();
    fetchInterval = setInterval(fetchChannels, CONFIG.updateInterval);
};

const stopChannelUpdates = () => {
    if (fetchInterval) clearInterval(fetchInterval);
    if (abortController) abortController.abort();
};

// ==================== KEYBOARD NAVIGATION ====================
const setupKeyboardNavigation = () => {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        switch (e.code) {
            case 'Space':
                e.preventDefault();
                const vid = getVideo();
                if (vid) {
                    if (vid.paused) vid.play().catch(() => {});
                    else vid.pause();
                }
                break;
            case 'Digit1': case 'Numpad1': e.preventDefault(); handleNumberInput('1'); break;
            case 'Digit2': case 'Numpad2': e.preventDefault(); handleNumberInput('2'); break;
            case 'Digit3': case 'Numpad3': e.preventDefault(); handleNumberInput('3'); break;
            case 'Digit4': case 'Numpad4': e.preventDefault(); handleNumberInput('4'); break;
            case 'Digit5': case 'Numpad5': e.preventDefault(); handleNumberInput('5'); break;
            case 'Digit6': case 'Numpad6': e.preventDefault(); handleNumberInput('6'); break;
            case 'Digit7': case 'Numpad7': e.preventDefault(); handleNumberInput('7'); break;
            case 'Digit8': case 'Numpad8': e.preventDefault(); handleNumberInput('8'); break;
            case 'Digit9': case 'Numpad9': e.preventDefault(); handleNumberInput('9'); break;
            case 'Digit0': case 'Numpad0': e.preventDefault(); handleNumberInput('0'); break;
        }
    });
};

// ==================== THEME FUNCTIONS ====================
const applyThemeIcon = (theme) => {
    const icon = document.querySelector('#theme-toggle i');
    if (!icon) return;
    icon.className = theme === 'light' ? 'fas fa-sun' : 'fas fa-moon';
};

const initTheme = () => {
    const savedTheme = localStorage.getItem('theme');
    const theme = savedTheme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    applyThemeIcon(theme);
};

const toggleTheme = () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('theme', nextTheme);
    applyThemeIcon(nextTheme);
};

// ==================== MOBILE NAVIGATION ====================
const setupMobileNavigation = () => {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const navMenu = document.getElementById('nav-menu');
    
    if (mobileMenuBtn && navMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            navMenu.classList.toggle('active');
            mobileMenuBtn.innerHTML = navMenu.classList.contains('active') 
                ? '<i class="fas fa-times"></i>' 
                : '<i class="fas fa-bars"></i>';
        });
    }
    
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            if (navMenu?.classList.contains('active')) {
                navMenu.classList.remove('active');
                if (mobileMenuBtn) mobileMenuBtn.innerHTML = '<i class="fas fa-bars"></i>';
            }
        });
    });
};

// ==================== SEARCH UI ====================
const setupSearchUI = () => {
    const mobileSearchBtn = document.getElementById('mobile-search-btn');
    const searchSection = document.getElementById('search-section');
    const logo = document.querySelector('.logo');
    const navMenu = document.getElementById('nav-menu');
    const searchBackBtn = document.getElementById('search-back-btn');
    const searchInput = document.getElementById('search-input');

    if (mobileSearchBtn && searchSection) {
        mobileSearchBtn.addEventListener('click', () => {
            searchSection.classList.toggle('active');
            if (logo) logo.classList.toggle('hidden');
            if (navMenu) navMenu.classList.toggle('active-with-search', navMenu.classList.contains('active'));
            if (searchSection.classList.contains('active') && searchInput) {
                searchInput.focus();
            }
        });
    }

    if (searchBackBtn && searchSection) {
        searchBackBtn.addEventListener('click', () => {
            searchSection.classList.remove('active');
            if (logo) logo.classList.remove('hidden');
            if (navMenu) navMenu.classList.remove('active-with-search');
            const suggestions = document.getElementById('suggestions');
            if (suggestions) suggestions.style.display = 'none';
            if (searchInput) {
                searchInput.value = '';
                filterChannels();
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', debounce(filterChannels, CONFIG.debounceMs));
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim()) filterChannels();
        });
    }
};

// ==================== INITIALIZATION ====================

// Back/forward button → chuyển kênh theo URL
window.addEventListener('popstate', () => {
    const slug = getChannelFromUrl();
    if (slug && allChannels.length) {
        const ch = allChannels.find(c => toSlug(c.TV || c.name) === slug);
        if (ch && ch.name !== currentChannel?.name) {
            selectChannel(ch);
        }
    }
});

// ==================== M3U / IPTV PLAYLIST MODE ====================
const M3U_STORE_KEY = 'xemtv_m3u_source';

const saveM3uSource = (source) => {
    try { localStorage.setItem(M3U_STORE_KEY, JSON.stringify(source)); } catch (e) {}
};
const loadM3uSource = () => {
    try { return JSON.parse(localStorage.getItem(M3U_STORE_KEY) || 'null'); } catch (e) { return null; }
};
const clearM3uSource = () => { try { localStorage.removeItem(M3U_STORE_KEY); } catch (e) {} };

// Parse nội dung M3U/M3U8 → mảng kênh { name, TV, src, logo, group, m3uDirect }
const parseM3U = (text, baseUrl) => {
    text = text || '';
    // Phải là playlist M3U thật: có #EXTM3U hoặc ít nhất 1 #EXTINF, nếu không thì coi như link rác
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
        // Web chạy HTTPS → nâng link http:// lên https:// để tránh chặn mixed-content
        if (location.protocol === 'https:' && /^http:\/\//i.test(out)) {
            out = out.replace(/^http:/i, 'https:');
        }
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
            continue; // bỏ qua directive khác (#EXTM3U, #KODIPROP, v.v.)
        } else {
            // Dòng nội dung: chỉ nhận nếu có #EXTINF phía trước, hoặc trông giống URL
            if (!cur && !hasScheme(line) && !baseUrl) { continue; }
            const url = resolve(line);
            // Link kênh phải là URL hợp lệ (có scheme), nếu không thì bỏ qua
            if (!url || !hasScheme(url)) { cur = null; continue; }
            const base = cur || { name: 'Kênh', logo: '', group: '' };
            let nm = base.name, k = 2;
            while (used.has(nm)) nm = base.name + ' (' + (k++) + ')';
            used.add(nm);
            channels.push({ name: nm, TV: base.name, src: url, logo: base.logo, group: base.group, m3uDirect: true });
            cur = null;
        }
    }
    return channels;
};

// Chuyển sang chế độ M3U: nạp danh sách kênh, dừng backend, render & phát
const enterM3uMode = (channels) => {
    _m3uMode = true;
    stopChannelUpdates();
    allChannels = channels;
    clearChannelCache();
    activeTab = null;
    _sbActiveGroup = channels[0]?.group || 'Khác';
    const sbGroupTabs = document.getElementById('sb-group-tabs');
    if (sbGroupTabs) sbGroupTabs._rendered = false;
    currentChannel = null;
    renderChannels(allChannels);
    renderFavorites();
    renderSidebarChannels();

    // Chọn kênh: ưu tiên URL slug → kênh đã xem gần nhất → kênh đầu
    let target = null;
    const urlSlug = getChannelFromUrl();
    if (urlSlug) target = allChannels.find(c => toSlug(c.TV || c.name) === urlSlug);
    if (!target) {
        const last = JSON.parse(localStorage.getItem('lastChannel') || 'null');
        if (last) target = allChannels.find(c => c.name === last.name);
    }
    if (!target) target = allChannels[0];
    if (target) selectChannel(target);

    hideM3uEntry();
    _revealApp();
    _setupM3uSettingsIcon();
};

const _revealApp = () => {
    document.documentElement.style.visibility = 'visible';
    const splash = document.getElementById('conn-splash');
    if (splash) splash.style.display = 'none';
};

const loadM3uFromSource = async (source) => {
    _setM3uBusy(true, 'Đang quét kênh...');
    try {
        let text;
        if (source.type === 'text') {
            text = source.value;
        } else {
            const res = await fetch(source.value, { cache: 'no-cache' });
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
        const hint = source.type === 'url'
            ? ' — link có thể bị chặn CORS. Hãy thử "Dán nội dung" hoặc "Tải file" thay vì link.'
            : '';
        _showM3uError('Không tải được playlist: ' + e.message + hint);
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
        <div class="m3u-title"><i class="fas fa-tv"></i> Xem IPTV bằng playlist M3U</div>
        <div class="m3u-sub">Dán link M3U/M3U8, tải file, hoặc dán trực tiếp nội dung playlist.</div>
        <div class="m3u-tabs">
          <button class="m3u-tab active" data-tab="url">Link M3U</button>
          <button class="m3u-tab" data-tab="file">Tải file</button>
          <button class="m3u-tab" data-tab="text">Dán nội dung</button>
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
        <button class="m3u-go" id="m3u-go">Xem ngay</button>
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
    // Nút đóng chỉ hiện khi đã có playlist đang xem (đổi playlist)
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
    if (go) { go.disabled = !!busy; go.textContent = busy ? (msg || 'Đang tải...') : 'Xem ngay'; }
};

// Popup xác nhận theo theme (thay confirm mặc định của trình duyệt)
const _m3uConfirm = (message, onOk) => {
    const old = document.getElementById('m3u-confirm');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'm3u-confirm';
    ov.className = 'm3u-confirm';
    ov.innerHTML = `
      <div class="m3u-confirm-box">
        <div class="m3u-confirm-msg">${message}</div>
        <div class="m3u-confirm-actions">
          <button class="m3u-confirm-btn cancel" data-act="cancel">Hủy</button>
          <button class="m3u-confirm-btn ok" data-act="ok">Xóa</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('[data-act=cancel]').addEventListener('click', close);
    ov.querySelector('[data-act=ok]').addEventListener('click', () => { close(); onOk && onOk(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
};

// Nút theme (mặt trăng) → biến thành nút Cài đặt (bánh răng) khi ở chế độ M3U
const _setupM3uSettingsIcon = () => {
    const tt = document.getElementById('theme-toggle');
    if (!tt) return;
    const ic = tt.querySelector('i');
    if (ic) ic.className = 'fas fa-cog';
    tt.title = 'Cài đặt';
};

// Menu cài đặt: Thêm/Đổi playlist hoặc Xóa playlist hiện tại
const toggleM3uSettingsMenu = () => {
    const existing = document.getElementById('m3u-settings-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'm3u-settings-menu';
    menu.className = 'm3u-settings-menu';
    menu.innerHTML = `
      <button class="m3u-set-item" data-act="add"><i class="fas fa-plus"></i> Thêm / Đổi playlist</button>
      <button class="m3u-set-item danger" data-act="del"><i class="fas fa-trash"></i> Xóa playlist hiện tại</button>`;
    const anchor = document.getElementById('theme-toggle');
    const r = anchor ? anchor.getBoundingClientRect() : { bottom: 56, right: window.innerWidth - 12 };
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    document.body.appendChild(menu);
    menu.querySelector('[data-act=add]').addEventListener('click', () => { menu.remove(); showM3uEntry(); });
    menu.querySelector('[data-act=del]').addEventListener('click', () => {
        menu.remove();
        _m3uConfirm('Xóa playlist hiện tại và quay lại màn nhập?', () => {
            clearM3uSource();
            location.reload();
        });
    });
    setTimeout(() => {
        const close = (e) => {
            if (!menu.contains(e.target) && !(anchor && anchor.contains(e.target))) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        };
        document.addEventListener('click', close);
    }, 0);
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

const init = async () => {
    // TOS acceptance FIRST (only on first visit)
    await checkTosAcceptance();
    // Check maintenance & activation FIRST
    const canProceed = await checkSystemStatus();
    if (!canProceed) return;

    initTheme();
    setupKeyboardNavigation();
    setupMobileNavigation();
    setupSearchUI();
    initMobileContentTabs();
    initSidebarTabs();
    initPlaylistMode();

    // Logo click: scroll lên đầu + refresh data
    document.getElementById('home-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('.nav-link.active')?.classList.remove('active');
        document.getElementById('home-nav-link')?.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        lastModified = null; // force reload
        fetchChannels();
    });

    // Pull-to-refresh (kéo xuống từ đầu trang)
    (() => {
        const indicator = document.getElementById('pull-refresh-indicator');
        if (!indicator) return;
        let startY = 0, pulling = false, threshold = 70;

        document.addEventListener('touchstart', e => {
            if (window.scrollY === 0) {
                startY = e.touches[0].clientY;
                pulling = true;
            }
        }, { passive: true });

        document.addEventListener('touchmove', e => {
            if (!pulling) return;
            const dy = e.touches[0].clientY - startY;
            if (dy <= 0) { pulling = false; return; }
            const pct = Math.min(dy / threshold, 1);
            indicator.classList.toggle('pulling', dy > 10);
            indicator.classList.toggle('ready', dy >= threshold);
            indicator.classList.remove('loading');
            indicator.querySelector('.ptr-text').textContent =
                dy >= threshold ? 'Thả để tải lại' : 'Kéo xuống để tải lại';
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (!pulling) return;
            pulling = false;
            if (indicator.classList.contains('ready')) {
                indicator.classList.remove('ready');
                indicator.classList.add('loading');
                indicator.querySelector('.ptr-text').textContent = 'Đang tải...';
                lastModified = null;
                fetchChannels().finally(() => {
                    indicator.classList.remove('pulling', 'loading');
                });
            } else {
                indicator.classList.remove('pulling');
            }
        });
    })();

    document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
        if (_m3uMode) { e.stopPropagation(); toggleM3uSettingsMenu(); }
        else { toggleTheme(); }
    });

    document.addEventListener('click', (e) => {
        const suggestions = document.getElementById('suggestions');
        const searchBox = e.target.closest('.search-box');
        if (suggestions && !searchBox) {
            suggestions.style.display = 'none';
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Tab ẩn — KHÔNG dừng video, KHÔNG stop heartbeat
            // Ghi lại thời điểm ẩn để tính thời gian khi quay lại
            _hiddenAt = Date.now();
        } else {
            _resumeFromHidden();
        }
    });

    // Page Lifecycle API: handle freeze (màn hình tắt / OS suspend)
    document.addEventListener('freeze', () => {
        _hiddenAt = Date.now();
    });
    document.addEventListener('resume', () => {
        _resumeFromHidden();
    });
};

// Thời điểm tab bị ẩn / màn hình tắt
let _hiddenAt = 0;

// Watchdog: kiểm tra video có đang tiến không
let _watchdogTimer = null;
let _lastVideoTime = -1;
let _lastVideoCheck = 0;
const WATCHDOG_INTERVAL = 12000;  // check mỗi 12s
const WATCHDOG_STALL_MS = 24000;  // nếu stuck > 24s → phục hồi

const _startWatchdog = () => {
    _stopWatchdog();
    _lastVideoTime = -1;
    _lastVideoCheck = Date.now();
    _watchdogTimer = setInterval(() => {
        const v = getVideo();
        if (!v || !currentChannel || _isCatchupMode || document.hidden) return;
        if (v.paused || v.ended || v.readyState === 0) return; // đang pause chủ động = OK
        const now = Date.now();
        if (v.currentTime === _lastVideoTime) {
            // Video không tiến trong WATCHDOG_STALL_MS
            if (now - _lastVideoCheck >= WATCHDOG_STALL_MS) {
                console.warn('[Watchdog] Stream stall detected → recovery');
                _recoverStream();
                _lastVideoCheck = now;
            }
        } else {
            _lastVideoTime = v.currentTime;
            _lastVideoCheck = now;
        }
    }, WATCHDOG_INTERVAL);
};

const _stopWatchdog = () => {
    if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
};

const _recoverStream = () => {
    if (!currentChannel || _isCatchupMode) return;
    const v = getVideo();
    // Thử seek live edge trước (nhẹ hơn)
    if (v && hlsInstance) {
        const live = hlsInstance.liveSyncPosition;
        if (live && live > 0) {
            try { v.currentTime = live; hlsInstance.startLoad(); v.play().catch(() => {}); return; } catch(e) {}
        }
    }
    // Nếu không được → restart hẳn kênh
    if (currentChannel.source === 'tv360') playTv360Channel(currentChannel);
    else if (currentChannel.mytvDrm) playMytvDrmChannel(currentChannel);
    else playChannelDirect(currentChannel);
};

const _resumeFromHidden = () => {
    const v = getVideo();
    if (v && v.muted) v.muted = false;
    if (!currentChannel || _isCatchupMode) return;

    // Gửi heartbeat ngay để báo proxy vẫn có viewer
    startHeartbeat(currentChannel);

    const hiddenMs = _hiddenAt > 0 ? Date.now() - _hiddenAt : 0;
    _hiddenAt = 0;

    if (v && v.paused) v.play().catch(() => {});

    if (hiddenMs > 60000) {
        // Ẩn > 60 giây → có thể stream đã chết, restart kênh
        console.log(`[Resume] Ẩn ${Math.round(hiddenMs/1000)}s → restart stream`);
        _recoverStream();
    } else {
        // Ẩn ngắn → chỉ seek live edge nếu lệch
        if (v && hlsInstance) {
            const live = hlsInstance.liveSyncPosition;
            if (live && v.currentTime < live - 15) {
                try { v.currentTime = live; hlsInstance.startLoad(); } catch(e) {}
            }
        }
    }
};

// ==================== CLEANUP ====================
window.addEventListener('beforeunload', () => {
    stopHeartbeat();
    stopChannelUpdates();
    destroyHls();
});

// ==================== SECURITY: RIGHT-CLICK & DEVTOOLS PROTECTION ====================
(() => {
    // ---- Chống chụp màn hình video (CSS @media print + disablePictureInPicture) ----
    const _antiCaptureCss = document.createElement('style');
    _antiCaptureCss.textContent = `
        @media print {
            video, #player-container, .player-wrap, #video-player { visibility: hidden !important; background: #000 !important; }
        }
        video { -webkit-user-select: none !important; user-select: none !important; }
    `;
    document.head.appendChild(_antiCaptureCss);

    // Block getDisplayMedia (screen capture API)
    if (navigator.mediaDevices?.getDisplayMedia) {
        navigator.mediaDevices.getDisplayMedia = () =>
            Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    }

    // Disable PiP trên video elements (ngăn crop + record)
    const _applyPiPBlock = (vid) => {
        if (!vid) return;
        vid.disablePictureInPicture = true;
        vid.setAttribute('disablepictureinpicture', '');
        vid.setAttribute('controlslist', 'nodownload noremoteplayback');
        vid.addEventListener('enterpictureinpicture', (e) => { e.preventDefault(); document.exitPictureInPicture?.(); }, true);
    };
    document.querySelectorAll('video').forEach(_applyPiPBlock);
    new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes)
            if (n.tagName === 'VIDEO') _applyPiPBlock(n);
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    const _secApiBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(location.origin)
        ? location.origin : 'https://cdn-vn.iof.vn';
    let _secConfig = null;
    let _devtoolsCount = 0;
    let _blocked = false;

    // Custom context menu overlay
    const _showContextMenu = (e) => {
        e.preventDefault();
        let cm = document.getElementById('xemtv-ctx-menu');
        if (cm) cm.remove();
        cm = document.createElement('div');
        cm.id = 'xemtv-ctx-menu';
        cm.style.cssText = 'position:fixed;z-index:999999;background:rgba(13,13,20,0.95);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px 28px;box-shadow:0 8px 32px rgba(0,0,0,0.6);backdrop-filter:blur(12px);display:flex;flex-direction:column;align-items:center;gap:8px;min-width:200px;animation:_ctxIn 0.15s ease;';
        const ver = (_secConfig && _secConfig.appVersion) || '2.0.0';
        cm.innerHTML = '<div style="font-size:1.2rem;font-weight:700;color:#ff3d00;letter-spacing:-0.5px;">XemTV<span style="color:#fff;font-weight:300">.vn</span></div>' +
            '<div style="font-size:0.7rem;color:#666;margin-top:2px;">Phiên bản ' + ver + '</div>' +
            '<div style="width:100%;height:1px;background:rgba(255,255,255,0.06);margin:6px 0;"></div>' +
            '<div style="font-size:0.75rem;color:#888;">© 2025 XemTV.vn</div>';
        // Position
        let x = e.clientX, y = e.clientY;
        cm.style.left = x + 'px';
        cm.style.top = y + 'px';
        document.body.appendChild(cm);
        // Adjust if overflows
        const rect = cm.getBoundingClientRect();
        if (rect.right > window.innerWidth) cm.style.left = (window.innerWidth - rect.width - 10) + 'px';
        if (rect.bottom > window.innerHeight) cm.style.top = (window.innerHeight - rect.height - 10) + 'px';
        // Auto dismiss
        const dismiss = () => { if (cm.parentNode) cm.remove(); };
        setTimeout(dismiss, 4000);
        document.addEventListener('click', dismiss, { once: true });
        document.addEventListener('scroll', dismiss, { once: true });
    };
    // Add animation keyframe
    if (!document.getElementById('_ctx-style')) {
        const s = document.createElement('style');
        s.id = '_ctx-style';
        s.textContent = '@keyframes _ctxIn{from{opacity:0;transform:scale(0.92)}to{opacity:1;transform:scale(1)}}';
        document.head.appendChild(s);
    }

    // DevTools detection — chỉ chạy trên desktop (không phải touch device)
    // Mobile: outerHeight - innerHeight > 160 rất thường xảy ra do:
    //   address bar ẩn/hiện, bàn phím ảo, notch, navigation bar OS
    const _isTouchDevice = () => navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

    const _dtThreshold = 160;
    let _dtCheckInterval = null;
    let _dtReported = false;
    let _dtOpen = false;
    let _dtConsecutive = 0; // cần 3 lần liên tiếp mới kích hoạt (tránh false positive)

    // Lớp 1: window size diff (dock mode - đáng tin cậy nhất, CHỈ desktop)
    const _checkSizeDiff = () => {
        if (_isTouchDevice()) return false; // không check trên mobile/tablet
        return (window.outerWidth - window.innerWidth > _dtThreshold) ||
               (window.outerHeight - window.innerHeight > _dtThreshold);
    };

    const _checkDevTools = () => {
        if (_dtOpen) return;
        if (_checkSizeDiff()) {
            _dtConsecutive++;
            if (_dtConsecutive >= 3) { // 3 lần liên tiếp × 2s = 6s chắc chắn mở
                _dtOpen = true;
                _dtConsecutive = 0;
                _onDevToolsDetected();
                setTimeout(() => { _dtOpen = false; }, 8000);
            }
        } else {
            _dtConsecutive = 0; // reset nếu đóng lại
        }
    };

    const _onDevToolsDetected = () => {
        if (_blocked) return;
        _devtoolsCount++;
        // Lần 1: redirect ngay sang trang điều khoản
        if (_devtoolsCount === 1) {
            location.href = '/dieu-khoan-su-dung.html';
            return;
        }
        // Lần 2+: report server
        if (!_dtReported) {
            _dtReported = true;
            fetch(_secApiBase + '/api/devtools-violation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ count: _devtoolsCount })
            }).then(r => r.json()).then(data => {
                _dtReported = false;
                if (data.blocked) {
                    _showBlockPage(Date.now() + 24 * 3600 * 1000);
                } else {
                    location.href = '/dieu-khoan-su-dung.html';
                }
            }).catch(() => {
                _dtReported = false;
                location.href = '/dieu-khoan-su-dung.html';
            });
        }
    };

    // Block page
    const _showBlockPage = (expiresAt) => {
        _blocked = true;
        // Stop everything
        try { destroyHls(); } catch(e) {}
        try { stopHeartbeat(); } catch(e) {}
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;padding:0;background:#0a0a0f;color:#fff;font-family:Roboto,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:center;max-width:420px;padding:40px 30px;animation:_ctxIn 0.4s ease;';
        wrap.innerHTML =
            '<div style="font-size:4rem;margin-bottom:16px;opacity:0.7;">😔</div>' +
            '<div style="font-size:1.3rem;font-weight:700;color:#ff3d00;margin-bottom:8px;">Tạm thời bị khóa</div>' +
            '<div style="font-size:0.9rem;color:#aaa;line-height:1.6;margin-bottom:20px;">Vì vi phạm chính sách bảo mật, tài khoản của bạn tạm thời bị khóa truy cập.</div>' +
            '<div id="_block-countdown" style="font-size:2rem;font-weight:700;color:#ff6a3d;margin-bottom:20px;font-variant-numeric:tabular-nums;"></div>' +
            '<div style="font-size:0.8rem;color:#666;line-height:1.5;">Mọi thông tin liên hệ<br><a href="mailto:info@xemtv.vn" style="color:#4fc3f7;text-decoration:none;">info@xemtv.vn</a></div>';
        document.body.appendChild(wrap);
        // Countdown
        const cdEl = document.getElementById('_block-countdown');
        const updateCd = () => {
            const remain = Math.max(0, expiresAt - Date.now());
            if (remain <= 0) { location.reload(); return; }
            const h = Math.floor(remain / 3600000);
            const m = Math.floor((remain % 3600000) / 60000);
            const s = Math.floor((remain % 60000) / 1000);
            if (cdEl) cdEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        };
        updateCd();
        setInterval(updateCd, 1000);
    };

    // Init security
    const _initSecurity = async () => {
        try {
            const r = await fetch(_secApiBase + '/api/security-config');
            _secConfig = await r.json();
        } catch(e) { return; }

        // Check if already blocked
        if (_secConfig.blocked) {
            _showBlockPage(_secConfig.blocked.expiresAt);
            return;
        }

        // Right-click protection
        if (_secConfig.blockRightClick) {
            document.addEventListener('contextmenu', _showContextMenu);
        }

        // DevTools protection
        if (_secConfig.blockDevTools) {
            // Block F12, Ctrl+Shift+I/J/C, Ctrl+U
            document.addEventListener('keydown', (e) => {
                if (e.key === 'F12' ||
                    (e.ctrlKey && e.shiftKey && ['I','i','J','j','C','c'].includes(e.key)) ||
                    (e.ctrlKey && ['U','u'].includes(e.key))) {
                    e.preventDefault();
                    e.stopPropagation();
                    _onDevToolsDetected();
                    return false;
                }
            }, true);
            // Periodic size check (catch already-open devtools)
            _dtCheckInterval = setInterval(_checkDevTools, 2000);
            _checkDevTools();
        }
    };

    // Run after a short delay to not block page load
    setTimeout(_initSecurity, 1500);
})();

// ==================== START ====================
document.addEventListener('DOMContentLoaded', () => {
    const vid = document.getElementById('video-player');
    if (vid) {
        vid.addEventListener('click', () => {
            if (vid.paused) vid.play().catch(() => {});
            else vid.pause();
        });
    }

    // Nút phóng to / thu nhỏ
    const container = document.getElementById('player-container');
    if (container && !document.getElementById('live-fs-btn')) {
        const style = document.createElement('style');
        style.textContent = `
            #player-container{overflow:hidden;}
            .live-fs-btn{position:absolute;bottom:10px;right:calc(1.5rem + 10px);z-index:30;width:36px;height:36px;border-radius:50%;border:none;background:rgba(0,0,0,0.55);color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s;}
            #player-container:hover .live-fs-btn,.live-fs-btn:focus{opacity:1;}
            #player-container:-webkit-full-screen .live-fs-btn,#player-container:fullscreen .live-fs-btn{bottom:16px;right:16px;}
            .catchup-mode .live-fs-btn{display:none!important;}
        `;
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'live-fs-btn';
        btn.className = 'live-fs-btn';
        btn.title = 'Phóng to / Thu nhỏ';
        btn.innerHTML = '<i class="fas fa-expand"></i>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isFs = document.fullscreenElement || document.webkitFullscreenElement || (_isIOS && container.style.position === 'fixed');
            if (isFs) {
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                }
                screen.orientation?.unlock?.();
                if (_isIOS) {
                    container.style.cssText = '';
                    document.body.style.overflow = '';
                }
            } else {
                const vid = document.getElementById('video-player');
                if (_isIOS) {
                    // iOS: pseudo-fullscreen bằng CSS để GIỮ watermark. Native fullscreen của iOS
                    // (webkitEnterFullscreen) là lớp riêng của hệ điều hành → overlay HTML không hiện
                    // lên trên được, nên KHÔNG gọi nó. Video chạy inline (playsinline) trong container.
                    if (vid && vid.setAttribute) vid.setAttribute('playsinline', '');
                    if (window.innerHeight > window.innerWidth) {
                        // màn dọc → xoay container giả lập ngang
                        const w = window.innerWidth, h = window.innerHeight;
                        container.style.cssText = `position:fixed;top:0;left:0;width:${h}px;height:${w}px;transform:rotate(90deg);transform-origin:top left;translate:${w}px 0;z-index:99999;background:#000;`;
                    } else {
                        // đã ngang → phủ kín viewport
                        container.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;background:#000;`;
                    }
                    document.body.style.overflow = 'hidden';
                } else if (container.requestFullscreen) container.requestFullscreen().catch(() => {});
                else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
                else if (vid && vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
                screen.orientation?.lock?.('landscape').catch(() => {});
            }
        });
        container.appendChild(btn);

        const onFsChange = () => {
            const icon = btn.querySelector('i');
            const inFs = document.fullscreenElement || document.webkitFullscreenElement;
            if (icon) icon.className = inFs ? 'fas fa-compress' : 'fas fa-expand';
            if (!inFs) {
                container.style.cssText = '';
                document.body.style.overflow = '';
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);

        // iOS: reset khi thoát native fullscreen
        const vid2 = document.getElementById('video-player');
        if (vid2) {
            vid2.addEventListener('webkitendfullscreen', () => {
                container.style.cssText = '';
                document.body.style.overflow = '';
                const icon = btn.querySelector('i');
                if (icon) icon.className = 'fas fa-expand';
            });
        }

        // ===== Fullscreen Channel Navigator =====
        (() => {
            const fsStyle = document.createElement('style');
            fsStyle.textContent = `
                .fs-ch-panel{position:fixed;top:0;bottom:0;width:280px;background:rgba(10,10,18,0.96);z-index:100000;display:none;flex-direction:column;transition:transform 0.25s ease;overflow:hidden;backdrop-filter:blur(8px);}
                .fs-ch-panel.fs-ch-left{left:0;transform:translateX(-100%);border-right:1px solid rgba(255,255,255,0.08);}
                .fs-ch-panel.fs-ch-right{right:0;transform:translateX(100%);border-left:1px solid rgba(255,255,255,0.08);}
                .fs-ch-panel.fs-ch-open{display:flex;transform:translateX(0);}
                .fs-ch-header{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px;flex-shrink:0;}
                .fs-ch-header span{color:#ccc;font-size:0.82rem;font-weight:600;flex:1;}
                .fs-ch-close{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:4px 8px;}
                .fs-ch-close:hover{color:#fff;}
                .fs-ch-list{flex:1;overflow-y:auto;padding:6px 0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.15) transparent;}
                .fs-ch-list::-webkit-scrollbar{width:4px;}.fs-ch-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:2px;}
                .fs-ch-item{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;transition:background 0.15s;}
                .fs-ch-item:hover{background:rgba(255,255,255,0.06);}
                .fs-ch-item.fs-ch-active{background:rgba(255,61,0,0.12);}
                .fs-ch-item img{width:32px;height:22px;object-fit:contain;border-radius:3px;flex-shrink:0;}
                .fs-ch-item span{color:#ddd;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
                .fs-ch-item.fs-ch-active span{color:#ff6a3d;font-weight:600;}
                .fs-ch-trigger{position:fixed;top:0;bottom:0;width:30px;z-index:99999;display:none;}
                .fs-ch-trigger-left{left:0;}
                .fs-ch-trigger-right{right:0;}
            `;
            document.head.appendChild(fsStyle);

            // Create panel
            const panel = document.createElement('div');
            panel.className = 'fs-ch-panel fs-ch-right';
            panel.innerHTML = `<div class="fs-ch-header"><span>Danh sách kênh</span><button class="fs-ch-close"><i class="fas fa-times"></i></button></div><div class="fs-ch-list"></div>`;
            document.body.appendChild(panel);

            // Trigger zones
            const triggerLeft = document.createElement('div');
            triggerLeft.className = 'fs-ch-trigger fs-ch-trigger-left';
            document.body.appendChild(triggerLeft);
            const triggerRight = document.createElement('div');
            triggerRight.className = 'fs-ch-trigger fs-ch-trigger-right';
            document.body.appendChild(triggerRight);

            const listEl = panel.querySelector('.fs-ch-list');
            const closeBtn = panel.querySelector('.fs-ch-close');
            let panelOpen = false;

            const openPanel = () => {
                if (panelOpen) return;
                panelOpen = true;
                // Render channel list
                listEl.innerHTML = '';
                const chans = allChannels.filter(hasValidURL);
                chans.forEach((ch, idx) => {
                    const item = document.createElement('div');
                    item.className = `fs-ch-item${currentChannel?.name === ch.name ? ' fs-ch-active' : ''}`;
                    item.innerHTML = `<img src="${ch.logo}" alt="" onerror="this.style.display='none'"><span>${ch.TV || ch.name}</span>`;
                    item.addEventListener('click', () => {
                        closePanel();
                        selectChannel(ch);
                    });
                    listEl.appendChild(item);
                });
                panel.classList.add('fs-ch-open');
                // Scroll to active
                const active = listEl.querySelector('.fs-ch-active');
                if (active) setTimeout(() => active.scrollIntoView({ block: 'center', behavior: 'instant' }), 50);
            };

            const closePanel = () => {
                panelOpen = false;
                panel.classList.remove('fs-ch-open');
            };

            closeBtn.addEventListener('click', closePanel);

            // Show/hide triggers based on fullscreen state
            const updateTriggers = () => {
                const inFs = document.fullscreenElement || document.webkitFullscreenElement;
                const show = inFs ? 'block' : 'none';
                triggerLeft.style.display = show;
                triggerRight.style.display = show;
                if (!inFs) closePanel();
            };
            document.addEventListener('fullscreenchange', updateTriggers);
            document.addEventListener('webkitfullscreenchange', updateTriggers);

            // Desktop: hover triggers
            let hoverTimer = null;
            triggerRight.addEventListener('mouseenter', () => {
                hoverTimer = setTimeout(openPanel, 300);
            });
            triggerRight.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
            triggerLeft.addEventListener('mouseenter', () => {
                hoverTimer = setTimeout(openPanel, 300);
            });
            triggerLeft.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

            // Close when clicking outside
            document.addEventListener('click', (e) => {
                if (panelOpen && !panel.contains(e.target) && !triggerLeft.contains(e.target) && !triggerRight.contains(e.target)) {
                    closePanel();
                }
            });

            // Mobile: swipe right to open in fullscreen
            let _fsTouchStartX = 0, _fsTouchStartY = 0, _fsSwiping = false;
            container.addEventListener('touchstart', (e) => {
                const inFs = document.fullscreenElement || document.webkitFullscreenElement;
                if (!inFs) return;
                _fsTouchStartX = e.touches[0].clientX;
                _fsTouchStartY = e.touches[0].clientY;
                _fsSwiping = _fsTouchStartX < 50; // bắt đầu từ cạnh trái
            }, { passive: true });

            container.addEventListener('touchmove', (e) => {
                if (!_fsSwiping) return;
                const dx = e.touches[0].clientX - _fsTouchStartX;
                const dy = Math.abs(e.touches[0].clientY - _fsTouchStartY);
                if (dx > 60 && dy < 40) {
                    _fsSwiping = false;
                    openPanel();
                }
            }, { passive: true });
        })();
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}