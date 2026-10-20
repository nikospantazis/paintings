(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.Lightbox3 = {}));
})(this, (function (exports) { 'use strict';

    const POSITION_THRESHOLD = 0.01;
    const VELOCITY_THRESHOLD = 0.01;
    const MAX_DT = 0.02;
    const SUB_STEP_DT = 0.008;
    function springStep(config, state, target, dt) {
        const { stiffness: k, damping: c, mass: m = 1 } = config;
        if (dt > MAX_DT) {
            let current = { ...state };
            let remaining = dt;
            while (remaining > 0) {
                const step = Math.min(remaining, SUB_STEP_DT);
                const result = springStepSingle(k, c, m, current, target, step);
                if (result.settled)
                    return result;
                current = result;
                remaining -= step;
            }
            return { ...current, settled: false };
        }
        return springStepSingle(k, c, m, state, target, dt);
    }
    function springStepSingle(k, c, m, state, target, dt) {
        const displacement = state.position - target;
        const springForce = -k * displacement;
        const dampingForce = -c * state.velocity;
        const acceleration = (springForce + dampingForce) / m;
        const newVelocity = state.velocity + acceleration * dt;
        const newPosition = state.position + newVelocity * dt;
        const settled = Math.abs(newPosition - target) < POSITION_THRESHOLD &&
            Math.abs(newVelocity) < VELOCITY_THRESHOLD;
        return {
            position: settled ? target : newPosition,
            velocity: settled ? 0 : newVelocity,
            settled,
        };
    }
    // Presets — tuned for Motion.dev-style feel
    const SPRING_OPEN = { stiffness: 260, damping: 26, mass: 1 };
    const SPRING_CLOSE = { stiffness: 500, damping: 38, mass: 1 };
    // Fade presets for the lightbox opening/closing. Independent from springOpen /
    // springClose, which drive gallery navigation, zoom and the chrome slide.
    // Higher stiffness = faster; damping at or above 2*sqrt(stiffness) = no overshoot.
    const FADE_OPEN = { stiffness: 50, damping: 10, mass: 1 };
    const FADE_CLOSE = { stiffness: 100, damping: 20, mass: 1 };

    const DEFAULTS = {
        selector: '[data-lightbox]',
        springOpen: SPRING_OPEN,
        springClose: SPRING_CLOSE,
        fadeOpen: FADE_OPEN,
        fadeClose: FADE_CLOSE,
        // Max number of full-size images kept in the preload cache (0 = unlimited).
        // The current image and its two gallery neighbours are never evicted.
        preloadCacheMax: 40,
        padding: 40,
        debug: false,
    };
    // When the image is already cached, the open fade waits (at most this long) for
    // the browser to decode it, so the first frames of the fade already show pixels.
    const OPEN_DECODE_MAX_WAIT_MS = 120;
    // Spinner shown while loading an image triggered from a text link.
    const SPINNER_DELAY_MS = 300;
    // During a swipe/pinch dismiss the image is not faded while dragging, so on
    // release it stays fully opaque until the backdrop drops below this threshold,
    // then fades proportionally. Avoids a visible jump when the gesture is released.
    const DISMISS_FADE_THRESHOLD = 0.2;
    // Default border-radius for lightbox images, read from --lb-image-border-radius.
    const DEFAULT_IMAGE_BORDER_RADIUS = 24;
    const PRELOAD_DELAY = 80;
    // Low-priority preloading of the full-size images that are currently in the viewport.
    const VIEWPORT_PRELOAD_IDLE_MS = 400; // scroll must be idle this long before starting
    const VIEWPORT_PRELOAD_MAX = 6; // max images per round (nearest the viewport centre first)
    const VIEWPORT_PRELOAD_MAX_RETRIES = 20; // waits for thumbnails to finish, then gives up
    const DRAG_THRESHOLD = 4;
    const AXIS_LOCK_THRESHOLD = 10;
    const RUBBER_BAND_FACTOR = 0.35;
    const VELOCITY_WINDOW = 80;
    const PAN_SPRING = { stiffness: 170, damping: 26, mass: 1 };
    const SNAP_SPRING = { stiffness: 300, damping: 30, mass: 1 };
    const PINCH_RUBBER_BAND_FACTOR = 0.4;
    const PINCH_DISMISS_RUBBER_BAND_FACTOR = 0.65;
    const PINCH_CLOSE_SCALE = 0.8; // Displayed scale below which pinch commits close
    const PINCH_CLOSE_VELOCITY = -2; // Scale/s velocity that commits close regardless of scale
    const SLIDE_GAP = 16;
    const SWIPE_VELOCITY_THRESHOLD = 300;
    const SWIPE_DISTANCE_THRESHOLD = 0.3;
    const PRESS_SPRING = { stiffness: 300, damping: 20, mass: 1 };
    // Wheel scroll thresholds
    const WHEEL_NAV_THRESHOLD = 60; // Accumulated horizontal px to commit navigate
    const WHEEL_DISMISS_THRESHOLD = 150; // Accumulated vertical px to commit dismiss
    const WHEEL_DISMISS_VELOCITY = 600; // Simulated velocity for wheel-driven dismiss close
    class Lightbox {
        constructor(opts = {}) {
            this.listeners = new Map();
            this.state = {
                isOpen: false,
                isAnimating: false,
                isClosing: false,
                isDismissClosing: false,
                triggerEl: null,
                currentSrc: '',
            };
            this.zoom = this.defaultZoomState();
            // DOM
            this.overlay = null;
            this.backdrop = null;
            this.imgEl = null;
            // Strip DOM (gallery slide container)
            this.stripEl = null;
            this.currentSlideEl = null;
            this.prevSlideEl = null;
            this.prevSlideImg = null;
            this.nextSlideEl = null;
            this.nextSlideImg = null;
            // Gallery
            this.gallery = [];
            this.currentIndex = 0;
            this.userHasNavigated = false;
            // Strip animation
            this.stripRafId = null;
            this.stripOffset = 0;
            this.pendingNavDirection = null;
            this.swipeNav = this.defaultSwipeNavState();
            // Preload
            this.preloadCache = new Map();
            this.preloadTimer = null;
            // Viewport preloading (low priority, one image at a time)
            this.vpTimer = null;
            this.vpIdleHandle = null;
            this.vpIdleIsRic = false;
            this.vpQueue = [];
            this.vpCurrent = null;
            this.vpRetries = 0;
            // Full-res fade-in (after the full-size image has loaded and decoded)
            this.fullResFadeTimer = null;
            this.fullResFading = false;
            // Velocity tracking
            this.velocitySamples = [];
            // Pointer cache for multi-touch (pinch)
            this.pointerCache = [];
            this.pinch = this.defaultPinchState();
            this.dismiss = this.defaultDismissState();
            // rAF animation handle (single loop for all spring animations)
            this.rafId = null;
            // True while the open fade-in spring is running
            this.isOpening = false;
            // Text-link trigger: image is still loading, keep it hidden
            this.textLinkLoading = false;
            this.spinnerEl = null;
            this.spinnerTimer = null;
            // Chrome UI (caption bar, arrows, close button)
            this.chromeBar = null;
            this.chromeCounter = null;
            this.chromeCaption = null;
            this.chromeClose = null;
            this.chromePrev = null;
            this.chromeNext = null;
            this.chromeRafId = null;
            this.chromeSpring = { position: 0, velocity: 0 };
            this.chromeBaseOpacity = 0;
            this.chromeDriftProgress = 0;
            this.chromeDriftVectors = { bar: { x: 0, y: 0 }, prev: { x: 0, y: 0 }, next: { x: 0, y: 0 } };
            this.chromeFadeSwapped = false;
            // Interpolated fitRect used during strip swipe so bar tracks the destination image.
            // Null when not navigating — falls back to zoom.fitRect.
            this.chromeBarFitRect = null;
            // Spring-driven button press (scale down on press, bounce back on release)
            this.pressSprings = new Map();
            this.pressRafId = null;
            // Spring-driven fit-rect transition (aspect ratio change on full-res swap)
            this.fitRafId = null;
            // Focus trap
            this.previouslyFocusedEl = null;
            // Scroll lock state
            this.savedBodyOverflow = '';
            this.savedHtmlPaddingRight = '';
            // Wheel gesture state
            this.wheelDismissY = 0;
            this.wheelGestureTimer = null;
            this.wheelSnapBackTimer = null;
            // Wheel-driven gallery navigation
            this.wheelNavCommitted = false;
            this.wheelNavTotalDelta = 0;
            // Reduced motion: skip spring animations, snap to final state
            this.reducedMotion = false;
            this.reducedMotionQuery = null;
            // ─── Debug panel ────────────────────────────────────────────
            this.debugEl = null;
            this.debugStateEl = null;
            this.debugLogEl = null;
            this.debugRafId = null;
            this.debugLogEntries = [];
            this.debugT0 = 0;
            this.opts = { ...DEFAULTS, ...opts };
            // Listen for reduced-motion preference changes
            this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
            this.reducedMotion = this.reducedMotionQuery.matches;
            this.reducedMotionQuery.addEventListener('change', (e) => {
                this.reducedMotion = e.matches;
            });
            this.handleClick = this.handleClick.bind(this);
            this.handleKeydown = this.handleKeydown.bind(this);
            this.handlePointerEnter = this.handlePointerEnter.bind(this);
            this.handlePointerLeave = this.handlePointerLeave.bind(this);
            this.handleImagePointerDown = this.handleImagePointerDown.bind(this);
            this.handleOverlayPointerDown = this.handleOverlayPointerDown.bind(this);
            this.handlePointerMove = this.handlePointerMove.bind(this);
            this.handlePointerUp = this.handlePointerUp.bind(this);
            this.handleWheel = this.handleWheel.bind(this);
            this.close = this.close.bind(this);
            this.handleResize = this.handleResize.bind(this);
            this.handleViewportChange = this.handleViewportChange.bind(this);
            this.attach();
        }
        static init(opts) {
            if (Lightbox.instance) {
                // A singleton already exists (e.g. from auto-init on DOMContentLoaded).
                // Apply any options passed here so an explicit init() call is not a no-op.
                if (opts)
                    Lightbox.instance.configure(opts);
                return Lightbox.instance;
            }
            Lightbox.instance = new Lightbox(opts);
            return Lightbox.instance;
        }
        /** Merge new options into the existing instance. Options are read lazily at
         *  open time, so this reconfigures the lightbox for subsequent opens. */
        configure(opts) {
            this.opts = { ...this.opts, ...opts };
            return this;
        }
        on(event, callback) {
            let set = this.listeners.get(event);
            if (!set) {
                set = new Set();
                this.listeners.set(event, set);
            }
            set.add(callback);
            return this;
        }
        off(event, callback) {
            this.listeners.get(event)?.delete(callback);
            return this;
        }
        emit(event) {
            const set = this.listeners.get(event);
            if (!set || set.size === 0)
                return;
            const detail = {
                src: this.state.currentSrc,
                triggerEl: this.state.triggerEl,
                index: this.currentIndex,
                total: Math.max(this.gallery.length, 1),
            };
            for (const cb of set) {
                cb(detail);
            }
        }
        attach() {
            document.addEventListener('click', this.handleClick);
            document.addEventListener('pointerenter', this.handlePointerEnter, true);
            document.addEventListener('pointerleave', this.handlePointerLeave, true);
            window.addEventListener('resize', this.handleResize);
            window.addEventListener('scroll', this.handleViewportChange, { passive: true });
            window.addEventListener('resize', this.handleViewportChange);
            if (document.readyState === 'complete') {
                this.scheduleViewportPreload(1000);
            }
            else {
                window.addEventListener('load', () => this.scheduleViewportPreload(1000), { once: true });
            }
        }
        destroy() {
            this.stopDebugPanel();
            document.removeEventListener('click', this.handleClick);
            document.removeEventListener('pointerenter', this.handlePointerEnter, true);
            document.removeEventListener('pointerleave', this.handlePointerLeave, true);
            window.removeEventListener('resize', this.handleResize);
            window.removeEventListener('scroll', this.handleViewportChange);
            window.removeEventListener('resize', this.handleViewportChange);
            this.cancelViewportPreload(true);
            this.stopFullResFade();
            this.cancelPreload();
            this.stopSpring();
            this.stopStripSpring();
            this.stopFitTransition();
            this.removeOverlay();
            this.preloadCache.clear();
            this.listeners.clear();
            if (Lightbox.instance === this)
                Lightbox.instance = null;
        }
        defaultZoomState() {
            return {
                zoomed: false,
                zoomingOut: false,
                fitRect: new DOMRect(),
                naturalWidth: 0,
                naturalHeight: 0,
                scale: 1,
                panX: 0,
                panY: 0,
                isDragging: false,
                dragStartX: 0,
                dragStartY: 0,
                dragStartPanX: 0,
                dragStartPanY: 0,
                dragMoved: false,
            };
        }
        defaultPinchState() {
            return {
                active: false,
                initialDistance: 0,
                initialScale: 1,
                initialPanX: 0,
                initialPanY: 0,
                initialMidX: 0,
                initialMidY: 0,
                prevScale: 1,
                prevScaleTime: 0,
            };
        }
        defaultDismissState() {
            return {
                tracking: false,
                active: false,
                fromOverlay: false,
                startX: 0,
                startY: 0,
                offsetX: 0,
                offsetY: 0,
                scale: 1,
                opacity: 1,
            };
        }
        defaultSwipeNavState() {
            return {
                active: false,
                startX: 0,
                offsetX: 0,
                initialOffset: 0,
            };
        }
        // ─── Preloading ────────────────────────────────────────────
        handlePointerEnter(e) {
            if (e.pointerType !== 'mouse')
                return;
            if (!(e.target instanceof Element))
                return;
            const trigger = e.target.closest(this.opts.selector);
            if (!trigger)
                return;
            const src = this.getSrcFromTrigger(trigger);
            if (!src || this.preloadCache.has(src))
                return;
            this.preloadTimer = setTimeout(() => this.preloadImage(src), PRELOAD_DELAY);
        }
        handlePointerLeave(e) {
            if (e.pointerType !== 'mouse')
                return;
            if (!(e.target instanceof Element))
                return;
            const trigger = e.target.closest(this.opts.selector);
            if (!trigger)
                return;
            this.cancelPreload();
        }
        cancelPreload() {
            if (this.preloadTimer) {
                clearTimeout(this.preloadTimer);
                this.preloadTimer = null;
            }
        }
        preloadImage(src) {
            if (this.preloadCache.has(src))
                return;
            const img = new Image();
            img.decoding = 'async';
            img.src = src;
            this.cachePreload(src, img);
        }
        /** Store a preloaded image, evicting the oldest entries beyond `preloadCacheMax`. */
        cachePreload(src, img) {
            this.preloadCache.set(src, img);
            this.trimPreloadCache();
        }
        trimPreloadCache() {
            const max = this.opts.preloadCacheMax;
            if (!(max > 0) || this.preloadCache.size <= max)
                return;
            // Never evict what is on screen, its gallery neighbours, or an in-flight preload
            const keep = new Set();
            if (this.state.currentSrc)
                keep.add(this.state.currentSrc);
            if (this.state.isOpen) {
                for (const d of [-1, 1]) {
                    const item = this.gallery[this.currentIndex + d];
                    if (item)
                        keep.add(item.src);
                }
            }
            if (this.vpCurrent)
                keep.add(this.vpCurrent.src);
            // Maps iterate in insertion order, so the oldest entries go first.
            for (const key of this.preloadCache.keys()) {
                if (this.preloadCache.size <= max)
                    break;
                if (!keep.has(key))
                    this.preloadCache.delete(key);
            }
        }
        /** Drop every preloaded image (frees memory; they will be preloaded again on demand). */
        clearPreloadCache() {
            this.cancelViewportPreload(true);
            this.preloadCache.clear();
            return this;
        }
        // ─── Gallery preloading ─────────────────────────────────────
        schedulePreloads() {
            // Only the immediate neighbours: on open, and again after every navigation.
            if (this.currentIndex > 0) {
                this.preloadImage(this.gallery[this.currentIndex - 1].src);
            }
            if (this.currentIndex < this.gallery.length - 1) {
                this.preloadImage(this.gallery[this.currentIndex + 1].src);
            }
        }
        // ─── Viewport preloading (low priority) ─────────────────────
        // Preloads the full-size images of thumbnails that are on screen, but only
        // once scrolling has stopped and the visible thumbnails have finished loading,
        // one image at a time, at low fetch priority. Scrolling aborts it again.
        handleViewportChange() {
            if (this.state.isOpen || this.state.isAnimating)
                return;
            this.cancelViewportPreload(true);
            this.vpRetries = 0;
            this.scheduleViewportPreload(VIEWPORT_PRELOAD_IDLE_MS);
        }
        scheduleViewportPreload(delay) {
            if (this.vpTimer)
                clearTimeout(this.vpTimer);
            this.vpTimer = setTimeout(() => {
                this.vpTimer = null;
                this.runViewportPreload();
            }, delay);
        }
        cancelViewportPreload(abortInFlight) {
            if (this.vpTimer) {
                clearTimeout(this.vpTimer);
                this.vpTimer = null;
            }
            if (this.vpIdleHandle !== null) {
                if (this.vpIdleIsRic)
                    cancelIdleCallback(this.vpIdleHandle);
                else
                    clearTimeout(this.vpIdleHandle);
                this.vpIdleHandle = null;
            }
            this.vpQueue = [];
            if (abortInFlight && this.vpCurrent) {
                const { img, src, cleanup } = this.vpCurrent;
                this.vpCurrent = null;
                cleanup();
                if (this.preloadCache.get(src) === img && !(img.complete && img.naturalWidth > 0)) {
                    // Abort the download so it can't compete with thumbnails
                    this.preloadCache.delete(src);
                    img.src = '';
                }
            }
        }
        viewportPreloadAllowed() {
            if (document.hidden)
                return false;
            const conn = navigator.connection;
            if (conn && (conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType)))
                return false;
            return true;
        }
        runViewportPreload() {
            if (this.state.isOpen || this.state.isAnimating || !this.viewportPreloadAllowed())
                return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const visible = [];
            let thumbsPending = false;
            document.querySelectorAll(this.opts.selector).forEach((trigger) => {
                const r = trigger.getBoundingClientRect();
                if (r.width === 0 || r.height === 0)
                    return;
                if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw)
                    return;
                const img = trigger.querySelector('img');
                if (img && !img.classList.contains('error')) {
                    const notLoaded = !(img.complete && img.naturalWidth > 0);
                    const lazyPending = img.classList.contains('lazy') && !img.classList.contains('loaded');
                    if (notLoaded || lazyPending)
                        thumbsPending = true;
                }
                const src = this.getSrcFromTrigger(trigger);
                if (!src || this.preloadCache.has(src))
                    return;
                const dist = Math.hypot(r.left + r.width / 2 - vw / 2, r.top + r.height / 2 - vh / 2);
                visible.push({ src, dist });
            });
            // Thumbnails always come first: wait until every visible one has loaded.
            if (thumbsPending) {
                if (this.vpRetries++ < VIEWPORT_PRELOAD_MAX_RETRIES)
                    this.scheduleViewportPreload(500);
                return;
            }
            visible.sort((a, b) => a.dist - b.dist);
            this.vpQueue = visible.slice(0, VIEWPORT_PRELOAD_MAX).map((v) => v.src);
            this.nextViewportPreload();
        }
        nextViewportPreload() {
            if (this.vpCurrent || this.vpQueue.length === 0 || this.vpIdleHandle !== null)
                return;
            const start = () => {
                this.vpIdleHandle = null;
                if (this.state.isOpen || this.vpCurrent)
                    return;
                const src = this.vpQueue.shift();
                if (!src)
                    return;
                if (this.preloadCache.has(src)) {
                    this.nextViewportPreload();
                    return;
                }
                const img = new Image();
                img.decoding = 'async';
                img.fetchPriority = 'low';
                const onLoad = () => finish(false);
                const onError = () => finish(true);
                const cleanup = () => {
                    img.removeEventListener('load', onLoad);
                    img.removeEventListener('error', onError);
                };
                const finish = (failed) => {
                    cleanup();
                    if (failed && this.preloadCache.get(src) === img)
                        this.preloadCache.delete(src);
                    if (this.vpCurrent?.img === img)
                        this.vpCurrent = null;
                    this.nextViewportPreload();
                };
                img.addEventListener('load', onLoad);
                img.addEventListener('error', onError);
                this.vpCurrent = { img, src, cleanup };
                img.src = src;
                this.cachePreload(src, img);
            };
            if ('requestIdleCallback' in window) {
                this.vpIdleIsRic = true;
                this.vpIdleHandle = requestIdleCallback(start, { timeout: 2000 });
            }
            else {
                this.vpIdleIsRic = false;
                this.vpIdleHandle = setTimeout(start, 100);
            }
        }
        // ─── Gallery ────────────────────────────────────────────────
        buildGallery(triggerEl) {
            const galleryName = triggerEl.getAttribute('data-lightbox');
            // No value or empty → standalone, no gallery
            if (!galleryName) {
                this.gallery = [];
                this.currentIndex = 0;
                return;
            }
            // Find all siblings with same gallery name, in DOM order
            const elements = document.querySelectorAll(`[data-lightbox="${CSS.escape(galleryName)}"]`);
            this.gallery = Array.from(elements).map((el) => {
                const htmlEl = el;
                const img = htmlEl.querySelector('img');
                return {
                    triggerEl: htmlEl,
                    src: this.getSrcFromTrigger(htmlEl),
                    thumbSrc: img?.currentSrc || img?.src || '',
                    caption: htmlEl.getAttribute('data-caption') || htmlEl.getAttribute('data-title') || '',
                    alt: htmlEl.getAttribute('data-alt') || img?.alt || '',
                };
            });
            this.currentIndex = this.gallery.findIndex((item) => item.triggerEl === triggerEl);
            if (this.currentIndex === -1)
                this.currentIndex = 0;
            this.userHasNavigated = false;
        }
        // ─── Event Handlers ──────────────────────────────────────────
        handleClick(e) {
            const trigger = e.target.closest(this.opts.selector);
            if (!trigger)
                return;
            // Let the browser handle modifier and non-primary clicks (open in new
            // tab/window, etc.) rather than hijacking them to open the lightbox.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
                return;
            e.preventDefault();
            const src = this.getSrcFromTrigger(trigger);
            if (!src)
                return;
            // If lightbox is open, closing, or animating, clean up then open the new one
            if (this.state.isOpen || this.state.isAnimating || this.state.isClosing) {
                this.stopSpring();
                this.stopFitTransition();
                this.stopStripSpring();
                this.state.isAnimating = false;
                this.state.isClosing = false;
                this.state.isDismissClosing = false;
                this.finishClose();
            }
            this.buildGallery(trigger);
            this.open(src, trigger);
        }
        handleKeydown(e) {
            if (e.key === 'Tab') {
                this.trapFocus(e);
                return;
            }
            // Exit fade in progress: nothing below may interrupt it
            if (this.state.isClosing)
                return;
            if (e.key === 'Escape') {
                if (this.dismiss.active) {
                    // Dismiss gesture in progress — complete the close
                    this.dismissClose(0, 0);
                    return;
                }
                if (this.zoom.zoomingOut) {
                    // Zoom-out already in progress — close the lightbox
                    this.close();
                }
                else if (this.zoom.zoomed || this.zoom.scale !== 1) {
                    // Zoomed in (idle or animating in) — zoom out first
                    this.zoomOut();
                }
                else {
                    this.close();
                }
            }
            else if (e.key === 'ArrowRight') {
                if (this.zoom.scale === 1 && !this.swipeNav.active) {
                    this.next();
                }
            }
            else if (e.key === 'ArrowLeft') {
                if (this.zoom.scale === 1 && !this.swipeNav.active) {
                    this.prev();
                }
            }
        }
        trapFocus(e) {
            if (!this.overlay)
                return;
            const focusable = this.overlay.querySelectorAll('button:not([disabled]):not([style*="display: none"])');
            if (focusable.length === 0)
                return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === first || !this.overlay.contains(document.activeElement)) {
                    e.preventDefault();
                    last.focus();
                }
            }
            else {
                if (document.activeElement === last || !this.overlay.contains(document.activeElement)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
        getSrcFromTrigger(trigger) {
            const anchor = trigger.closest('a') || trigger;
            return anchor.getAttribute('href') || anchor.querySelector('img')?.src || '';
        }
        // ─── Open / Close ────────────────────────────────────────────
        open(src, triggerEl) {
            if (this.state.isOpen || this.state.isAnimating)
                return;
            this.cancelViewportPreload(false);
            this.debugLog('open');
            this.fullResFading = false;
            this.stopFullResFade();
            this.state.isOpen = true;
            this.state.isAnimating = true;
            this.state.triggerEl = triggerEl || null;
            this.state.currentSrc = src;
            this.previouslyFocusedEl = document.activeElement;
            this.lockBodyScroll();
            this.startDebugPanel();
            this.emit('open');
            const thumbImg = triggerEl?.querySelector('img');
            const thumbSrc = thumbImg?.currentSrc || thumbImg?.src || '';
            if (!thumbImg) {
                // Text-link trigger (no thumbnail)
                this.openTextLink(src);
                return;
            }
            const thumbBox = thumbImg.getBoundingClientRect();
            const thumbNatW = thumbImg.naturalWidth || thumbBox.width;
            const thumbNatH = thumbImg.naturalHeight || thumbBox.height;
            const cached = this.preloadCache.get(src);
            const fullResReady = cached?.complete && cached.naturalWidth > 0;
            // Show the full-res straight away when it is already loaded. Otherwise open
            // with an empty image (no low-res thumbnail flash) and fade the full-res in
            // via swapToFullRes once it has been downloaded and decoded.
            const overlaySrc = fullResReady ? src : (thumbSrc === src ? src : '');
            this.createOverlay(overlaySrc);
            this.createChrome();
            document.addEventListener('keydown', this.handleKeydown);
            const hint = this.getDimensionHint(triggerEl);
            let natW, natH, targetRect;
            if (fullResReady) {
                natW = cached.naturalWidth;
                natH = cached.naturalHeight;
                targetRect = this.computeTargetRect(natW, natH);
            }
            else if (hint) {
                // Author-declared true dimensions — use the capped rect (respects the
                // "never upscale" rule) so the image lands exactly where the loaded
                // image will, with no reflow when full-res arrives.
                natW = hint.w;
                natH = hint.h;
                targetRect = this.computeTargetRect(natW, natH);
            }
            else {
                // Full-res dimensions unknown — use thumbnail aspect ratio to fill the
                // viewport. Without this, the "never upscale" cap in computeTargetRect
                // keeps the image at the thumbnail's small pixel size.
                natW = thumbNatW;
                natH = thumbNatH;
                targetRect = this.computeTargetRectFromAspectRatio(natW, natH);
            }
            this.positionImage(targetRect);
            this.zoom = this.defaultZoomState();
            this.zoom.fitRect = targetRect;
            this.zoom.naturalWidth = natW;
            this.zoom.naturalHeight = natH;
            // Start full-res load immediately so it continues regardless of animation interrupts
            if (thumbSrc !== src) {
                this.swapToFullRes(src);
            }
            // Preload neighbor images BEFORE populating adjacent slides — this ensures
            // the preload cache has Image objects that setupSlideImage can attach load
            // listeners to.
            if (this.gallery.length > 1) {
                this.schedulePreloads();
            }
            // Populate adjacent gallery slides (off-screen, ready for swipe)
            this.populateAdjacentSlides();
            // Fade in: backdrop, image and chrome all follow the same opacity spring.
            // If the full-res is already on screen, wait (briefly) for it to be decoded.
            this.startOpenFade(overlaySrc ? this.imgEl : null);
        }
        /**
         * Fade the lightbox in. `decodeEl` is an <img> that is already showing its final
         * image; the fade is held fully transparent until it is decoded (capped at
         * OPEN_DECODE_MAX_WAIT_MS) so the fade doesn't start on an undecoded image.
         * onEarlyComplete fires when visually done (opacity ≈ 1) — clears isAnimating
         * so dismiss tracking isn't blocked while the spring settles.
         */
        startOpenFade(decodeEl) {
            const imgEl = this.imgEl;
            const targetBR = this.getTargetBorderRadius();
            const from = { translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0, borderRadius: targetBR };
            const to = { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR };
            this.isOpening = true;
            const run = () => {
                // Closed, closed-and-reopened or interrupted while waiting for the decode
                if (this.imgEl !== imgEl || !this.state.isOpen || this.state.isClosing)
                    return;
                this.animateSpring(from, to, this.opts.fadeOpen, () => {
                    this.isOpening = false;
                    this.state.isAnimating = false;
                    this.updateCursorState();
                    this.emit('opened');
                }, undefined, undefined, undefined, (s) => s.opacity > 0.99);
            };
            if (decodeEl && !this.reducedMotion && typeof decodeEl.decode === 'function' && decodeEl.getAttribute('src')) {
                // Hold everything fully transparent until the image is decoded
                this.applyAnimState(imgEl, this.backdrop, from);
                let started = false;
                const go = () => {
                    if (started)
                        return;
                    started = true;
                    run();
                };
                decodeImage(decodeEl).then(go);
                setTimeout(go, OPEN_DECODE_MAX_WAIT_MS);
            }
            else {
                run();
            }
        }
        stopFullResFade() {
            if (this.fullResFadeTimer) {
                clearTimeout(this.fullResFadeTimer);
                this.fullResFadeTimer = null;
            }
        }
        /** Abort an in-progress full-res fade-in (used when a close starts). */
        cancelFullResFade() {
            this.stopFullResFade();
            if (this.fullResFading) {
                this.fullResFading = false;
                if (this.imgEl)
                    this.imgEl.style.transition = '';
            }
        }
        openTextLink(src) {
            const cached = this.preloadCache.get(src);
            const fullResReady = cached?.complete && cached.naturalWidth > 0;
            if (fullResReady) {
                // Image already loaded — fade straight in
                this.openTextLinkWithImage(src, cached.naturalWidth, cached.naturalHeight);
                return;
            }
            // Image not ready — show overlay + spinner, load, then fade the image in
            this.createOverlay('');
            this.createChrome();
            document.addEventListener('keydown', this.handleKeydown);
            this.textLinkLoading = true;
            if (this.imgEl)
                this.imgEl.style.opacity = '0';
            // Show spinner after a short delay (skip if image loads fast)
            this.spinnerTimer = setTimeout(() => {
                if (this.overlay && this.state.currentSrc === src) {
                    const spinner = document.createElement('div');
                    spinner.className = 'lightbox3-spinner';
                    this.overlay.appendChild(spinner);
                    this.spinnerEl = spinner;
                }
            }, SPINNER_DELAY_MS);
            // Fade in backdrop
            const targetBR = this.getTargetBorderRadius();
            this.animateSpring({ translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0, borderRadius: targetBR }, { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR }, this.opts.fadeOpen, () => { }, undefined);
            // Load image, then fade it in
            this.loadImage(src).then((size) => {
                if (!this.imgEl || this.state.currentSrc !== src)
                    return;
                if (this.state.isClosing || !this.state.isOpen)
                    return;
                this.removeSpinner();
                this.openTextLinkWithImage(src, size.width, size.height);
            });
        }
        /** Fade in a text-link trigger's image once its dimensions are known. */
        openTextLinkWithImage(src, natW, natH) {
            const targetRect = this.computeTargetRect(natW, natH);
            // If the overlay already exists we were waiting for the download (the backdrop
            // is already fading in), so don't hold the fade for a decode in that case.
            const wasPending = !!this.overlay;
            // If overlay wasn't created yet (preloaded path), create it now
            if (!this.overlay) {
                this.createOverlay(src);
                this.createChrome();
                document.addEventListener('keydown', this.handleKeydown);
            }
            else {
                this.imgEl.src = src;
            }
            this.textLinkLoading = false;
            this.positionImage(targetRect);
            this.zoom = this.defaultZoomState();
            this.zoom.fitRect = targetRect;
            this.zoom.naturalWidth = natW;
            this.zoom.naturalHeight = natH;
            // Preload neighbors and populate adjacent gallery slides so next/prev works
            // immediately. Without this, the first navigation from a text-link trigger
            // recycles a non-existent adjacent slot and lands on an empty image.
            if (this.gallery.length > 1) {
                this.schedulePreloads();
            }
            this.populateAdjacentSlides();
            this.startOpenFade(wasPending ? null : this.imgEl);
        }
        removeSpinner() {
            if (this.spinnerTimer) {
                clearTimeout(this.spinnerTimer);
                this.spinnerTimer = null;
            }
            if (this.spinnerEl) {
                this.spinnerEl.remove();
                this.spinnerEl = null;
            }
        }
        /**
         * Resolves once the open spring has fully settled (or immediately during
         * navigation / when closing). A fast-loading image would otherwise arrive
         * mid-spring, where applyAnimState() keeps resetting img.style.opacity and
         * the fade-in is lost. Waiting makes a fast load behave exactly like a slow one.
         */
        afterOpenSpring(skip) {
            return new Promise((resolve) => {
                const check = () => {
                    if (skip || !this.state.isAnimating || !this.state.isOpen || this.state.isClosing) {
                        resolve();
                    }
                    else {
                        requestAnimationFrame(check);
                    }
                };
                check();
            });
        }
        /**
         * When the current slide is showing a thumbnail (e.g. after navigating to an image
         * that hadn't finished preloading), decode the full-size image before swapping it in,
         * so the swap doesn't show a blank or half-painted frame.
         */
        decodeBeforeThumbSwap(src) {
            const el = this.imgEl;
            if (!el || this.state.currentSrc !== src || !el.getAttribute('src'))
                return Promise.resolve();
            if (el.src === new URL(src, document.baseURI).href)
                return Promise.resolve();
            return decodeImage(this.preloadCache.get(src));
        }
        swapToFullRes(src) {
            // Capture whether this swap was triggered during a navigation.
            // If so, suppress the fade-in — the strip animation already handles the visual transition.
            const calledDuringNavigation = this.stripRafId !== null;
            // Cancel any spinner timer left over from a previous swap
            if (this.spinnerTimer) {
                clearTimeout(this.spinnerTimer);
                this.spinnerTimer = null;
            }
            // Show a spinner if the full-res image takes longer than SPINNER_DELAY_MS to
            // download. It is never shown while the lightbox is still fading in: with a
            // slow open the 300 ms mark can arrive mid-fade, and the spinner would appear
            // before the image. In that case the check is simply repeated until the fade
            // has finished (the spinner is removed as soon as the download completes).
            const showSpinner = () => {
                this.spinnerTimer = null;
                if (!this.overlay || this.state.currentSrc !== src || this.spinnerEl || this.state.isClosing)
                    return;
                if (this.state.isAnimating) {
                    this.spinnerTimer = setTimeout(showSpinner, 50);
                    return;
                }
                const spinner = document.createElement('div');
                spinner.className = 'lightbox3-spinner';
                // Match the spinner's container to the exact bounds of the image
                if (this.zoom && this.zoom.fitRect && this.zoom.fitRect.width > 0) {
                    const rect = this.zoom.fitRect;
                    spinner.style.position = 'absolute';
                    spinner.style.left = `${rect.x}px`;
                    spinner.style.top = `${rect.y}px`;
                    spinner.style.width = `${rect.width}px`;
                    spinner.style.height = `${rect.height}px`;
                    spinner.style.display = 'flex';
                    spinner.style.alignItems = 'center';
                    spinner.style.justifyContent = 'center';
                    spinner.style.pointerEvents = 'none';
                }
                this.overlay.appendChild(spinner);
                this.spinnerEl = spinner;
            };
            this.spinnerTimer = setTimeout(showSpinner, SPINNER_DELAY_MS);
            this.loadImage(src).then((size) => {
                // Download finished: drop the spinner right away, even if the open fade
                // is still running and the swap has to wait for it.
                this.removeSpinner();
                return this.afterOpenSpring(calledDuringNavigation).then(() => size);
            }).then((size) => this.decodeBeforeThumbSwap(src).then(() => size)).then((size) => {
                // Image loaded — cancel the pending spinner and remove any visible one
                this.removeSpinner();
                if (!this.imgEl || this.state.currentSrc !== src)
                    return;
                // Full-res loaded after close started — don't reposition the image
                if (this.state.isClosing || !this.state.isOpen)
                    return;
                // Fade in on full-res swap — only when the swap was not triggered by a
                // navigation. During navigation the strip animation handles the transition.
                const el = this.imgEl;
                // Cached open: the full-res is already on screen (src was set up front),
                // so there is nothing to fade in.
                const alreadyShowing = el.src === new URL(src, document.baseURI).href
                    && el.complete && el.naturalWidth > 0;
                // The slide is showing a thumbnail (we got here by navigating to an image that
                // wasn't preloaded yet). Fading from opacity 0 would make the thumbnail blink
                // out before the full-res appears, so swap the decoded image in place instead.
                // When the lightbox is opening, the image has no src yet, so it still fades in.
                // The placeholder is never visible by design (transparent / loader), so there
                // is nothing to blink out: always fade the full-res in, and snap the rect
                // while the image is still at opacity 0 (no zoom/crop on arrival).
                const fadeIn = !this.reducedMotion && !alreadyShowing;
                if (fadeIn) {
                    el.style.transition = 'none';
                    el.style.opacity = '0';
                    this.fullResFading = true;
                }
                // Restore box-shadow (was hidden while thumb was showing).
                // At this point opacity is 0, so the shadow is invisible and will
                // fade in naturally with the image opacity transition.
                el.style.boxShadow = '';
                if (!alreadyShowing)
                    this.imgEl.src = src;
                this.zoom.naturalWidth = size.width;
                this.zoom.naturalHeight = size.height;
                if (!this.zoom.zoomed) {
                    const targetRect = this.computeTargetRect(size.width, size.height);
                    const currentRect = this.zoom.fitRect;
                    const dx = Math.abs(targetRect.x - currentRect.x);
                    const dy = Math.abs(targetRect.y - currentRect.y);
                    const dw = Math.abs(targetRect.width - currentRect.width);
                    const dh = Math.abs(targetRect.height - currentRect.height);
                    const rectChanged = dx > 1 || dy > 1 || dw > 1 || dh > 1;
                    if (rectChanged && fadeIn) {
                        // Image is at opacity 0 — snap rect instantly so the spring
                        // zoom doesn't play on top of the fade.
                        this.zoom.fitRect = targetRect;
                        this.positionImage(targetRect);
                        this.updateChromeVisuals();
                    } else if (rectChanged) {
                        this.animateFitTransition(currentRect, targetRect);
                    } else {
                        this.zoom.fitRect = targetRect;
                        this.positionImage(targetRect);
                    }
                }
                this.updateCursorState();
                // Decode before fading so the first fade frame already has pixels.
                const decoded = fadeIn && el.decode ? el.decode().catch(() => { }) : Promise.resolve();
                decoded.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (!el || el !== this.imgEl || !this.state.isOpen || this.state.isClosing) {
                        this.fullResFading = false;
                        return;
                    }
                    if (!fadeIn) {
                        this.stopFullResFade();
                        return;
                    }
                    el.style.transition = 'opacity 0.4s ease';
                    el.style.opacity = '1';
                    const done = () => {
                        this.fullResFading = false;
                        if (el === this.imgEl) {
                            el.style.transition = '';
                            el.style.opacity = '';
                        }
                        this.stopFullResFade();
                    };
                    el.addEventListener('transitionend', done, { once: true });
                    // Safety net in case transitionend never fires
                    this.fullResFadeTimer = setTimeout(() => {
                        el.removeEventListener('transitionend', done);
                        done();
                    }, 700);
                })));
            });
        }
        /** Spring-animate the image from one fit rect to another (aspect ratio change). */
        animateFitTransition(from, to) {
            this.stopFitTransition();
            if (this.reducedMotion) {
                this.zoom.fitRect = to;
                this.positionImage(to);
                return;
            }
            const img = this.imgEl;
            const config = PAN_SPRING; // Soft spring for a gentle settle
            const springs = {
                x: { position: from.x, velocity: 0, settled: false },
                y: { position: from.y, velocity: 0, settled: false },
                w: { position: from.width, velocity: 0, settled: false },
                h: { position: from.height, velocity: 0, settled: false },
            };
            let lastTime = performance.now();
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                springs.x = springStep(config, springs.x, to.x, dt);
                springs.y = springStep(config, springs.y, to.y, dt);
                springs.w = springStep(config, springs.w, to.width, dt);
                springs.h = springStep(config, springs.h, to.height, dt);
                Object.assign(img.style, {
                    left: `${springs.x.position}px`,
                    top: `${springs.y.position}px`,
                    width: `${springs.w.position}px`,
                    height: `${springs.h.position}px`,
                });
                const settled = springs.x.settled && springs.y.settled && springs.w.settled && springs.h.settled;
                if (settled) {
                    this.zoom.fitRect = to;
                    this.positionImage(to);
                    this.fitRafId = null;
                    return;
                }
                // Keep fitRect in sync so zoom/pan reads live values
                this.zoom.fitRect = new DOMRect(springs.x.position, springs.y.position, springs.w.position, springs.h.position);
                this.fitRafId = requestAnimationFrame(tick);
            };
            this.fitRafId = requestAnimationFrame(tick);
        }
        stopFitTransition() {
            if (this.fitRafId !== null) {
                cancelAnimationFrame(this.fitRafId);
                this.fitRafId = null;
            }
        }
        close() {
            if (this.state.isClosing)
                return;
            if (!this.state.isOpen && !this.state.isAnimating)
                return;
            // If dismiss gesture is in progress, close from the current dismiss position
            if (this.dismiss.active) {
                this.dismissClose(0, 0);
                return;
            }
            // If pinch is active below fit scale, bridge into pinch close
            if (this.pinch.active && this.zoom.scale < 1) {
                this.pinch.active = false;
                this.pinchClose();
                return;
            }
            // Stop any strip animation and reset
            this.stopStripSpring();
            this.stripOffset = 0;
            if (this.stripEl)
                this.stripEl.style.transform = '';
            this.swipeNav = this.defaultSwipeNavState();
            this.state.isClosing = true;
            this.isOpening = false;
            this.cancelFullResFade();
            this.emit('close');
            this.stopSpring();
            this.stopFitTransition();
            this.stopChromeSpring();
            this.chromeSpring = { position: 0, velocity: 0 };
            this.state.isAnimating = false;
            this.dismiss = this.defaultDismissState();
            // Let clicks pass through to thumbnails underneath during close.
            // Delayed so the overlay still blocks the synthetic click that mobile browsers
            // dispatch after pointerup (which can arrive after rAF on mobile Safari).
            if (this.overlay) {
                const ov = this.overlay;
                setTimeout(() => this.makeOverlayInert(ov), 80);
            }
            // If zoomed (idle or mid-animation), reset zoom first then close
            if (this.zoom.zoomed || this.zoom.zoomingOut || this.zoom.scale !== 1) {
                this.zoom.scale = 1;
                this.zoom.panX = 0;
                this.zoom.panY = 0;
                this.zoom.zoomed = false;
                this.zoom.zoomingOut = false;
                this.imgEl.style.transform = '';
            }
            this.state.isAnimating = true;
            // Fade out in place: backdrop, image and chrome follow the same opacity spring.
            const currentBR = this.getTargetBorderRadius();
            this.animateSpring({ translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: currentBR }, { translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0, borderRadius: currentBR }, this.opts.fadeClose, () => this.finishClose(), (s) => s.opacity < 0.01);
        }
        /**
         * Make a closing overlay completely click-through. Setting pointer-events:none
         * on the overlay alone is not enough: the slides carry an explicit
         * pointer-events:auto, which overrides the parent, so the fading image kept
         * receiving clicks. A click on it during the exit fade reached zoomIn/zoomOut,
         * which cancelled the close spring, so finishClose() never ran and the
         * overlay stayed on screen, semi-transparent, with isClosing stuck at true.
         */
        makeOverlayInert(ov) {
            if (!ov)
                return;
            ov.style.pointerEvents = 'none';
            ov.querySelectorAll('*').forEach((el) => {
                el.style.pointerEvents = 'none';
            });
        }
        finishClose() {
            this.debugLog('finishClose');
            this.stopDebugPanel();
            this.fullResFading = false;
            this.isOpening = false;
            this.textLinkLoading = false;
            this.stopFullResFade();
            this.removeSpinner();
            this.scheduleViewportPreload(800);
            this.stopFitTransition();
            this.stopChromeSpring();
            this.chromeSpring = { position: 0, velocity: 0 };
            this.chromeBaseOpacity = 0;
            this.resetChromeDrift();
            this.removeOverlay();
            this.unlockBodyScroll();
            document.removeEventListener('keydown', this.handleKeydown);
            if (this.previouslyFocusedEl) {
                this.previouslyFocusedEl.focus();
                this.previouslyFocusedEl = null;
            }
            this.emit('closed');
            this.state.isOpen = false;
            this.state.isAnimating = false;
            this.state.isClosing = false;
            this.state.isDismissClosing = false;
            this.state.triggerEl = null;
            this.zoom = this.defaultZoomState();
            this.pointerCache = [];
            this.pinch = this.defaultPinchState();
            this.dismiss = this.defaultDismissState();
            this.swipeNav = this.defaultSwipeNavState();
            this.pendingNavDirection = null;
            this.gallery = [];
            this.currentIndex = 0;
            this.userHasNavigated = false;
            this.stripOffset = 0;
            this.wheelDismissY = 0;
            this.wheelNavCommitted = false;
            this.wheelNavTotalDelta = 0;
            if (this.wheelGestureTimer !== null) {
                clearTimeout(this.wheelGestureTimer);
                this.wheelGestureTimer = null;
            }
            if (this.wheelSnapBackTimer !== null) {
                clearTimeout(this.wheelSnapBackTimer);
                this.wheelSnapBackTimer = null;
            }
        }
        // ─── Gallery navigation ────────────────────────────────────
        next() {
            if (this.gallery.length <= 1)
                return;
            if (this.zoom.scale !== 1)
                return;
            this.forceCompleteStripAnimation();
            if (this.currentIndex >= this.gallery.length - 1) {
                this.bounceStrip(-1);
                return;
            }
            this.navigateTo(1);
        }
        prev() {
            if (this.gallery.length <= 1)
                return;
            if (this.zoom.scale !== 1)
                return;
            this.forceCompleteStripAnimation();
            if (this.currentIndex <= 0) {
                this.bounceStrip(1);
                return;
            }
            this.navigateTo(-1);
        }
        navigateTo(direction) {
            this.debugLog(`navigateTo(${direction > 0 ? 'next' : 'prev'})`);
            this.userHasNavigated = true;
            this.pendingNavDirection = direction;
            // The thumbnail layer belongs to the image that was opened
            this.fullResFading = false;
            this.stopFullResFade();
            // Enable pointer events on the destination slide so it can receive clicks
            // while animating into view, instead of falling through to the backdrop.
            const destSlide = direction === 1 ? this.nextSlideEl : this.prevSlideEl;
            if (destSlide)
                destSlide.style.pointerEvents = 'auto';
            const slideWidth = window.innerWidth + SLIDE_GAP;
            const targetX = -direction * slideWidth;
            this.animateStrip(this.stripOffset, targetX, this.opts.springOpen, 0, () => this.completeNavigation(direction));
        }
        completeNavigation(direction) {
            this.debugLog(`completeNavigation(${direction > 0 ? 'next' : 'prev'})`);
            this.pendingNavDirection = null;
            // Update index and trigger
            this.currentIndex += direction;
            const item = this.gallery[this.currentIndex];
            this.state.triggerEl = item.triggerEl;
            this.state.currentSrc = item.src;
            this.emit('navigate');
            // Update chrome UI — cross-fade already swapped caption/counter text,
            // so just ensure it's correct for the new index and reset fade state.
            this.updateChromeContent();
            this.chromeFadeSwapped = false;
            if (this.chromeCaption)
                this.chromeCaption.style.opacity = '';
            if (this.chromeCounter)
                this.chromeCounter.style.opacity = '';
            // Reset strip BEFORE recycling — recycleSlots creates a new adjacent slide
            // and appends it to the strip. If the strip still has its animation transform
            // (-slideWidth), the new slide at left:slideWidth appears at visual position 0
            // (center) for one frame before the transform is cleared.
            this.stripOffset = 0;
            if (this.stripEl)
                this.stripEl.style.transform = '';
            // Schedule preloads BEFORE recycling — recycleSlots creates a new adjacent
            // slide, and it needs the preload cache entry to exist so it can attach a
            // load listener for the full-res upgrade.
            this.schedulePreloads();
            // Recycle DOM slots
            this.recycleSlots(direction);
            // Reset slide image opacities — the strip offset reset above skips
            // applyStripOffset(0), so we clear them explicitly here.
            if (this.imgEl)
                this.imgEl.style.opacity = '';
            if (this.nextSlideImg)
                this.nextSlideImg.style.opacity = '';
            if (this.prevSlideImg)
                this.prevSlideImg.style.opacity = '';
            // Set up new current image (zoom state, full-res swap)
            this.setupCurrentImage();
            // Navigation complete — clear the interpolated override so updateChromeVisuals
            // uses the fresh zoom.fitRect from setupCurrentImage going forward.
            this.chromeBarFitRect = null;
            // Reposition chrome bar immediately using the new fitRect so the caption
            // doesn't lag behind waiting for the next pointer/spring event.
            this.updateChromeVisuals();
            // Wheel navigation: ready for new gesture now that the image has landed
            this.wheelNavCommitted = false;
            this.wheelNavTotalDelta = 0;
        }
        /**
         * After strip animation completes, reposition slide elements so the new
         * current image is at left:0. Remove the old far slide, create a new one
         * at the opposite edge.
         */
        recycleSlots(direction) {
            const slideWidth = window.innerWidth + SLIDE_GAP;
            if (direction === 1) {
                // Forward: prev is removed, current→prev, next→current, create new next
                if (this.prevSlideEl)
                    this.prevSlideEl.remove();
                this.prevSlideEl = this.currentSlideEl;
                this.prevSlideImg = this.imgEl;
                if (this.prevSlideEl) {
                    this.prevSlideEl.style.left = `${-slideWidth}px`;
                    this.prevSlideEl.style.pointerEvents = 'none';
                }
                this.currentSlideEl = this.nextSlideEl;
                this.imgEl = this.nextSlideImg;
                if (this.currentSlideEl) {
                    this.currentSlideEl.style.left = '0';
                    this.currentSlideEl.style.pointerEvents = 'auto';
                }
                this.nextSlideEl = null;
                this.nextSlideImg = null;
                if (this.currentIndex < this.gallery.length - 1) {
                    this.createAdjacentSlide(this.currentIndex + 1, slideWidth);
                }
            }
            else {
                // Backward: next is removed, current→next, prev→current, create new prev
                if (this.nextSlideEl)
                    this.nextSlideEl.remove();
                this.nextSlideEl = this.currentSlideEl;
                this.nextSlideImg = this.imgEl;
                if (this.nextSlideEl) {
                    this.nextSlideEl.style.left = `${slideWidth}px`;
                    this.nextSlideEl.style.pointerEvents = 'none';
                }
                this.currentSlideEl = this.prevSlideEl;
                this.imgEl = this.prevSlideImg;
                if (this.currentSlideEl) {
                    this.currentSlideEl.style.left = '0';
                    this.currentSlideEl.style.pointerEvents = 'auto';
                }
                this.prevSlideEl = null;
                this.prevSlideImg = null;
                if (this.currentIndex > 0) {
                    this.createAdjacentSlide(this.currentIndex - 1, -slideWidth);
                }
            }
        }
        /** Set up zoom state and image src for the newly-centered current image. */
        setupCurrentImage() {
            this.zoom = this.defaultZoomState();
            this.stopFitTransition();
            const item = this.gallery[this.currentIndex];
            if (!item || !this.imgEl)
                return;
            // Check preload cache first
            const cached = this.preloadCache.get(item.src);
            const fullResReady = cached?.complete && cached.naturalWidth > 0;
            // Also check if the slide's img element already has full-res loaded
            // (e.g. preload finished during strip animation and upgraded the adjacent slide)
            const imgHasFullRes = this.imgEl.src === item.src &&
                this.imgEl.complete &&
                this.imgEl.naturalWidth > 0;
            if (imgHasFullRes) {
                const natW = fullResReady ? cached.naturalWidth : this.imgEl.naturalWidth;
                const natH = fullResReady ? cached.naturalHeight : this.imgEl.naturalHeight;
                this.zoom.naturalWidth = natW;
                this.zoom.naturalHeight = natH;
                this.zoom.fitRect = this.computeTargetRect(natW, natH);
                this.imgEl.src = item.src;
                // Full-res is already loaded, so swapToFullRes won't run to restore
                // the shadow that was hidden while this slide showed its thumbnail.
                this.imgEl.style.boxShadow = '';
                this.positionImage(this.zoom.fitRect);
            }
            else {
                // Prefer the real dimensions when the full-res is cached (swapToFullRes will
                // then fade it in), otherwise the author-provided hint.
                const hint = fullResReady
                    ? { w: cached.naturalWidth, h: cached.naturalHeight }
                    : this.getDimensionHint(item.triggerEl);
                if (hint) {
                    this.zoom.naturalWidth = hint.w;
                    this.zoom.naturalHeight = hint.h;
                    this.zoom.fitRect = this.computeTargetRect(hint.w, hint.h);
                }
                else {
                    const thumbImg = item.triggerEl.querySelector('img');
                    const natW = thumbImg?.naturalWidth || 400;
                    const natH = thumbImg?.naturalHeight || 300;
                    this.zoom.naturalWidth = natW;
                    this.zoom.naturalHeight = natH;
                    this.zoom.fitRect = this.computeTargetRectFromAspectRatio(natW, natH);
                }
                this.positionImage(this.zoom.fitRect);
                this.swapToFullRes(item.src);
            }
            // Apply border-radius to the new current image (previous image had it from
            // the open animation, but this is a fresh DOM element after slot recycling).
            const br = this.getTargetBorderRadius();
            if (this.imgEl) {
                this.imgEl.style.borderRadius = br > 0 ? `${br}px` : '';
            }
            this.updateCursorState();
        }
        /**
         * If a strip spring is running (from a flick or arrow key), resolve it so
         * the user can start a new gesture from a clean state.
         */
        resolveStripAnimation() {
            if (this.stripRafId === null)
                return;
            this.stopStripSpring();
            const slideWidth = window.innerWidth + SLIDE_GAP;
            if (Math.abs(this.stripOffset) > slideWidth / 2) {
                // Past halfway — complete the navigation
                const direction = (this.stripOffset < 0 ? 1 : -1);
                const newIndex = this.currentIndex + direction;
                if (newIndex >= 0 && newIndex < this.gallery.length) {
                    // Adjust offset to preserve visual positions after recycling
                    this.stripOffset += direction * slideWidth;
                    this.completeNavigation(direction);
                    // completeNavigation resets stripOffset to 0, but we adjusted it above
                    // so the visual position is preserved. Re-apply the adjusted offset.
                }
            }
            // stripOffset is now close to 0 (or exactly 0 after completeNavigation)
            this.applyStripOffset(this.stripOffset);
        }
        // ─── Spring animation engine (rAF) ──────────────────────────
        animateSpring(from, to, config, onComplete, earlyComplete, initialVelocities, configOverrides, onEarlyComplete) {
            this.stopSpring();
            const img = this.imgEl;
            const backdrop = this.backdrop;
            if (this.reducedMotion) {
                this.applyAnimState(img, backdrop, to);
                onComplete();
                return;
            }
            // One spring per animated property
            const springs = [
                {
                    key: 'translateX',
                    state: { position: from.translateX, velocity: initialVelocities?.translateX ?? 0 },
                    target: to.translateX,
                    config: configOverrides?.translateX ?? config,
                },
                {
                    key: 'translateY',
                    state: { position: from.translateY, velocity: initialVelocities?.translateY ?? 0 },
                    target: to.translateY,
                    config: configOverrides?.translateY ?? config,
                },
                {
                    key: 'scale',
                    state: { position: from.scale, velocity: initialVelocities?.scale ?? 0 },
                    target: to.scale,
                    config: configOverrides?.scale ?? config,
                },
                {
                    key: 'opacity',
                    state: { position: from.opacity, velocity: initialVelocities?.opacity ?? 0 },
                    target: to.opacity,
                    config: configOverrides?.opacity ?? config,
                },
                {
                    key: 'crop',
                    state: { position: from.crop, velocity: initialVelocities?.crop ?? 0 },
                    target: to.crop,
                    config: configOverrides?.crop ?? config,
                },
                {
                    key: 'borderRadius',
                    state: { position: from.borderRadius, velocity: initialVelocities?.borderRadius ?? 0 },
                    target: to.borderRadius,
                    config: configOverrides?.borderRadius ?? config,
                },
            ];
            let lastTime = performance.now();
            let firedEarlyComplete = false;
            // Apply initial state
            this.applyAnimState(img, backdrop, from);
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                let allSettled = true;
                const current = {};
                for (const s of springs) {
                    const result = springStep(s.config, s.state, s.target, dt);
                    s.state = result;
                    current[s.key] = result.position;
                    if (!result.settled)
                        allSettled = false;
                }
                const currentState = current;
                this.applyAnimState(img, backdrop, currentState);
                // onEarlyComplete: fire onComplete early but keep the spring running
                // (used by open animation to unblock interaction while bounce continues)
                if (!firedEarlyComplete && onEarlyComplete?.(currentState)) {
                    firedEarlyComplete = true;
                    onComplete();
                }
                if (allSettled || earlyComplete?.(currentState)) {
                    // Snap to exact final values
                    this.applyAnimState(img, backdrop, to);
                    this.debugLog(`mainRaf settled${earlyComplete?.(currentState) ? ' (early)' : ''}`);
                    this.rafId = null;
                    if (!firedEarlyComplete)
                        onComplete();
                    return;
                }
                this.rafId = requestAnimationFrame(tick);
            };
            this.rafId = requestAnimationFrame(tick);
        }
        applyAnimState(img, backdrop, state) {
            img.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
            backdrop.style.opacity = String(state.opacity);
            // Image opacity: fades together with the backdrop on open and close.
            if (this.textLinkLoading) {
                // Text link whose image has not loaded yet — keep it hidden
                img.style.opacity = '0';
            }
            else if (this.fullResFading) {
                // The full-res fade-in owns the image opacity
            }
            else if (this.state.isClosing && this.state.isDismissClosing) {
                // Swipe/pinch dismiss: the image was fully opaque while dragging
                img.style.opacity = String(Math.min(1, state.opacity / DISMISS_FADE_THRESHOLD));
            }
            else if (this.state.isClosing || this.isOpening) {
                img.style.opacity = String(state.opacity);
            }
            else {
                img.style.opacity = '';
            }
            // Border-radius: compensate for the dismiss scale so the visual radius
            // matches the animated value.
            const br = state.borderRadius > 0.1 ? state.borderRadius / Math.max(state.scale, 0.01) : 0;
            img.style.borderRadius = br > 0.1 ? `${br}px` : '';
            img.style.clipPath = '';
            // Chrome follows backdrop opacity during open/close.
            // Accelerate fade-out on close so chrome disappears before the image does.
            this.chromeBaseOpacity = this.state.isClosing
                ? Math.pow(state.opacity, 2)
                : state.opacity;
            this.updateChromeVisuals();
        }
        // ─── Strip spring (gallery slide animation) ─────────────────
        animateStrip(fromX, toX, config, velocity, onComplete) {
            this.stopStripSpring();
            if (this.reducedMotion) {
                this.stripOffset = toX;
                this.applyStripOffset(toX);
                onComplete();
                return;
            }
            let spring = { position: fromX, velocity };
            let lastTime = performance.now();
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const result = springStep(config, spring, toX, dt);
                spring = result;
                this.stripOffset = result.position;
                this.applyStripOffset(result.position);
                // Early completion: sub-pixel position + low velocity means visually done.
                // Without this, the spring long tail adds ~500ms of imperceptible creep.
                const earlyDone = Math.abs(result.position - toX) < 1 && Math.abs(result.velocity) < 5;
                if (result.settled || earlyDone) {
                    this.stripOffset = toX;
                    this.applyStripOffset(toX);
                    this.debugLog('stripRaf settled');
                    this.stripRafId = null;
                    onComplete();
                    return;
                }
                this.stripRafId = requestAnimationFrame(tick);
            };
            this.stripRafId = requestAnimationFrame(tick);
        }
        stopStripSpring() {
            if (this.stripRafId !== null) {
                cancelAnimationFrame(this.stripRafId);
                this.stripRafId = null;
            }
        }
        applyStripOffset(offset) {
            if (this.stripEl) {
                this.stripEl.style.transform = offset ? `translateX(${offset}px)` : '';
            }
            this.updateChromeFade(offset);
            this.updateSlideImageFade(offset);
        }
        /**
         * Cross-fade caption and counter as the strip slides between images.
         * Opacity follows a V-curve: 1 → 0 at midpoint → 1.
         * Text content swaps at the midpoint so the new caption fades in.
         */
        updateChromeFade(offset) {
            if (this.gallery.length <= 1)
                return;
            if (offset === 0) {
                if (this.chromeCaption)
                    this.chromeCaption.style.opacity = '';
                if (this.chromeCounter)
                    this.chromeCounter.style.opacity = '';
                if (this.chromeClose)
                    this.chromeClose.style.opacity = '';
                this.chromeFadeSwapped = false;
                this.chromeBarFitRect = null;
                return;
            }
            const direction = offset < 0 ? 1 : -1;
            const destIndex = this.currentIndex + direction;
            const hasDestination = destIndex >= 0 && destIndex < this.gallery.length;
            if (!hasDestination)
                return; // At edge (bounce) — don't fade
            const slideWidth = window.innerWidth + SLIDE_GAP;
            const progress = Math.min(1, Math.abs(offset) / slideWidth);
            const fadeOpacity = Math.abs(1 - progress * 2);
            // Swap text and snap bar position at midpoint (opacity is zero — jump is invisible)
            if (progress > 0.5 && !this.chromeFadeSwapped) {
                this.chromeFadeSwapped = true;
                const item = this.gallery[destIndex];
                if (this.chromeCounter) {
                    this.chromeCounter.textContent = `${destIndex + 1}\u2009/\u2009${this.gallery.length}`;
                }
                if (this.chromeCaption) {
                    const cap = item?.caption || '';
                    this.chromeCaption.innerHTML = cap;
                    this.chromeCaption.style.display = cap ? '' : 'none';
                }
                // Snap bar to destination image position while opacity is zero
                const destImg = direction === 1 ? this.nextSlideImg : this.prevSlideImg;
                if (destImg) {
                    this.chromeBarFitRect = new DOMRect(
                        parseFloat(destImg.style.left) || 0,
                        parseFloat(destImg.style.top) || 0,
                        parseFloat(destImg.style.width) || 0,
                        parseFloat(destImg.style.height) || 0
                    );
                    this.updateChromeVisuals();
                }
            }
            else if (progress <= 0.5 && this.chromeFadeSwapped) {
                this.chromeFadeSwapped = false;
                const item = this.gallery[this.currentIndex];
                if (this.chromeCounter) {
                    this.chromeCounter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
                }
                if (this.chromeCaption) {
                    const cap = item?.caption || '';
                    this.chromeCaption.innerHTML = cap;
                    this.chromeCaption.style.display = cap ? '' : 'none';
                }
                // Revert bar to current image position if user swipes back past midpoint
                this.chromeBarFitRect = null;
                this.updateChromeVisuals();
            }
            if (this.chromeCaption)
                this.chromeCaption.style.opacity = String(fadeOpacity);
            if (this.chromeCounter)
                this.chromeCounter.style.opacity = String(fadeOpacity);
            if (this.chromeClose)
                this.chromeClose.style.opacity = String(fadeOpacity);
        }
        /**
         * Cross-fade slide images during strip animation.
         * First half of travel: exiting image fades from 1 → 0.
         * Second half: incoming image fades from 0 → 1.
         * The exiting image stays invisible once it has faded out.
         */
        updateSlideImageFade(offset) {
            if (offset === 0) {
                // Reset all slide image opacities to let the rest of the system control them
                if (this.imgEl)
                    this.imgEl.style.opacity = '';
                if (this.nextSlideImg)
                    this.nextSlideImg.style.opacity = '';
                if (this.prevSlideImg)
                    this.prevSlideImg.style.opacity = '';
                return;
            }
            const direction = offset < 0 ? 1 : -1;
            const destIndex = this.currentIndex + direction;
            const hasDestination = destIndex >= 0 && destIndex < this.gallery.length;
            if (!hasDestination)
                return; // Edge bounce — don't fade
            const slideWidth = window.innerWidth + SLIDE_GAP;
            const progress = Math.min(1, Math.abs(offset) / slideWidth);
            // How far into the strip travel (0–1) the exit/enter fades complete.
            // Lower FADE_OUT_END → exiting image disappears faster.
            // FADE_IN_START can stay at 0.5 so the new image appears at midpoint.
            const FADE_OUT_END = 0.25;
            const FADE_IN_START = 0.05;
            // Exiting image: 1 → 0 over [0, FADE_OUT_END], then stays invisible
            const exitOpacity = Math.max(0, 1 - progress / FADE_OUT_END);
            // Incoming image: 0 → 1 over [FADE_IN_START, 1]
            const enterOpacity = Math.max(0, (progress - FADE_IN_START) / (1 - FADE_IN_START));
            const destImg = direction === 1 ? this.nextSlideImg : this.prevSlideImg;
            if (this.imgEl)
                this.imgEl.style.opacity = String(exitOpacity);
            if (destImg)
                destImg.style.opacity = String(enterOpacity);
        }
        /**
         * Rubber-band bounce at gallery edges. Kicks the strip with velocity in the
         * attempted direction — the spring overshoots then settles back to 0,
         * hinting that there are no more images that way.
         * direction: 1 = shift right (at first image), -1 = shift left (at last).
         */
        bounceStrip(direction) {
            this.debugLog(`bounceStrip(${direction > 0 ? 'right' : 'left'})`);
            const BOUNCE_VELOCITY = 1200;
            const BOUNCE_SPRING = { stiffness: 400, damping: 24, mass: 1 };
            this.animateStrip(0, 0, BOUNCE_SPRING, direction * BOUNCE_VELOCITY, () => {
                this.stripOffset = 0;
            });
        }
        /**
         * If a strip animation is in progress, stop it and resolve immediately.
         * Navigation animations are completed (index updated, slots recycled).
         * Bounce animations are just cancelled (strip reset to 0).
         */
        forceCompleteStripAnimation() {
            if (this.stripRafId === null)
                return;
            this.stopStripSpring();
            if (this.pendingNavDirection !== null) {
                this.completeNavigation(this.pendingNavDirection);
            }
            else {
                // Bounce or other non-navigation animation — just reset
                this.stripOffset = 0;
                this.applyStripOffset(0);
            }
        }
        // ─── Zoom ────────────────────────────────────────────────────
        isZoomable() {
            const { fitRect, naturalWidth, naturalHeight } = this.zoom;
            return naturalWidth > fitRect.width * 1.05 || naturalHeight > fitRect.height * 1.05;
        }
        getTapZoomScale() {
            const { fitRect, naturalWidth } = this.zoom;
            const nativeScale = naturalWidth / fitRect.width;
            // 3× fit ensures a perceptible jump; cap at native so we never upscale
            return Math.min(Math.max(nativeScale, 2), 3);
        }
        getMaxZoomScale() {
            const { fitRect, naturalWidth } = this.zoom;
            const nativeScale = naturalWidth / fitRect.width;
            return Math.max(nativeScale, 2);
        }
        zoomIn(clickX, clickY) {
            if (this.state.isClosing)
                return;
            if (!this.imgEl || !this.isZoomable())
                return;
            this.debugLog('zoomIn');
            this.emit('zoomIn');
            this.stopSpring();
            this.state.isAnimating = true;
            this.animateChrome(1);
            const { fitRect } = this.zoom;
            const targetScale = this.getTapZoomScale();
            const imgCenterX = fitRect.x + fitRect.width / 2;
            const imgCenterY = fitRect.y + fitRect.height / 2;
            const relX = clickX - imgCenterX;
            const relY = clickY - imgCenterY;
            let panX = -(relX * targetScale - relX);
            let panY = -(relY * targetScale - relY);
            const bounds = this.computePanBounds(targetScale);
            panX = clamp(panX, bounds.minX, bounds.maxX);
            panY = clamp(panY, bounds.minY, bounds.maxY);
            if (this.reducedMotion) {
                this.zoom.panX = panX;
                this.zoom.panY = panY;
                this.zoom.scale = targetScale;
                this.zoom.zoomed = true;
                this.applyPanTransform();
                this.state.isAnimating = false;
                this.updateCursorState();
                return;
            }
            const fromPanX = this.zoom.panX;
            const fromPanY = this.zoom.panY;
            const fromScale = this.zoom.scale;
            // Spring from current → target zoom state
            let sX = { position: fromPanX, velocity: 0 };
            let sY = { position: fromPanY, velocity: 0 };
            let sScale = { position: fromScale, velocity: 0 };
            const config = this.opts.springOpen;
            let lastTime = performance.now();
            let madeInteractive = false;
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const rX = springStep(config, sX, panX, dt);
                const rY = springStep(config, sY, panY, dt);
                const rS = springStep(config, sScale, targetScale, dt);
                sX = rX;
                sY = rY;
                sScale = rS;
                this.zoom.panX = rX.position;
                this.zoom.panY = rY.position;
                this.zoom.scale = rS.position;
                this.applyPanTransform();
                // Make interactive as soon as visually zoomed — don't wait for spring tail
                if (!madeInteractive && rS.position > 1) {
                    madeInteractive = true;
                    this.zoom.zoomed = true;
                    this.state.isAnimating = false;
                    this.updateCursorState();
                }
                if (rX.settled && rY.settled && rS.settled) {
                    this.zoom.panX = panX;
                    this.zoom.panY = panY;
                    this.zoom.scale = targetScale;
                    this.applyPanTransform();
                    this.rafId = null;
                    if (!madeInteractive) {
                        this.zoom.zoomed = true;
                        this.state.isAnimating = false;
                        this.updateCursorState();
                    }
                    return;
                }
                this.rafId = requestAnimationFrame(tick);
            };
            this.rafId = requestAnimationFrame(tick);
        }
        zoomOut() {
            if (this.state.isClosing)
                return;
            if (!this.imgEl)
                return;
            this.debugLog('zoomOut');
            this.emit('zoomOut');
            this.stopSpring();
            this.state.isAnimating = true;
            this.zoom.zoomingOut = true;
            this.animateChrome(0);
            if (this.reducedMotion) {
                this.zoom.panX = 0;
                this.zoom.panY = 0;
                this.zoom.scale = 1;
                this.zoom.zoomed = false;
                this.zoom.zoomingOut = false;
                this.applyPanTransform();
                this.state.isAnimating = false;
                this.updateCursorState();
                return;
            }
            const fromPanX = this.zoom.panX;
            const fromPanY = this.zoom.panY;
            const fromScale = this.zoom.scale;
            let sX = { position: fromPanX, velocity: 0 };
            let sY = { position: fromPanY, velocity: 0 };
            let sScale = { position: fromScale, velocity: 0 };
            const config = this.opts.springClose;
            let lastTime = performance.now();
            let madeInteractive = false;
            const VISUAL_THRESHOLD = 0.005;
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const rX = springStep(config, sX, 0, dt);
                const rY = springStep(config, sY, 0, dt);
                const rS = springStep(config, sScale, 1, dt);
                sX = rX;
                sY = rY;
                sScale = rS;
                this.zoom.panX = rX.position;
                this.zoom.panY = rY.position;
                this.zoom.scale = rS.position;
                this.applyPanTransform();
                // Update state as soon as visually settled — don't wait for spring tail
                if (!madeInteractive &&
                    Math.abs(rS.position - 1) < VISUAL_THRESHOLD &&
                    Math.abs(rX.position) < 1 &&
                    Math.abs(rY.position) < 1) {
                    madeInteractive = true;
                    this.zoom.zoomed = false;
                    this.zoom.zoomingOut = false;
                    this.state.isAnimating = false;
                    this.updateCursorState();
                }
                if (rX.settled && rY.settled && rS.settled) {
                    this.zoom.panX = 0;
                    this.zoom.panY = 0;
                    this.zoom.scale = 1;
                    this.applyPanTransform();
                    this.rafId = null;
                    if (!madeInteractive) {
                        this.zoom.zoomed = false;
                        this.zoom.zoomingOut = false;
                        this.state.isAnimating = false;
                        this.updateCursorState();
                    }
                    return;
                }
                this.rafId = requestAnimationFrame(tick);
            };
            this.rafId = requestAnimationFrame(tick);
        }
        // ─── Pan: drag + momentum via rAF spring ────────────────────
        handleImagePointerDown(e) {
            e.preventDefault();
            // Exit fade in progress: don't start any gesture that could cancel it
            if (this.state.isClosing)
                return;
            // Add to pointer cache
            this.pointerCache.push(e);
            e.target.setPointerCapture(e.pointerId);
            // Second finger down — start pinch
            if (this.pointerCache.length === 2) {
                this.startPinch();
                return;
            }
            // Single pointer at fit scale — track for potential swipe-to-dismiss or swipe-to-navigate.
            // Block during open animation (isAnimating=true) — the image is mid-FLIP
            // and freezing it would leave a partial-open state. Snap-back doesn't set
            // isAnimating, so it stays interruptible.
            // Use !zoomed rather than scale<=1: during zoom-out spring tail, scale may
            // linger slightly above 1 after madeInteractive has already cleared zoomed.
            // Also catch mid-zoomOut: if the user touches down while zoom-out is animating,
            // snap to fit scale and start dismiss tracking instead of entering pan mode.
            const atFitScale = !this.zoom.zoomed || this.zoom.zoomingOut;
            const blockedByAnimation = this.state.isAnimating && !this.zoom.zoomingOut;
            if (atFitScale && !blockedByAnimation) {
                // Resolve any in-progress strip animation
                this.resolveStripAnimation();
                // Cancel any in-progress animation (e.g. snap-back, zoom-out spring)
                this.stopSpring();
                // Snap to fit scale so the image is exactly at rest
                this.zoom.scale = 1;
                this.zoom.panX = 0;
                this.zoom.panY = 0;
                this.zoom.zoomed = false;
                this.zoom.zoomingOut = false;
                this.applyPanTransform();
                this.state.isAnimating = false;
                this.dismiss.tracking = true;
                this.dismiss.startX = e.clientX;
                this.dismiss.startY = e.clientY;
                this.velocitySamples = [];
                this.addVelocitySample(e.clientX, e.clientY);
                return;
            }
            // Interrupt any in-progress zoom-in animation — user is grabbing it
            this.stopSpring();
            this.zoom.zoomed = true;
            this.state.isAnimating = false;
            this.zoom.isDragging = true;
            this.zoom.dragMoved = false;
            this.zoom.dragStartX = e.clientX;
            this.zoom.dragStartY = e.clientY;
            this.zoom.dragStartPanX = this.zoom.panX;
            this.zoom.dragStartPanY = this.zoom.panY;
            this.velocitySamples = [];
            this.addVelocitySample(e.clientX, e.clientY);
            this.updateCursorState();
        }
        handleOverlayPointerDown(e) {
            if (this.state.isClosing)
                return;
            // Only handle pointers that land outside the image (backdrop area)
            if (e.target === this.imgEl)
                return;
            // Don't intercept clicks on chrome UI (caption links, buttons, etc.)
            if (this.chromeBar && this.chromeBar.contains(e.target))
                return;
            // Close button lives outside chromeBar (appended directly to overlay),
            // so guard it explicitly to prevent the backdrop handler swallowing its events.
            if (this.chromeClose && (e.target === this.chromeClose || this.chromeClose.contains(e.target)))
                return;
            // Only for dismiss at fit scale, not during open animation.
            // Allow during zoom-out: snap to fit and start dismiss tracking.
            const atFitScale = !this.zoom.zoomed || this.zoom.zoomingOut;
            const blockedByAnimation = this.state.isAnimating && !this.zoom.zoomingOut;
            if (!atFitScale || blockedByAnimation)
                return;
            e.preventDefault();
            // Capture on the overlay so move/up events are delivered here
            this.overlay.setPointerCapture(e.pointerId);
            // Resolve any in-progress strip animation
            this.resolveStripAnimation();
            this.stopSpring();
            // Snap to fit scale in case we interrupted a zoom-out spring
            if (this.zoom.zoomingOut) {
                this.zoom.scale = 1;
                this.zoom.panX = 0;
                this.zoom.panY = 0;
                this.zoom.zoomed = false;
                this.zoom.zoomingOut = false;
                this.applyPanTransform();
            }
            this.state.isAnimating = false;
            this.dismiss.tracking = true;
            this.dismiss.fromOverlay = true;
            this.dismiss.startX = e.clientX;
            this.dismiss.startY = e.clientY;
            this.velocitySamples = [];
            this.addVelocitySample(e.clientX, e.clientY);
        }
        handlePointerMove(e) {
            if (!this.imgEl)
                return;
            // Update pointer in cache
            const idx = this.pointerCache.findIndex((p) => p.pointerId === e.pointerId);
            if (idx >= 0)
                this.pointerCache[idx] = e;
            // Pinch active — handle two-finger zoom+pan
            if (this.pinch.active && this.pointerCache.length === 2) {
                this.updatePinch();
                return;
            }
            // Swipe-to-navigate (horizontal drag at scale=1)
            if (this.swipeNav.active) {
                this.handleSwipeNavMove(e);
                return;
            }
            // Swipe-to-dismiss tracking / active drag
            if (this.dismiss.tracking || this.dismiss.active) {
                this.handleDismissMove(e);
                return;
            }
            // Single-finger drag (zoomed pan)
            if (!this.zoom.isDragging)
                return;
            const dx = e.clientX - this.zoom.dragStartX;
            const dy = e.clientY - this.zoom.dragStartY;
            if (!this.zoom.dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                this.zoom.dragMoved = true;
            }
            this.addVelocitySample(e.clientX, e.clientY);
            let newPanX = this.zoom.dragStartPanX + dx;
            let newPanY = this.zoom.dragStartPanY + dy;
            const bounds = this.computePanBounds(this.zoom.scale);
            newPanX = rubberBand(newPanX, bounds.minX, bounds.maxX);
            newPanY = rubberBand(newPanY, bounds.minY, bounds.maxY);
            this.zoom.panX = newPanX;
            this.zoom.panY = newPanY;
            this.applyPanTransform();
        }
        handlePointerUp(e) {
            // Remove from pointer cache
            this.pointerCache = this.pointerCache.filter((p) => p.pointerId !== e.pointerId);
            try {
                e.target.releasePointerCapture(e.pointerId);
            }
            catch {
                // Pointer capture may already be released
            }
            // Pinch ended — settle with spring
            if (this.pinch.active) {
                if (this.pointerCache.length < 2) {
                    this.endPinch();
                }
                return;
            }
            // Swipe-to-navigate release
            if (this.swipeNav.active) {
                this.handleSwipeNavRelease();
                return;
            }
            // Swipe-to-dismiss release
            if (this.dismiss.tracking || this.dismiss.active) {
                this.handleDismissRelease();
                return;
            }
            // Single-finger drag end (zoomed pan)
            if (!this.zoom.isDragging)
                return;
            const wasDrag = this.zoom.dragMoved;
            this.zoom.isDragging = false;
            // Don't clear dragMoved here — handleImageClick needs it to suppress the click
            this.updateCursorState();
            if (!wasDrag) {
                this.zoomOut();
                // Mark dragMoved so the subsequent click event is suppressed —
                // without this, handleImageClick also calls zoomOut() on the same tap.
                this.zoom.dragMoved = true;
                return;
            }
            const velocity = this.computeVelocity();
            this.startPanMomentum(velocity.vx, velocity.vy);
        }
        // ─── Velocity tracking ──────────────────────────────────────
        addVelocitySample(x, y) {
            const now = performance.now();
            this.velocitySamples.push({ x, y, t: now });
            const cutoff = now - VELOCITY_WINDOW;
            while (this.velocitySamples.length > 1 && this.velocitySamples[0].t < cutoff) {
                this.velocitySamples.shift();
            }
        }
        computeVelocity() {
            const samples = this.velocitySamples;
            if (samples.length < 2)
                return { vx: 0, vy: 0 };
            const oldest = samples[0];
            const newest = samples[samples.length - 1];
            const dt = (newest.t - oldest.t) / 1000;
            if (dt < 0.001)
                return { vx: 0, vy: 0 };
            return {
                vx: (newest.x - oldest.x) / dt,
                vy: (newest.y - oldest.y) / dt,
            };
        }
        // ─── Swipe-to-dismiss ──────────────────────────────────────
        handleDismissMove(e) {
            const dx = e.clientX - this.dismiss.startX;
            const dy = e.clientY - this.dismiss.startY;
            if (!this.dismiss.active) {
                // Still tracking — determine axis once past threshold.
                // Use a larger threshold than DRAG_THRESHOLD so the angle has enough
                // signal to commit reliably, especially on mobile.
                if (Math.hypot(dx, dy) < AXIS_LOCK_THRESHOLD)
                    return;
                if (Math.abs(dy) > Math.abs(dx) * 1.5) {
                    // Vertical wins — activate dismiss
                    this.dismiss.active = true;
                    this.dismiss.tracking = false;
                    this.zoom.dragMoved = true; // Suppress the click that follows pointerup
                    // Snap strip back if it was at a non-zero offset from an interrupted animation
                    if (this.stripOffset !== 0) {
                        this.stripOffset = 0;
                        this.applyStripOffset(0);
                    }
                }
                else {
                    // Horizontal — start swipe-to-navigate if in a gallery
                    if (this.gallery.length > 1) {
                        const startX = this.dismiss.startX;
                        this.dismiss = this.defaultDismissState();
                        this.zoom.dragMoved = true; // Suppress the click
                        this.startSwipeNav(startX, e.clientX);
                    }
                    else {
                        this.dismiss = this.defaultDismissState();
                    }
                    return;
                }
            }
            this.addVelocitySample(e.clientX, e.clientY);
            // Unconstrained movement once dismiss is active
            this.dismiss.offsetX = dx;
            this.dismiss.offsetY = dy;
            // Scale and opacity driven by distance from center
            const vh = window.innerHeight;
            const dist = Math.hypot(dx, dy);
            const progress = dist / vh;
            this.dismiss.scale = Math.max(0.7, 1 - progress * 0.3);
            this.dismiss.opacity = Math.max(0, 1 - progress / 0.4);
            this.applyDismissTransform();
        }
        applyDismissTransform() {
            if (!this.imgEl || !this.backdrop)
                return;
            const { offsetX, offsetY, scale } = this.dismiss;
            this.imgEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
            this.backdrop.style.opacity = String(this.dismiss.opacity);
            this.chromeBaseOpacity = this.dismiss.opacity;
            this.updateChromeVisuals();
        }
        handleDismissRelease() {
            if (!this.dismiss.active) {
                // Was just tracking, never activated.
                // Overlay-initiated: pointer capture suppresses the backdrop click, so close here.
                // Image-initiated: let the click handler deal with it.
                const fromOverlay = this.dismiss.fromOverlay;
                this.dismiss = this.defaultDismissState();
                if (fromOverlay)
                    this.close();
                return;
            }
            const { vx, vy } = this.computeVelocity();
            // iOS-style: dismiss is the default once the gesture activates.
            // Snap back only if the user deliberately returned the image to center.
            const dist = Math.hypot(this.dismiss.offsetX, this.dismiss.offsetY);
            const speed = Math.hypot(vx, vy);
            if (dist < 5 && speed < 50) {
                this.dismissSnapBack(vx, vy);
            }
            else {
                this.dismissClose(vx, vy);
            }
        }
        dismissClose(velocityX, velocityY) {
            this.debugLog('dismissClose');
            this.state.isClosing = true;
            this.state.isDismissClosing = true;
            this.isOpening = false;
            this.cancelFullResFade();
            this.emit('close');
            this.state.isAnimating = true;
            this.stopFitTransition();
            if (this.overlay) {
                const ov = this.overlay;
                setTimeout(() => this.makeOverlayInert(ov), 80);
            }
            const { offsetX, offsetY, scale, opacity } = this.dismiss;
            this.dismiss = this.defaultDismissState();
            const currentBR = this.getTargetBorderRadius();
            // Fade out from where the gesture was released, carrying its momentum.
            this.animateSpring({ translateX: offsetX, translateY: offsetY, scale, opacity, crop: 0, borderRadius: currentBR }, { translateX: offsetX, translateY: offsetY, scale, opacity: 0, crop: 0, borderRadius: currentBR }, this.opts.fadeClose, () => this.finishClose(), (s) => s.opacity < 0.01, { translateX: velocityX, translateY: velocityY });
        }
        dismissSnapBack(velocityX, velocityY) {
            const { offsetX, offsetY, scale, opacity } = this.dismiss;
            this.dismiss = this.defaultDismissState();
            // Don't set isAnimating — snap-back is visual recovery, not a state
            // transition. This keeps it interruptible by a new dismiss gesture
            // (the user can grab the image mid-snap-back) while isAnimating=true
            // during the open animation correctly blocks dismiss tracking.
            const targetBR = this.getTargetBorderRadius();
            this.animateSpring({ translateX: offsetX, translateY: offsetY, scale, opacity, crop: 0, borderRadius: targetBR }, { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR }, SNAP_SPRING, () => { }, undefined, { translateX: velocityX, translateY: velocityY });
        }
        // ─── Scroll lock ────────────────────────────────────────────
        lockBodyScroll() {
            const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
            this.savedBodyOverflow = document.body.style.overflow;
            this.savedHtmlPaddingRight = document.documentElement.style.paddingRight;
            document.body.style.overflow = 'hidden';
            if (scrollbarWidth > 0) {
                document.documentElement.style.paddingRight = `${scrollbarWidth}px`;
            }
        }
        unlockBodyScroll() {
            document.body.style.overflow = this.savedBodyOverflow;
            document.documentElement.style.paddingRight = this.savedHtmlPaddingRight;
        }
        // ─── Wheel handling ────────────────────────────────────────
        handleWheel(e) {
            e.preventDefault();
            if (this.state.isClosing || !this.state.isOpen)
                return;
            // Ignore during active pointer gestures
            if (this.dismiss.active || this.dismiss.tracking)
                return;
            if (this.swipeNav.active)
                return;
            if (this.zoom.isDragging)
                return;
            // Gesture-end detection: fires when wheel events stop.
            // Resets all wheel accumulator state.
            if (this.wheelGestureTimer !== null)
                clearTimeout(this.wheelGestureTimer);
            this.wheelGestureTimer = setTimeout(() => {
                this.debugLog('gesture timer → reset wheel state');
                this.wheelGestureTimer = null;
                this.wheelDismissY = 0;
                this.wheelNavCommitted = false;
                this.wheelNavTotalDelta = 0;
            }, 80);
            this.handleScroll(e);
        }
        handleScroll(e) {
            // Normalize line-based deltas (mouse wheels) to pixels
            const lineScale = e.deltaMode === 1 ? 16 : 1;
            const deltaX = e.deltaX * lineScale;
            const deltaY = e.deltaY * lineScale;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            if (this.zoom.zoomed || this.zoom.scale !== 1) {
                // Zoomed: scroll pans
                this.wheelPan(deltaX, deltaY);
                return;
            }
            // At fit scale: determine primary axis
            if (absX > absY && this.gallery.length > 1) {
                // Horizontal dominant — navigate gallery
                this.wheelNavigate(deltaX);
            }
            else if (absY > 0) {
                // Vertical dominant — dismiss
                this.wheelDismiss(deltaY);
            }
        }
        wheelPan(deltaX, deltaY) {
            this.stopSpring();
            const bounds = this.computePanBounds(this.zoom.scale);
            this.zoom.panX -= deltaX;
            this.zoom.panY -= deltaY;
            // Rubber-band outside bounds
            if (this.zoom.panX < bounds.minX) {
                const over = bounds.minX - this.zoom.panX;
                this.zoom.panX = bounds.minX - over * RUBBER_BAND_FACTOR;
            }
            else if (this.zoom.panX > bounds.maxX) {
                const over = this.zoom.panX - bounds.maxX;
                this.zoom.panX = bounds.maxX + over * RUBBER_BAND_FACTOR;
            }
            if (this.zoom.panY < bounds.minY) {
                const over = bounds.minY - this.zoom.panY;
                this.zoom.panY = bounds.minY - over * RUBBER_BAND_FACTOR;
            }
            else if (this.zoom.panY > bounds.maxY) {
                const over = this.zoom.panY - bounds.maxY;
                this.zoom.panY = bounds.maxY + over * RUBBER_BAND_FACTOR;
            }
            this.applyPanTransform();
            // Snap back to bounds after a pause (wheel events come in bursts)
            this.scheduleWheelSnapBack();
        }
        scheduleWheelSnapBack() {
            if (this.wheelSnapBackTimer !== null)
                clearTimeout(this.wheelSnapBackTimer);
            this.wheelSnapBackTimer = setTimeout(() => {
                this.wheelSnapBackTimer = null;
                if (this.state.isClosing || !this.state.isOpen)
                    return;
                if (!this.zoom.zoomed && this.zoom.scale === 1)
                    return;
                const bounds = this.computePanBounds(this.zoom.scale);
                const needsSnap = this.zoom.panX < bounds.minX ||
                    this.zoom.panX > bounds.maxX ||
                    this.zoom.panY < bounds.minY ||
                    this.zoom.panY > bounds.maxY;
                if (needsSnap) {
                    this.startPanMomentum(0, 0);
                }
            }, 100);
        }
        wheelNavigate(deltaX) {
            if (this.wheelNavCommitted)
                return;
            this.wheelNavTotalDelta += deltaX;
            if (Math.abs(this.wheelNavTotalDelta) > WHEEL_NAV_THRESHOLD) {
                this.wheelNavCommitted = true;
                const dir = this.wheelNavTotalDelta > 0 ? 'next' : 'prev';
                this.debugLog(`wheelNav commit → ${dir}`);
                if (this.wheelNavTotalDelta > 0) {
                    this.next();
                }
                else {
                    this.prev();
                }
            }
        }
        wheelDismiss(deltaY) {
            this.wheelDismissY += Math.abs(deltaY);
            if (this.wheelDismissY > WHEEL_DISMISS_THRESHOLD) {
                this.wheelDismissY = 0;
                this.dismissClose(0, WHEEL_DISMISS_VELOCITY);
            }
        }
        // ─── Swipe-to-navigate ──────────────────────────────────────
        startSwipeNav(startX, currentX) {
            const initialOffset = this.stripOffset;
            this.swipeNav = {
                active: true,
                startX,
                offsetX: initialOffset + (currentX - startX),
                initialOffset,
            };
            this.applyStripOffset(this.swipeNav.offsetX);
            this.stripOffset = this.swipeNav.offsetX;
        }
        handleSwipeNavMove(e) {
            const dx = e.clientX - this.swipeNav.startX;
            let offset = this.swipeNav.initialOffset + dx;
            // Rubber-band at gallery edges
            const atStart = this.currentIndex === 0;
            const atEnd = this.currentIndex === this.gallery.length - 1;
            if (atStart && offset > 0) {
                offset = offset * RUBBER_BAND_FACTOR;
            }
            if (atEnd && offset < 0) {
                offset = offset * RUBBER_BAND_FACTOR;
            }
            this.swipeNav.offsetX = offset;
            this.stripOffset = offset;
            this.addVelocitySample(e.clientX, e.clientY);
            this.applyStripOffset(offset);
        }
        handleSwipeNavRelease() {
            const { vx } = this.computeVelocity();
            const offset = this.swipeNav.offsetX;
            // Reset swipe nav state immediately — spring animation is just visual follow-through
            this.swipeNav = this.defaultSwipeNavState();
            const slideWidth = window.innerWidth + SLIDE_GAP;
            const progress = Math.abs(offset) / slideWidth;
            let shouldNavigate = Math.abs(vx) > SWIPE_VELOCITY_THRESHOLD || progress > SWIPE_DISTANCE_THRESHOLD;
            const direction = (offset < 0 ? 1 : -1);
            // Don't navigate past edges
            if (direction === 1 && this.currentIndex >= this.gallery.length - 1)
                shouldNavigate = false;
            if (direction === -1 && this.currentIndex <= 0)
                shouldNavigate = false;
            if (shouldNavigate) {
                this.completeSwipeNav(direction, vx);
            }
            else {
                this.snapBackSwipeNav(vx);
            }
        }
        completeSwipeNav(direction, velocity) {
            this.pendingNavDirection = direction;
            const destSlide = direction === 1 ? this.nextSlideEl : this.prevSlideEl;
            if (destSlide)
                destSlide.style.pointerEvents = 'auto';
            const slideWidth = window.innerWidth + SLIDE_GAP;
            const targetX = -direction * slideWidth;
            this.animateStrip(this.stripOffset, targetX, this.opts.springOpen, velocity, () => this.completeNavigation(direction));
        }
        snapBackSwipeNav(velocity) {
            this.animateStrip(this.stripOffset, 0, SNAP_SPRING, velocity, () => {
                this.stripOffset = 0;
            });
        }
        // ─── Pinch-to-zoom ─────────────────────────────────────────
        startPinch() {
            // Cancel any in-progress animation or dismiss gesture
            this.stopSpring();
            this.state.isAnimating = false;
            this.zoom.isDragging = false;
            this.dismiss = this.defaultDismissState();
            const [p1, p2] = this.pointerCache;
            const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
            const midX = (p1.clientX + p2.clientX) / 2;
            const midY = (p1.clientY + p2.clientY) / 2;
            this.pinch = {
                active: true,
                initialDistance: dist,
                initialScale: this.zoom.scale,
                initialPanX: this.zoom.panX,
                initialPanY: this.zoom.panY,
                initialMidX: midX,
                initialMidY: midY,
                prevScale: this.zoom.scale,
                prevScaleTime: performance.now(),
            };
        }
        updatePinch() {
            const [p1, p2] = this.pointerCache;
            const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
            const midX = (p1.clientX + p2.clientX) / 2;
            const midY = (p1.clientY + p2.clientY) / 2;
            const ratio = dist / this.pinch.initialDistance;
            const maxScale = this.getMaxZoomScale();
            let newScale = this.pinch.initialScale * ratio;
            // Rubber-band past min/max
            if (newScale < 1) {
                // Lighter rubber band below 1 so pinch-to-close feels responsive
                newScale = 1 - (1 - newScale) * PINCH_DISMISS_RUBBER_BAND_FACTOR;
            }
            else if (newScale > maxScale) {
                newScale = maxScale + (newScale - maxScale) * PINCH_RUBBER_BAND_FACTOR;
            }
            // Track scale velocity for commit/snap-back decision on release
            const now = performance.now();
            this.pinch.prevScale = this.zoom.scale;
            this.pinch.prevScaleTime = now;
            // Focal-point correction: keep the midpoint pinned to the same content
            const { fitRect } = this.zoom;
            const imgCenterX = fitRect.x + fitRect.width / 2;
            const imgCenterY = fitRect.y + fitRect.height / 2;
            // Vector from image center to initial midpoint in screen space
            const relX = this.pinch.initialMidX - imgCenterX;
            const relY = this.pinch.initialMidY - imgCenterY;
            // Pan offset so that content under the initial midpoint stays under the current midpoint
            const scaleRatio = newScale / this.pinch.initialScale;
            const panX = this.pinch.initialPanX +
                (midX - this.pinch.initialMidX) -
                (relX - this.pinch.initialPanX) * (scaleRatio - 1);
            const panY = this.pinch.initialPanY +
                (midY - this.pinch.initialMidY) -
                (relY - this.pinch.initialPanY) * (scaleRatio - 1);
            this.zoom.scale = newScale;
            this.zoom.panX = panX;
            this.zoom.panY = panY;
            this.applyPanTransform();
            // Below fit scale: fade backdrop and chrome proportionally (pinch-to-close)
            if (newScale < 1) {
                const dismissProgress = 1 - newScale;
                const opacity = Math.max(0, 1 - dismissProgress / 0.35);
                this.backdrop.style.opacity = String(opacity);
                this.chromeBaseOpacity = opacity;
                this.chromeSpring = { position: 0, velocity: 0 };
                this.updateChromeVisuals();
            }
            else {
                // Fade chrome proportionally to zoom level
                const chromeProgress = Math.min(1, Math.max(0, (newScale - 1) / 0.5));
                this.chromeSpring = { position: chromeProgress, velocity: 0 };
                this.updateChromeVisuals();
            }
        }
        endPinch() {
            this.pinch.active = false;
            this.zoom.dragMoved = true; // Suppress the click that follows
            const maxScale = this.getMaxZoomScale();
            if (this.zoom.scale < 1) {
                // Compute scale velocity from last frame
                const dt = (performance.now() - this.pinch.prevScaleTime) / 1000;
                const scaleVelocity = dt > 0.001 ? (this.zoom.scale - this.pinch.prevScale) / dt : 0;
                if (this.zoom.scale < PINCH_CLOSE_SCALE || scaleVelocity < PINCH_CLOSE_VELOCITY) {
                    // Commit to close — bridge into dismiss path
                    this.pinchClose();
                }
                else {
                    // Snap back to fit scale and restore backdrop/chrome
                    this.pinchSnapBack();
                }
            }
            else if (this.zoom.scale > maxScale) {
                // Clamp to max scale, keep pan clamped
                const bounds = this.computePanBounds(maxScale);
                const panX = clamp(this.zoom.panX, bounds.minX, bounds.maxX);
                const panY = clamp(this.zoom.panY, bounds.minY, bounds.maxY);
                this.springToZoomState(maxScale, panX, panY, SNAP_SPRING, true);
                this.animateChrome(1);
            }
            else {
                // Valid zoom — clamp pan to bounds and settle
                this.zoom.zoomed = this.zoom.scale > 1;
                this.animateChrome(this.zoom.scale > 1 ? 1 : 0);
                const bounds = this.computePanBounds(this.zoom.scale);
                const inBoundsX = this.zoom.panX >= bounds.minX && this.zoom.panX <= bounds.maxX;
                const inBoundsY = this.zoom.panY >= bounds.minY && this.zoom.panY <= bounds.maxY;
                if (!inBoundsX || !inBoundsY) {
                    const panX = clamp(this.zoom.panX, bounds.minX, bounds.maxX);
                    const panY = clamp(this.zoom.panY, bounds.minY, bounds.maxY);
                    this.springToZoomState(this.zoom.scale, panX, panY, SNAP_SPRING, this.zoom.scale > 1);
                }
                else {
                    this.updateCursorState();
                }
            }
            // Don't auto-transition to single-finger drag — the second finger
            // lifting off produces noisy velocity that triggers unwanted momentum.
            // User can lift and re-place a finger to pan intentionally.
        }
        pinchClose() {
            this.debugLog('pinchClose');
            this.state.isClosing = true;
            this.state.isDismissClosing = true;
            this.isOpening = false;
            this.cancelFullResFade();
            this.emit('close');
            this.state.isAnimating = true;
            this.stopFitTransition();
            // Stop any strip animation and reset
            this.stopStripSpring();
            this.stripOffset = 0;
            if (this.stripEl)
                this.stripEl.style.transform = '';
            this.swipeNav = this.defaultSwipeNavState();
            if (this.overlay) {
                const ov = this.overlay;
                setTimeout(() => this.makeOverlayInert(ov), 80);
            }
            // Current pinch state becomes the starting point for the close animation.
            // panX/panY are in the same coordinate space as dismiss translateX/Y.
            const { panX, panY, scale } = this.zoom;
            const dismissProgress = 1 - scale;
            const opacity = Math.max(0, 1 - dismissProgress / 0.35);
            // Reset zoom state — animation system takes over via animateSpring
            this.zoom.scale = 1;
            this.zoom.panX = 0;
            this.zoom.panY = 0;
            this.zoom.zoomed = false;
            const currentBR = this.getTargetBorderRadius();
            // Fade out from the current pinch position
            this.animateSpring({ translateX: panX, translateY: panY, scale, opacity, crop: 0, borderRadius: currentBR }, { translateX: panX, translateY: panY, scale, opacity: 0, crop: 0, borderRadius: currentBR }, this.opts.fadeClose, () => this.finishClose(), (s) => s.opacity < 0.01);
        }
        pinchSnapBack() {
            const { panX, panY, scale } = this.zoom;
            const dismissProgress = 1 - scale;
            const opacity = Math.max(0, 1 - dismissProgress / 0.35);
            // Reset zoom to fit — the spring animates the visual recovery
            this.zoom.scale = 1;
            this.zoom.panX = 0;
            this.zoom.panY = 0;
            this.zoom.zoomed = false;
            // Animate snap-back: image returns to center, backdrop restores.
            // Don't set isAnimating so snap-back stays interruptible.
            const targetBR = this.getTargetBorderRadius();
            this.animateSpring({ translateX: panX, translateY: panY, scale, opacity, crop: 0, borderRadius: targetBR }, { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR }, SNAP_SPRING, () => { });
        }
        springToZoomState(targetScale, targetPanX, targetPanY, config, zoomed) {
            this.stopSpring();
            this.state.isAnimating = true;
            if (this.reducedMotion) {
                this.zoom.panX = targetPanX;
                this.zoom.panY = targetPanY;
                this.zoom.scale = targetScale;
                this.zoom.zoomed = zoomed;
                this.applyPanTransform();
                this.state.isAnimating = false;
                this.updateCursorState();
                return;
            }
            let sX = { position: this.zoom.panX, velocity: 0 };
            let sY = { position: this.zoom.panY, velocity: 0 };
            let sScale = { position: this.zoom.scale, velocity: 0 };
            let lastTime = performance.now();
            let madeInteractive = false;
            const VISUAL_THRESHOLD = 0.005;
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const rX = springStep(config, sX, targetPanX, dt);
                const rY = springStep(config, sY, targetPanY, dt);
                const rS = springStep(config, sScale, targetScale, dt);
                sX = rX;
                sY = rY;
                sScale = rS;
                this.zoom.panX = rX.position;
                this.zoom.panY = rY.position;
                this.zoom.scale = rS.position;
                this.applyPanTransform();
                // Update state as soon as visually settled — don't wait for spring tail
                if (!madeInteractive &&
                    Math.abs(rS.position - targetScale) < VISUAL_THRESHOLD * targetScale &&
                    Math.abs(rX.position - targetPanX) < 1 &&
                    Math.abs(rY.position - targetPanY) < 1) {
                    madeInteractive = true;
                    this.zoom.zoomed = zoomed;
                    this.state.isAnimating = false;
                    this.updateCursorState();
                }
                if (rX.settled && rY.settled && rS.settled) {
                    this.zoom.panX = targetPanX;
                    this.zoom.panY = targetPanY;
                    this.zoom.scale = targetScale;
                    this.applyPanTransform();
                    this.rafId = null;
                    if (!madeInteractive) {
                        this.zoom.zoomed = zoomed;
                        this.state.isAnimating = false;
                        this.updateCursorState();
                    }
                    return;
                }
                this.rafId = requestAnimationFrame(tick);
            };
            this.rafId = requestAnimationFrame(tick);
        }
        // ─── Pan momentum (rAF spring) ─────────────────────────────
        startPanMomentum(vx, vy) {
            const bounds = this.computePanBounds(this.zoom.scale);
            const inBoundsX = this.zoom.panX >= bounds.minX && this.zoom.panX <= bounds.maxX;
            const inBoundsY = this.zoom.panY >= bounds.minY && this.zoom.panY <= bounds.maxY;
            const targetX = inBoundsX
                ? clamp(this.zoom.panX + vx * 0.15, bounds.minX, bounds.maxX)
                : clamp(this.zoom.panX, bounds.minX, bounds.maxX);
            const targetY = inBoundsY
                ? clamp(this.zoom.panY + vy * 0.15, bounds.minY, bounds.maxY)
                : clamp(this.zoom.panY, bounds.minY, bounds.maxY);
            if (this.reducedMotion) {
                this.zoom.panX = targetX;
                this.zoom.panY = targetY;
                this.applyPanTransform();
                return;
            }
            let sX = { position: this.zoom.panX, velocity: inBoundsX ? vx : 0 };
            let sY = { position: this.zoom.panY, velocity: inBoundsY ? vy : 0 };
            const configX = inBoundsX ? PAN_SPRING : SNAP_SPRING;
            const configY = inBoundsY ? PAN_SPRING : SNAP_SPRING;
            let lastTime = performance.now();
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const rX = springStep(configX, sX, targetX, dt);
                const rY = springStep(configY, sY, targetY, dt);
                sX = rX;
                sY = rY;
                this.zoom.panX = rX.position;
                this.zoom.panY = rY.position;
                this.applyPanTransform();
                if (rX.settled && rY.settled) {
                    this.rafId = null;
                    return;
                }
                this.rafId = requestAnimationFrame(tick);
            };
            this.rafId = requestAnimationFrame(tick);
        }
        stopSpring() {
            if (this.rafId !== null) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
        }
        applyPanTransform() {
            if (!this.imgEl)
                return;
            this.imgEl.style.transform = `translate(${this.zoom.panX}px, ${this.zoom.panY}px) scale(${this.zoom.scale})`;
        }
        computePanBounds(scale) {
            const { fitRect } = this.zoom;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const scaledW = fitRect.width * scale;
            const scaledH = fitRect.height * scale;
            // Uniform margin kept between the panned image and every viewport edge
            // (top, bottom, left, right). Reads --lb-image-padding.
            const m = this.getTargetImagePadding();
            // Actual image center. The fit rect is centered in the padded area
            // (asymmetric top/bottom padding), not in the viewport, and the scale
            // transform pivots around this point.
            const cx = fitRect.x + fitRect.width / 2;
            const cy = fitRect.y + fitRect.height / 2;
            // Pan range that keeps the scaled image edges exactly `m` px from the
            // viewport edges. If the scaled image fits inside the margins on an
            // axis, don't pan it on that axis.
            let minX = 0, maxX = 0, minY = 0, maxY = 0;
            if (scaledW > vw - 2 * m) {
                maxX = m + scaledW / 2 - cx; // left edge at x = m
                minX = vw - m - scaledW / 2 - cx; // right edge at x = vw - m
            }
            if (scaledH > vh - 2 * m) {
                maxY = m + scaledH / 2 - cy; // top edge at y = m
                minY = vh - m - scaledH / 2 - cy; // bottom edge at y = vh - m
            }
            return { minX, maxX, minY, maxY };
        }
        // ─── Image click handler ─────────────────────────────────────
        handleImageClick(e) {
            if (this.state.isClosing)
                return;
            if (this.zoom.dragMoved) {
                this.zoom.dragMoved = false;
                return;
            }
            // If a strip animation is in progress, complete it so zoom state is valid
            // for the newly-current image before processing the click.
            if (this.pendingNavDirection !== null) {
                this.forceCompleteStripAnimation();
            }
            // Zoomed (idle or animating) — zoom out
            if (this.zoom.zoomed || this.zoom.scale !== 1) {
                this.zoomOut();
                return;
            }
            if (this.isZoomable()) {
                this.zoomIn(e.clientX, e.clientY);
            }
            else {
                this.close();
            }
        }
        // ─── Cursor state ────────────────────────────────────────────
        updateCursorState() {
            if (!this.imgEl)
                return;
            const img = this.imgEl;
            if (this.zoom.isDragging) {
                img.style.cursor = 'grabbing';
            }
            else if (this.zoom.zoomed) {
                img.style.cursor = 'grab';
            }
            else if (this.isZoomable()) {
                img.style.cursor = 'zoom-in';
            }
            else {
                img.style.cursor = 'pointer';
            }
        }
        // ─── Chrome UI ──────────────────────────────────────────────
        createChrome() {
            if (!this.overlay)
                return;
            const isGallery = this.gallery.length > 1;
            const caption = this.getCurrentCaption();
            const hasContent = isGallery || !!caption;
            // Bottom pill bar
            const bar = document.createElement('div');
            bar.className = 'lightbox3-chrome';
            if (!hasContent)
                bar.classList.add('lightbox3-chrome--minimal');
            // Counter (gallery only)
            const counter = document.createElement('span');
            counter.className = 'lightbox3-counter';
            if (isGallery) {
                counter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
            }
            else {
                counter.style.display = 'none';
            }
            bar.appendChild(counter);
            this.chromeCounter = counter;
            // Caption
            const captionEl = document.createElement('span');
            captionEl.className = 'lightbox3-caption';
            captionEl.innerHTML = caption;
            if (!caption)
                captionEl.style.display = 'none';
            bar.appendChild(captionEl);
            this.chromeCaption = captionEl;
            // Close button
            const close = document.createElement('button');
            close.className = 'lightbox3-close';
            close.setAttribute('aria-label', 'Close');
            close.type = 'button';
            close.innerHTML =
                '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
            });
            close.addEventListener('pointerdown', (e) => e.stopPropagation());
            bar.appendChild(close);
            this.chromeClose = close;
            this.bindPressSpring(close);
            // Remove close from bar — it lives directly on the overlay so it can be
            // positioned independently at the top-right corner of the image.
            bar.removeChild(close);
            this.overlay.appendChild(close);
            // Stop clicks on the chrome bar (e.g. caption links) from reaching the
            // backdrop, which would close the lightbox.
            bar.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            this.overlay.appendChild(bar);
            this.chromeBar = bar;
            this.overlay.focus({ preventScroll: true });
            // Navigation arrows (gallery only)
            if (isGallery) {
                const prev = document.createElement('button');
                prev.className = 'lightbox3-arrow lightbox3-arrow-prev';
                prev.setAttribute('aria-label', 'Previous image');
                prev.type = 'button';
                prev.innerHTML =
                    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="12,4 6,10 12,16"/></svg>';
                prev.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.prev();
                });
                prev.addEventListener('pointerdown', (e) => e.stopPropagation());
                this.overlay.appendChild(prev);
                this.chromePrev = prev;
                this.bindPressSpring(prev);
                const next = document.createElement('button');
                next.className = 'lightbox3-arrow lightbox3-arrow-next';
                next.setAttribute('aria-label', 'Next image');
                next.type = 'button';
                next.innerHTML =
                    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="8,4 14,10 8,16"/></svg>';
                next.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.next();
                });
                next.addEventListener('pointerdown', (e) => e.stopPropagation());
                this.overlay.appendChild(next);
                this.chromeNext = next;
                this.bindPressSpring(next);
                this.updateArrowVisibility();
            }
        }
        getCurrentCaption() {
            if (this.gallery.length > 0) {
                return this.gallery[this.currentIndex]?.caption || '';
            }
            return this.state.triggerEl?.getAttribute('data-caption') || this.state.triggerEl?.getAttribute('data-title') || '';
        }
        getCurrentAlt() {
            if (this.gallery.length > 0) {
                return this.gallery[this.currentIndex]?.alt || '';
            }
            const triggerEl = this.state.triggerEl;
            const img = triggerEl?.querySelector('img');
            return triggerEl?.getAttribute('data-alt') || img?.alt || '';
        }
        updateChromeContent() {
            const caption = this.getCurrentCaption();
            if (this.chromeCounter) {
                this.chromeCounter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
            }
            if (this.chromeCaption) {
                this.chromeCaption.innerHTML = caption;
                this.chromeCaption.style.display = caption ? '' : 'none';
            }
            this.updateArrowVisibility();
        }
        updateArrowVisibility() {
            if (this.chromePrev) {
                this.chromePrev.style.display = this.currentIndex > 0 ? '' : 'none';
            }
            if (this.chromeNext) {
                this.chromeNext.style.display =
                    this.currentIndex < this.gallery.length - 1 ? '' : 'none';
            }
        }
        resetChromeDrift() {
            this.chromeDriftProgress = 0;
            this.chromeDriftVectors = { bar: { x: 0, y: 0 }, prev: { x: 0, y: 0 }, next: { x: 0, y: 0 } };
        }
        animateChrome(target) {
            this.stopChromeSpring();
            // Reset drift — directional drift is only used during open/close morph
            this.resetChromeDrift();
            if (this.reducedMotion) {
                this.chromeSpring = { position: target, velocity: 0 };
                this.updateChromeVisuals();
                return;
            }
            const config = target === 1 ? this.opts.springOpen : this.opts.springClose;
            let lastTime = performance.now();
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                const result = springStep(config, this.chromeSpring, target, dt);
                this.chromeSpring = result;
                this.updateChromeVisuals();
                if (result.settled) {
                    this.chromeRafId = null;
                    return;
                }
                this.chromeRafId = requestAnimationFrame(tick);
            };
            this.chromeRafId = requestAnimationFrame(tick);
        }
        updateChromeVisuals() {
            const zoom = this.chromeSpring.position;
            const opacity = this.chromeBaseOpacity;
            const interactive = opacity > 0.1 && zoom < 0.5;
            // Slide chrome off viewport edges when zoomed
            const barY = zoom * 120;
            const arrowX = zoom * 100;
            // Per-element directional drift toward/from thumbnail origin
            const p = this.chromeDriftProgress;
            const d = this.chromeDriftVectors;
            if (this.chromeBar) {
                this.chromeBar.style.opacity = String(opacity);
                const fitRect = this.chromeBarFitRect || this.zoom.fitRect;
                const imgLeft = fitRect ? fitRect.x : 0;
                const imgBottom = fitRect ? fitRect.y + fitRect.height : window.innerHeight;
                const imgWidth = fitRect ? fitRect.width : window.innerWidth;
                const chromePadding = 8;
                this.chromeBar.style.width = `${imgWidth}px`;
                this.chromeBar.style.transform = `translate(${imgLeft + d.bar.x * p}px, ${imgBottom + chromePadding + barY + d.bar.y * p}px)`;
                this.chromeBar.style.pointerEvents = interactive ? '' : 'none';
            }
            if (this.chromePrev) {
                const prevScale = this.getPressScale(this.chromePrev);
                this.chromePrev.style.opacity = String(opacity);
                this.chromePrev.style.transform = `translateY(calc(-50% + ${d.prev.y * p}px)) translateX(${-arrowX + d.prev.x * p}px) scale(${prevScale})`;
                this.chromePrev.style.pointerEvents = interactive ? '' : 'none';
            }
            if (this.chromeNext) {
                const nextScale = this.getPressScale(this.chromeNext);
                this.chromeNext.style.opacity = String(opacity);
                this.chromeNext.style.transform = `translateY(calc(-50% + ${d.next.y * p}px)) translateX(${arrowX + d.next.x * p}px) scale(${nextScale})`;
                this.chromeNext.style.pointerEvents = interactive ? '' : 'none';
            }
            if (this.chromeClose) {
                const closeSize = 40;
                const closeMargin = 8;
                const closeMarginRight = 0;
                const fitRect = this.chromeBarFitRect || this.zoom.fitRect;
                const imgLeft = fitRect ? fitRect.x : 0;
                const imgWidth = fitRect ? fitRect.width : window.innerWidth;
                const imgBottom = fitRect ? fitRect.y + fitRect.height : window.innerHeight;
                const closeX = imgLeft + imgWidth - closeSize - closeMarginRight;
                const closeY = imgBottom + closeMargin;
                const closeScale = this.getPressScale(this.chromeClose);
                this.chromeClose.style.opacity = String(opacity * (1 - zoom));
                this.chromeClose.style.transform = `translate(${closeX + d.bar.x * p}px, ${closeY + barY + d.bar.y * p}px) scale(${closeScale})`;
                this.chromeClose.style.pointerEvents = interactive ? '' : 'none';
            }
        }
        stopChromeSpring() {
            if (this.chromeRafId !== null) {
                cancelAnimationFrame(this.chromeRafId);
                this.chromeRafId = null;
            }
        }
        // ─── Button press spring ────────────────────────────────────
        bindPressSpring(btn) {
            this.pressSprings.set(btn, { state: { position: 1, velocity: 0 }, target: 1 });
            btn.addEventListener('pointerdown', () => this.animatePressSpring(btn, 0.85));
            btn.addEventListener('pointerup', () => this.animatePressSpring(btn, 1));
            btn.addEventListener('pointerleave', () => this.animatePressSpring(btn, 1));
        }
        getPressScale(btn) {
            if (!btn)
                return 1;
            const entry = this.pressSprings.get(btn);
            return entry ? entry.state.position : 1;
        }
        animatePressSpring(btn, target) {
            const entry = this.pressSprings.get(btn);
            if (!entry)
                return;
            entry.target = target;
            this.startPressLoop();
        }
        startPressLoop() {
            if (this.pressRafId !== null)
                return;
            if (this.reducedMotion) {
                for (const [, entry] of this.pressSprings) {
                    entry.state = { position: entry.target, velocity: 0 };
                }
                this.updateChromeVisuals();
                return;
            }
            let lastTime = performance.now();
            const tick = (now) => {
                const dt = Math.min((now - lastTime) / 1000, 0.064);
                lastTime = now;
                let allSettled = true;
                for (const [, entry] of this.pressSprings) {
                    const result = springStep(PRESS_SPRING, entry.state, entry.target, dt);
                    entry.state = result;
                    if (!result.settled)
                        allSettled = false;
                }
                this.updateChromeVisuals();
                if (allSettled) {
                    this.pressRafId = null;
                    return;
                }
                this.pressRafId = requestAnimationFrame(tick);
            };
            this.pressRafId = requestAnimationFrame(tick);
        }
        // ─── DOM ─────────────────────────────────────────────────────
        createOverlay(src) {
            const overlay = document.createElement('div');
            overlay.className = 'lightbox3-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.tabIndex = -1;
            const backdrop = document.createElement('div');
            backdrop.className = 'lightbox3-backdrop';
            backdrop.style.opacity = '0';
            backdrop.addEventListener('click', this.close);
            // Strip container — translates horizontally for gallery navigation
            const strip = document.createElement('div');
            strip.className = 'lightbox3-strip';
            // Center slide
            const { slide, img } = this.createSlide(src, this.getCurrentAlt());
            slide.style.left = '0';
            slide.style.pointerEvents = 'auto';
            strip.appendChild(slide);
            overlay.addEventListener('pointerdown', this.handleOverlayPointerDown);
            overlay.addEventListener('pointermove', this.handlePointerMove);
            overlay.addEventListener('pointerup', this.handlePointerUp);
            overlay.addEventListener('pointercancel', this.handlePointerUp);
            overlay.addEventListener('wheel', this.handleWheel, { passive: false });
            overlay.appendChild(backdrop);
            overlay.appendChild(strip);
            document.body.appendChild(overlay);
            this.overlay = overlay;
            this.backdrop = backdrop;
            this.stripEl = strip;
            this.currentSlideEl = slide;
            this.imgEl = img;
        }
        createSlide(src, alt = '') {
            const slide = document.createElement('div');
            slide.className = 'lightbox3-slide';
            const img = document.createElement('img');
            img.className = 'lightbox3-image';
            // Decode off the main thread so a large image swapping in doesn't block the
            // frame and stutter the open/navigate spring animation.
            img.decoding = 'async';
            if (src)
                img.src = src;
            img.alt = alt;
            img.draggable = false;
            img.addEventListener('click', (e) => this.handleImageClick(e));
            img.addEventListener('pointerdown', this.handleImagePointerDown);
            img.addEventListener('pointermove', this.handlePointerMove);
            img.addEventListener('pointerup', this.handlePointerUp);
            img.addEventListener('pointercancel', this.handlePointerUp);
            slide.appendChild(img);
            return { slide, img };
        }
        /** Create and position an adjacent (prev or next) slide in the strip. */
        createAdjacentSlide(galleryIndex, leftPosition) {
            if (!this.stripEl)
                return;
            const item = this.gallery[galleryIndex];
            if (!item)
                return;
            const { slide, img } = this.createSlide('', item.alt);
            slide.style.left = `${leftPosition}px`;
            slide.style.pointerEvents = 'none';
            // Use full-res if already cached, otherwise thumbnail
            this.setupSlideImage(img, item);
            this.stripEl.appendChild(slide);
            if (leftPosition < 0) {
                this.prevSlideEl = slide;
                this.prevSlideImg = img;
            }
            else {
                this.nextSlideEl = slide;
                this.nextSlideImg = img;
            }
        }
        /** Set the src and position for an adjacent slide's image. */
        setupSlideImage(img, item) {
            const br = this.getTargetBorderRadius();
            img.style.borderRadius = br > 0 ? `${br}px` : '';
            const cached = this.preloadCache.get(item.src);
            const fullResReady = cached?.complete && cached.naturalWidth > 0;
            if (fullResReady) {
                img.src = item.src;
                // This element may have been showing a thumbnail earlier (shadow hidden)
                img.style.boxShadow = '';
                const rect = this.computeTargetRect(cached.naturalWidth, cached.naturalHeight);
                this.positionImageEl(img, rect);
                // Decode now (off the main thread) so it is ready when the slide slides in
                decodeImage(img);
            }
            else {
                img.src = item.thumbSrc || item.src;
                const thumbImg = item.triggerEl.querySelector('img');
                const natW = thumbImg?.naturalWidth || 400;
                const natH = thumbImg?.naturalHeight || 300;
                const rect = this.computeTargetRectFromAspectRatio(natW, natH);
                this.positionImageEl(img, rect);
                // Hide shadow while showing thumb — restored in swapToFullRes when full-res loads.
                img.style.boxShadow = 'none';
                // If preload is in progress, upgrade this slide as soon as it completes
                if (cached && !cached.complete) {
                    const onLoad = () => {
                        cached.removeEventListener('error', onError);
                        if (this.state.isClosing || !this.state.isOpen)
                            return;
                        // Don't resize/swap a slide while the strip is travelling: setupCurrentImage
                        // will fade the full-res in once navigation completes.
                        if (this.stripRafId !== null || this.stripOffset !== 0)
                            return;
                        // Only upgrade if this img is still an adjacent slide (not yet current)
                        if ((img === this.prevSlideImg || img === this.nextSlideImg) &&
                            cached.naturalWidth > 0) {
                            img.src = item.src;
                            // Full-res is showing now, so bring the shadow back. Without this
                            // it stays hidden once this slide becomes the current one, because
                            // setupCurrentImage skips swapToFullRes for an already-loaded image.
                            img.style.boxShadow = '';
                            const fullRect = this.computeTargetRect(cached.naturalWidth, cached.naturalHeight);
                            this.positionImageEl(img, fullRect);
                            decodeImage(img);
                        }
                    };
                    const onError = () => cached.removeEventListener('load', onLoad);
                    cached.addEventListener('load', onLoad, { once: true });
                    cached.addEventListener('error', onError, { once: true });
                }
            }
        }
        /** Position an image element at the given rect. */
        positionImageEl(img, rect) {
            Object.assign(img.style, {
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
            });
        }
        /** Populate prev and next slides for gallery navigation. */
        populateAdjacentSlides() {
            if (!this.stripEl || this.gallery.length <= 1)
                return;
            const slideWidth = window.innerWidth + SLIDE_GAP;
            if (this.currentIndex > 0) {
                this.createAdjacentSlide(this.currentIndex - 1, -slideWidth);
            }
            if (this.currentIndex < this.gallery.length - 1) {
                this.createAdjacentSlide(this.currentIndex + 1, slideWidth);
            }
        }
        removeOverlay() {
            if (this.overlay) {
                this.overlay.remove();
                this.overlay = null;
                this.backdrop = null;
                this.imgEl = null;
                this.stripEl = null;
                this.currentSlideEl = null;
                this.prevSlideEl = null;
                this.prevSlideImg = null;
                this.nextSlideEl = null;
                this.nextSlideImg = null;
                this.chromeBar = null;
                this.chromeCounter = null;
                this.chromeCaption = null;
                this.chromeClose = null;
                this.chromePrev = null;
                this.chromeNext = null;
                this.pressSprings.clear();
                if (this.pressRafId !== null) {
                    cancelAnimationFrame(this.pressRafId);
                    this.pressRafId = null;
                }
            }
        }
        positionImage(rect) {
            if (!this.imgEl)
                return;
            Object.assign(this.imgEl.style, {
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
            });
        }
        // ─── Helpers ─────────────────────────────────────────────────
        /** Target border-radius for the lightbox image, read from --lb-image-border-radius CSS property. */
        getTargetBorderRadius() {
            if (this.overlay) {
                const value = getComputedStyle(this.overlay).getPropertyValue('--lb-image-border-radius');
                if (value)
                    return parseFloat(value) || 0;
            }
            return DEFAULT_IMAGE_BORDER_RADIUS;
        }
        /** Viewport padding around the lightbox image, read from --lb-image-padding CSS property. */
        getTargetImagePadding() {
            if (this.overlay) {
                const value = getComputedStyle(this.overlay).getPropertyValue('--lb-image-padding');
                if (value)
                    return parseFloat(value) || 0;
            }
            return this.opts.padding;
        }
        /** Extra bottom padding to keep the chrome bar below the image.
         *  Reads --lb-image-padding-bottom; falls back to the base padding. */
        getTargetImagePaddingBottom() {
            if (this.overlay) {
                const value = getComputedStyle(this.overlay).getPropertyValue('--lb-image-padding-bottom');
                if (value)
                    return parseFloat(value) || 0;
            }
            return this.getTargetImagePadding();
        }
        /** Horizontal padding that keeps the image clear of the prev/next arrow buttons.
         *  On desktop with a gallery the arrows are visible, so we reserve their footprint.
         *  On mobile (<= 600px) arrows are hidden so we fall back to the base padding. */
        getTargetImagePaddingSide() {
            if (window.innerWidth <= 600 || this.gallery.length <= 1 || window.innerHeight > window.innerWidth)
                return this.getTargetImagePadding();
            // Arrow button: 48px wide, anchored at --lb-chrome-padding (16px) from edge.
            // Add an 8px gap between the arrow and the image edge.
            const chromePadding = parseFloat(getComputedStyle(this.overlay).getPropertyValue('--lb-chrome-padding')) || 16;
            const arrowWidth = 48;
            const gap = 8;
            return chromePadding + arrowWidth + gap;
        }
        /** Read author-provided full-res dimensions from `data-width`/`data-height`.
         *  Returns null unless both parse to positive numbers. Lets the opening morph
         *  target the correct rect before the full-res image has loaded, so there's no
         *  reflow when it arrives (swapToFullRes reconciles any small mismatch). */
        getDimensionHint(el) {
            const w = parseFloat(el.getAttribute('data-width') || '');
            const h = parseFloat(el.getAttribute('data-height') || '');
            if (w > 0 && h > 0)
                return { w, h };
            return null;
        }
        handleResize() {
            if (!this.state.isOpen || this.state.isClosing || this.state.isDismissClosing)
                return;
            if (this.state.isAnimating)
                return;
            const { naturalWidth, naturalHeight } = this.zoom;
            if (!naturalWidth || !naturalHeight)
                return;
            // Reposition current image
            const newRect = this.computeTargetRect(naturalWidth, naturalHeight);
            this.zoom.fitRect = newRect;
            this.positionImage(newRect);
            // Reposition existing adjacent slides — do NOT call populateAdjacentSlides()
            // as that always appends new elements, causing duplicates on every resize.
            if (this.gallery.length > 1) {
                const slideWidth = window.innerWidth + SLIDE_GAP;
                if (this.prevSlideEl && this.prevSlideImg) {
                    this.prevSlideEl.style.left = `${-slideWidth}px`;
                    const prevItem = this.gallery[this.currentIndex - 1];
                    if (prevItem)
                        this.setupSlideImage(this.prevSlideImg, prevItem);
                }
                if (this.nextSlideEl && this.nextSlideImg) {
                    this.nextSlideEl.style.left = `${slideWidth}px`;
                    const nextItem = this.gallery[this.currentIndex + 1];
                    if (nextItem)
                        this.setupSlideImage(this.nextSlideImg, nextItem);
                }
            }
            this.updateChromeVisuals();
        }
        computeTargetRect(naturalWidth, naturalHeight) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const p = this.getTargetImagePadding();
            const ps = this.getTargetImagePaddingSide();
            const pb = this.getTargetImagePaddingBottom();
            const availW = vw - ps * 2;
            const availH = vh - p - pb;
            const scale = Math.min(availW / naturalWidth, availH / naturalHeight, 1);
            const w = naturalWidth * scale;
            const h = naturalHeight * scale;
            return new DOMRect(ps + (availW - w) / 2, p + (availH - h) / 2, w, h);
        }
        /** Like computeTargetRect but without the scale ≤ 1 cap. Used when full-res
         *  dimensions are unknown — fills the viewport based on aspect ratio alone. */
        computeTargetRectFromAspectRatio(width, height) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const p = this.getTargetImagePadding();
            const ps = this.getTargetImagePaddingSide();
            const pb = this.getTargetImagePaddingBottom();
            const availW = vw - ps * 2;
            const availH = vh - p - pb;
            const scale = Math.min(availW / width, availH / height);
            const w = width * scale;
            const h = height * scale;
            return new DOMRect(ps + (availW - w) / 2, p + (availH - h) / 2, w, h);
        }
        loadImage(src) {
            const cached = this.preloadCache.get(src);
            if (cached?.complete && cached.naturalWidth > 0) {
                return Promise.resolve({ width: cached.naturalWidth, height: cached.naturalHeight });
            }
            return new Promise((resolve) => {
                const img = cached || new Image();
                img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = () => resolve({ width: 800, height: 600 });
                if (!cached) {
                    img.decoding = 'async';
                    img.src = src;
                    this.cachePreload(src, img);
                }
            });
        }
        startDebugPanel() {
            if (!this.opts.debug || this.debugEl)
                return;
            this.debugT0 = performance.now();
            this.debugLogEntries = [];
            // Container: two-column layout
            const el = document.createElement('div');
            Object.assign(el.style, {
                position: 'fixed',
                top: '8px',
                left: '8px',
                zIndex: '9999999',
                display: 'flex',
                gap: '8px',
                fontFamily: 'monospace',
                fontSize: '11px',
                lineHeight: '1.5',
                pointerEvents: 'none',
            });
            // Left column: live state
            const stateCol = document.createElement('div');
            Object.assign(stateCol.style, {
                background: 'rgba(0,0,0,0.85)',
                color: '#0f0',
                padding: '8px 12px',
                borderRadius: '6px',
                whiteSpace: 'pre',
                minWidth: '260px',
            });
            // Right column: event log
            const logCol = document.createElement('div');
            Object.assign(logCol.style, {
                background: 'rgba(0,0,0,0.85)',
                color: '#ccc',
                padding: '8px 12px',
                borderRadius: '6px',
                whiteSpace: 'pre',
                minWidth: '280px',
                maxHeight: '400px',
                overflowY: 'auto',
                pointerEvents: 'auto',
            });
            logCol.textContent = '── event log ──────────\n';
            el.appendChild(stateCol);
            el.appendChild(logCol);
            document.body.appendChild(el);
            this.debugEl = el;
            this.debugStateEl = stateCol;
            this.debugLogEl = logCol;
            const tick = () => {
                this.updateDebugPanel();
                this.debugRafId = requestAnimationFrame(tick);
            };
            this.debugRafId = requestAnimationFrame(tick);
        }
        stopDebugPanel() {
            if (this.debugRafId !== null) {
                cancelAnimationFrame(this.debugRafId);
                this.debugRafId = null;
            }
            if (this.debugEl) {
                this.debugEl.remove();
                this.debugEl = null;
                this.debugStateEl = null;
                this.debugLogEl = null;
            }
        }
        debugLog(msg) {
            if (!this.debugLogEl)
                return;
            const t = ((performance.now() - this.debugT0) / 1000).toFixed(2);
            const entry = `${t}s  ${msg}`;
            this.debugLogEntries.push(entry);
            // Keep last 100 entries
            if (this.debugLogEntries.length > 100)
                this.debugLogEntries.shift();
            this.debugLogEl.textContent =
                '── event log ──────────\n' + this.debugLogEntries.join('\n');
            this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight;
        }
        updateDebugPanel() {
            if (!this.debugStateEl)
                return;
            const on = (v) => (v ? '●' : '○');
            const px = (v) => v.toFixed(1);
            const lines = [
                `── state ──────────────`,
                `isOpen:${on(this.state.isOpen)}  isAnim:${on(this.state.isAnimating)}  isClosing:${on(this.state.isClosing)}`,
                `gallery: ${this.currentIndex + 1}/${this.gallery.length || 1}`,
                ``,
                `── springs ────────────`,
                `mainRaf:  ${on(this.rafId !== null)}`,
                `stripRaf: ${on(this.stripRafId !== null)}  offset: ${px(this.stripOffset)}`,
                `chromeRaf:${on(this.chromeRafId !== null)}`,
                `pendingNav: ${this.pendingNavDirection ?? 'none'}`,
                ``,
                `── zoom ───────────────`,
                `scale: ${px(this.zoom.scale)}  zoomed:${on(this.zoom.zoomed)}`,
                `pan: ${px(this.zoom.panX)}, ${px(this.zoom.panY)}`,
                `dragging:${on(this.zoom.isDragging)}  dragMoved:${on(this.zoom.dragMoved)}`,
                ``,
                `── gestures ───────────`,
                `dismiss: track:${on(this.dismiss.tracking)} active:${on(this.dismiss.active)}`,
                `swipeNav: ${on(this.swipeNav.active)}`,
                `pinch: ${on(this.pinch.active)}`,
                ``,
                `── wheel nav ──────────`,
                `committed:${on(this.wheelNavCommitted)}`,
                `totalDelta: ${px(this.wheelNavTotalDelta)}`,
                `gestureTimer: ${on(this.wheelGestureTimer !== null)}`,
                `dismissY: ${px(this.wheelDismissY)}`,
            ];
            // Gallery preload status
            if (this.gallery.length > 1) {
                lines.push('', '── gallery preload ────');
                for (let i = 0; i < this.gallery.length; i++) {
                    const item = this.gallery[i];
                    const cached = this.preloadCache.get(item.src);
                    const isCurrent = i === this.currentIndex;
                    const marker = isCurrent ? '▸' : ' ';
                    let status;
                    if (cached?.complete && cached.naturalWidth > 0) {
                        status = `● ${cached.naturalWidth}×${cached.naturalHeight}`;
                    }
                    else if (cached) {
                        status = '◐ loading';
                    }
                    else {
                        status = '○ pending';
                    }
                    // Truncate filename for display
                    const filename = item.src.split('/').pop() || item.src;
                    const name = filename.length > 20 ? filename.slice(0, 19) + '…' : filename;
                    lines.push(`${marker}${String(i + 1).padStart(2)} ${name.padEnd(20)} ${status}`);
                }
            }
            this.debugStateEl.textContent = lines.join('\n');
        }
    }
    Lightbox.instance = null;
    // ─── Utility functions ───────────────────────────────────────
    /** Resolves when the browser has decoded the image (never rejects). */
    function decodeImage(img) {
        if (!img || typeof img.decode !== 'function')
            return Promise.resolve();
        return img.decode().catch(() => { });
    }
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    function rubberBand(value, min, max) {
        if (value < min)
            return min - (min - value) * RUBBER_BAND_FACTOR;
        if (value > max)
            return max + (value - max) * RUBBER_BAND_FACTOR;
        return value;
    }

    function autoInit() {
        if (!document.querySelector('[data-lightbox]'))
            return;
        const debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
        Lightbox.init(debug ? { debug: true } : undefined);
    }
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', autoInit);
        }
        else {
            autoInit();
        }
    }

    exports.Lightbox = Lightbox;

}));
//# sourceMappingURL=lightbox3.umd.js.map
