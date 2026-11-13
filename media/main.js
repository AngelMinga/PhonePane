// @ts-check
(() => {
  const vscode = acquireVsCodeApi();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
  const retry = /** @type {HTMLButtonElement} */ (document.getElementById('retry'));
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
  const LONG_PRESS_MS = 450;
  const DRAG_THRESHOLD_CSS_PX = 8;

  // ---- Frames -------------------------------------------------------------

  /** @type {Uint8Array | null} */
  let pendingFrame = null;
  let decoding = false;

  /** Decodes frames one at a time, always jumping to the newest one. */
  async function drawFrame(/** @type {Uint8Array} */ bytes) {
    pendingFrame = bytes;
    if (decoding) {
      return;
    }
    decoding = true;
    try {
      while (pendingFrame) {
        const next = pendingFrame;
        pendingFrame = null;
        const bitmap = await createImageBitmap(new Blob([next], { type: 'image/png' }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        canvas.hidden = false;
        status.hidden = true;
      }
    } catch {
      // A corrupted frame is simply skipped.
    } finally {
      decoding = false;
    }
  }

  function showStatus(/** @type {string} */ text, /** @type {boolean} */ canRetry) {
    canvas.hidden = true;
    status.hidden = false;
    statusText.textContent = text;
    retry.hidden = !canRetry;
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer;
  function showToast(/** @type {string} */ text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 4000);
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'frame':
        void drawFrame(m.data);
        break;
      case 'status':
        showStatus(m.text, true);
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

  // ---- Touch --------------------------------------------------------------

  /** Converts a pointer position into device pixels. */
  function toDevice(/** @type {{clientX: number, clientY: number}} */ e) {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * canvas.width) / r.width;
    const y = ((e.clientY - r.top) * canvas.height) / r.height;
    return {
      x: Math.round(Math.min(Math.max(x, 0), canvas.width - 1)),
      y: Math.round(Math.min(Math.max(y, 0), canvas.height - 1)),
    };
  }

  /** @type {{x: number, y: number, clientX: number, clientY: number, time: number} | null} */
  let down = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    down = { ...toDevice(e), clientX: e.clientX, clientY: e.clientY, time: performance.now() };
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!down) {
      return;
    }
    flushText();
    const start = down;
    down = null;
    const end = toDevice(e);
    const elapsed = performance.now() - start.time;
    const moved = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > DRAG_THRESHOLD_CSS_PX;

    if (moved) {
      vscode.postMessage({ type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: Math.max(80, elapsed) });
    } else if (elapsed >= LONG_PRESS_MS) {
      // A swipe that does not move is a long press.
      vscode.postMessage({ type: 'swipe', x1: start.x, y1: start.y, x2: start.x, y2: start.y, duration: elapsed });
    } else {
      vscode.postMessage({ type: 'tap', x: start.x, y: start.y });
    }
  });

  canvas.addEventListener('pointercancel', () => (down = null));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- Scroll wheel -> swipe ----------------------------------------------

  let wheelDelta = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let wheelTimer;
  /** @type {{x: number, y: number}} */
  let wheelOrigin = { x: 0, y: 0 };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelOrigin = toDevice(e);
      wheelDelta += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (wheelTimer) {
        return;
      }
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined;
        const r = canvas.getBoundingClientRect();
        const scale = canvas.height / r.height;
        const distance = Math.min(Math.abs(wheelDelta) * scale, canvas.height * 0.4);
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

  // ---- Keyboard -----------------------------------------------------------

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
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    if (e.key in KEYCODES) {
      e.preventDefault();
      flushText();
      vscode.postMessage({ type: 'key', code: KEYCODES[/** @type {keyof typeof KEYCODES} */ (e.key)] });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      textBuffer += e.key;
      clearTimeout(textTimer);
      textTimer = setTimeout(flushText, 80);
    }
  });

  // ---- Navigation bar -----------------------------------------------------

  document.querySelectorAll('#nav button').forEach((button) => {
    button.addEventListener('click', () => {
      flushText();
      vscode.postMessage({ type: 'key', code: Number(/** @type {HTMLElement} */ (button).dataset.key) });
    });
  });

  vscode.postMessage({ type: 'ready' });
})();
