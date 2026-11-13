// @ts-check
(() => {
  const vscode = acquireVsCodeApi();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
  const retry = /** @type {HTMLButtonElement} */ (document.getElementById('retry'));
  const modeBadge = /** @type {HTMLElement} */ (document.getElementById('mode-badge'));
  const pausedBadge = /** @type {HTMLElement} */ (document.getElementById('paused-badge'));
  const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));

  // Android key codes for keys typed while the screen has focus.
  const KEYCODES = {
    Enter: 66,
    Backspace: 67,
    Delete: 112,
    Tab: 61,
    Escape: 4,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
  };
  const TOUCH = { down: 0, up: 1, move: 2 };
  const LONG_PRESS_MS = 450;
  const DRAG_THRESHOLD_CSS_PX = 8;

  /** @type {'scrcpy' | 'screencap' | null} */
  let mode = null;

  function showScreen() {
    canvas.hidden = false;
    status.hidden = true;
  }

  function resizeCanvas(/** @type {number} */ width, /** @type {number} */ height) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  // ---- scrcpy: H.264 via WebCodecs ------------------------------------------

  /** @type {VideoDecoder | null} */
  let decoder = null;
  let decoderCodec = '';
  let needKeyFrame = true;
  let timestamp = 0;

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') {
      decoder.close();
    }
    decoder = null;
    needKeyFrame = true;
  }

  function createDecoder(/** @type {string} */ codec) {
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => {
        resizeCanvas(frame.displayWidth, frame.displayHeight);
        ctx.drawImage(frame, 0, 0);
        frame.close();
        showScreen();
      },
      error: (e) => {
        decoder = null;
        needKeyFrame = true;
        vscode.postMessage({ type: 'videoError', message: String(e) });
      },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    decoderCodec = codec;
  }

  function onChunk(/** @type {{key: boolean, codec: string, data: Uint8Array}} */ m) {
    if (m.key && (!decoder || decoder.state === 'closed' || decoderCodec !== m.codec)) {
      createDecoder(m.codec);
    }
    if (!decoder || (needKeyFrame && !m.key)) {
      return;
    }
    needKeyFrame = false;
    // Drop frames if the decoder falls behind; the next key frame resynchronises.
    if (decoder.decodeQueueSize > 10 && !m.key) {
      needKeyFrame = true;
      vscode.postMessage({ type: 'videoError', message: 'decoder queue overflow' });
      return;
    }
    decoder.decode(
      new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: (timestamp += 16_666), data: m.data }),
    );
  }

  async function supportsH264() {
    if (typeof VideoDecoder === 'undefined') {
      return false;
    }
    try {
      const { supported } = await VideoDecoder.isConfigSupported({ codec: 'avc1.640028' });
      return !!supported;
    } catch {
      return false;
    }
  }

  // ---- screencap: PNG frames ------------------------------------------------

  /** @type {Uint8Array | null} */
  let pendingPng = null;
  let decodingPng = false;

  /** Decodes PNG frames one at a time, always jumping to the newest one. */
  async function onPng(/** @type {Uint8Array} */ bytes) {
    pendingPng = bytes;
    if (decodingPng) {
      return;
    }
    decodingPng = true;
    try {
      while (pendingPng) {
        const next = pendingPng;
        pendingPng = null;
        const bitmap = await createImageBitmap(new Blob([next], { type: 'image/png' }));
        resizeCanvas(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        showScreen();
      }
    } catch {
      // A corrupted frame is simply skipped.
    } finally {
      decodingPng = false;
    }
  }

  // ---- Messages from the extension ------------------------------------------

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer;
  function showToast(/** @type {string} */ text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 6000);
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'chunk':
        onChunk(m);
        break;
      case 'videoSize':
        // Rotation or resize: the next key frame starts a fresh decoder.
        closeDecoder();
        break;
      case 'frame':
        void onPng(m.data);
        break;
      case 'mode':
        mode = m.mode;
        modeBadge.textContent = m.label;
        modeBadge.hidden = false;
        if (mode !== 'scrcpy') {
          closeDecoder();
        }
        break;
      case 'status':
        closeDecoder();
        canvas.hidden = true;
        status.hidden = false;
        statusText.textContent = m.text;
        retry.hidden = false;
        break;
      case 'device':
        canvas.title = m.model;
        break;
      case 'paused':
        pausedBadge.hidden = !m.paused;
        break;
      case 'toast':
        showToast(m.text);
        break;
    }
  });

  retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));

  // ---- Pointer --------------------------------------------------------------

  /** Converts a pointer position into canvas (= video / device) pixels. */
  function toCanvas(/** @type {{clientX: number, clientY: number}} */ e) {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * canvas.width) / r.width;
    const y = ((e.clientY - r.top) * canvas.height) / r.height;
    return {
      x: Math.round(Math.min(Math.max(x, 0), canvas.width - 1)),
      y: Math.round(Math.min(Math.max(y, 0), canvas.height - 1)),
    };
  }

  function sendTouch(/** @type {number} */ action, /** @type {{x: number, y: number}} */ p) {
    vscode.postMessage({ type: 'touch', action, x: p.x, y: p.y, w: canvas.width, h: canvas.height });
  }

  /** @type {{x: number, y: number, clientX: number, clientY: number, time: number} | null} */
  let down = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    flushText();
    const p = toCanvas(e);
    down = { ...p, clientX: e.clientX, clientY: e.clientY, time: performance.now() };
    if (mode === 'scrcpy') {
      sendTouch(TOUCH.down, p);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (down && mode === 'scrcpy') {
      sendTouch(TOUCH.move, toCanvas(e));
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!down) {
      return;
    }
    const start = down;
    down = null;
    const end = toCanvas(e);

    if (mode === 'scrcpy') {
      sendTouch(TOUCH.up, end);
      return;
    }

    // screencap mode: replay the whole gesture with adb input.
    const elapsed = performance.now() - start.time;
    const moved = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > DRAG_THRESHOLD_CSS_PX;
    if (moved) {
      vscode.postMessage({ type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: Math.max(80, elapsed) });
    } else if (elapsed >= LONG_PRESS_MS) {
      vscode.postMessage({ type: 'swipe', x1: start.x, y1: start.y, x2: start.x, y2: start.y, duration: elapsed });
    } else {
      vscode.postMessage({ type: 'tap', x: start.x, y: start.y });
    }
  });

  canvas.addEventListener('pointercancel', (e) => {
    if (down && mode === 'scrcpy') {
      sendTouch(TOUCH.up, toCanvas(e));
    }
    down = null;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- Scroll wheel -----------------------------------------------------------

  let wheelDelta = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let wheelTimer;
  /** @type {{x: number, y: number}} */
  let wheelOrigin = { x: 0, y: 0 };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const pixels = e.deltaMode === 1 ? 16 : 1;

      if (mode === 'scrcpy') {
        // scrcpy expects "notches" (1 per mouse wheel click, ~100 px).
        const p = toCanvas(e);
        vscode.postMessage({
          type: 'scroll',
          ...p,
          w: canvas.width,
          h: canvas.height,
          dx: (-e.deltaX * pixels) / 100,
          dy: (-e.deltaY * pixels) / 100,
        });
        return;
      }

      // screencap mode: accumulate and turn into a swipe.
      wheelOrigin = toCanvas(e);
      wheelDelta += e.deltaY * pixels;
      if (wheelTimer) {
        return;
      }
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined;
        const r = canvas.getBoundingClientRect();
        const distance = Math.min((Math.abs(wheelDelta) * canvas.height) / r.height, canvas.height * 0.4);
        const direction = wheelDelta > 0 ? -1 : 1; // scrolling down = finger moves up
        wheelDelta = 0;
        if (distance < 5) {
          return;
        }
        const y2 = Math.min(Math.max(wheelOrigin.y + direction * distance, 0), canvas.height - 1);
        vscode.postMessage({
          type: 'swipe',
          x1: wheelOrigin.x,
          y1: wheelOrigin.y,
          x2: wheelOrigin.x,
          y2: Math.round(y2),
          duration: 120,
        });
      }, 120);
    },
    { passive: false },
  );

  // ---- Keyboard ---------------------------------------------------------------

  let textBuffer = '';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let textTimer;

  function flushText() {
    clearTimeout(textTimer);
    textTimer = undefined;
    if (textBuffer) {
      vscode.postMessage({ type: 'text', text: textBuffer });
      textBuffer = '';
    }
  }

  canvas.addEventListener('keydown', (e) => {
    // Leave shortcuts (Cmd/Ctrl+...) to VS Code.
    if (e.metaKey || e.ctrlKey) {
      return;
    }
    if (e.key in KEYCODES) {
      e.preventDefault();
      flushText();
      vscode.postMessage({ type: 'key', code: KEYCODES[/** @type {keyof typeof KEYCODES} */ (e.key)] });
      return;
    }
    if (e.key.length === 1 || (e.key.length === 2 && e.key.codePointAt(0) > 0xffff)) {
      e.preventDefault();
      textBuffer += e.key;
      clearTimeout(textTimer);
      // scrcpy injects text immediately; adb input is slow, so batch it.
      textTimer = setTimeout(flushText, mode === 'scrcpy' ? 0 : 80);
    }
  });

  // ---- Navigation bar ---------------------------------------------------------

  document.querySelectorAll('#nav button').forEach((button) => {
    button.addEventListener('click', () => {
      flushText();
      vscode.postMessage({ type: 'key', code: Number(/** @type {HTMLElement} */ (button).dataset.key) });
    });
  });

  void supportsH264().then((h264) => vscode.postMessage({ type: 'ready', h264 }));
})();
