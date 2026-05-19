#![cfg(target_os = "linux")]

//! Rust wrapper for the libfreerdp3 C bridge (orb_rdp_bridge.c).
//!
//! Each RDP session runs in a dedicated C-managed thread that pumps FreeRDP
//! events and calls back into Rust for each rendered frame. Mouse/keyboard
//! input goes directly to the RDP stream via libfreerdp — no X11 involved.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

// ── AT-set-1 scan codes ───────────────────────────────────────────────────────

/// Returns `(scancode, extended)` for a JavaScript `e.code` string.
/// `extended` maps to `KBD_FLAGS_EXTENDED` (0x0100) in FreeRDP.
pub fn code_to_scancode(code: &str) -> Option<(u8, bool)> {
    let r = match code {
        "Escape"           => (0x01, false),
        "F1"               => (0x3B, false),
        "F2"               => (0x3C, false),
        "F3"               => (0x3D, false),
        "F4"               => (0x3E, false),
        "F5"               => (0x3F, false),
        "F6"               => (0x40, false),
        "F7"               => (0x41, false),
        "F8"               => (0x42, false),
        "F9"               => (0x43, false),
        "F10"              => (0x44, false),
        "F11"              => (0x57, false),
        "F12"              => (0x58, false),
        "Backquote"        => (0x29, false),
        "Digit1"           => (0x02, false),
        "Digit2"           => (0x03, false),
        "Digit3"           => (0x04, false),
        "Digit4"           => (0x05, false),
        "Digit5"           => (0x06, false),
        "Digit6"           => (0x07, false),
        "Digit7"           => (0x08, false),
        "Digit8"           => (0x09, false),
        "Digit9"           => (0x0A, false),
        "Digit0"           => (0x0B, false),
        "Minus"            => (0x0C, false),
        "Equal"            => (0x0D, false),
        "Backspace"        => (0x0E, false),
        "Tab"              => (0x0F, false),
        "KeyQ"             => (0x10, false),
        "KeyW"             => (0x11, false),
        "KeyE"             => (0x12, false),
        "KeyR"             => (0x13, false),
        "KeyT"             => (0x14, false),
        "KeyY"             => (0x15, false),
        "KeyU"             => (0x16, false),
        "KeyI"             => (0x17, false),
        "KeyO"             => (0x18, false),
        "KeyP"             => (0x19, false),
        "BracketLeft"      => (0x1A, false),
        "BracketRight"     => (0x1B, false),
        "Enter"            => (0x1C, false),
        "ControlLeft"      => (0x1D, false),
        "KeyA"             => (0x1E, false),
        "KeyS"             => (0x1F, false),
        "KeyD"             => (0x20, false),
        "KeyF"             => (0x21, false),
        "KeyG"             => (0x22, false),
        "KeyH"             => (0x23, false),
        "KeyJ"             => (0x24, false),
        "KeyK"             => (0x25, false),
        "KeyL"             => (0x26, false),
        "Semicolon"        => (0x27, false),
        "Quote"            => (0x28, false),
        "ShiftLeft"        => (0x2A, false),
        "Backslash"        => (0x2B, false),
        "IntlBackslash"    => (0x56, false),
        "KeyZ"             => (0x2C, false),
        "KeyX"             => (0x2D, false),
        "KeyC"             => (0x2E, false),
        "KeyV"             => (0x2F, false),
        "KeyB"             => (0x30, false),
        "KeyN"             => (0x31, false),
        "KeyM"             => (0x32, false),
        "Comma"            => (0x33, false),
        "Period"           => (0x34, false),
        "Slash"            => (0x35, false),
        "ShiftRight"       => (0x36, false),
        "NumpadMultiply"   => (0x37, false),
        "AltLeft"          => (0x38, false),
        "Space"            => (0x39, false),
        "CapsLock"         => (0x3A, false),
        "NumLock"          => (0x45, false),
        "ScrollLock"       => (0x46, false),
        "Numpad7"          => (0x47, false),
        "Numpad8"          => (0x48, false),
        "Numpad9"          => (0x49, false),
        "NumpadSubtract"   => (0x4A, false),
        "Numpad4"          => (0x4B, false),
        "Numpad5"          => (0x4C, false),
        "Numpad6"          => (0x4D, false),
        "NumpadAdd"        => (0x4E, false),
        "Numpad1"          => (0x4F, false),
        "Numpad2"          => (0x50, false),
        "Numpad3"          => (0x51, false),
        "Numpad0"          => (0x52, false),
        "NumpadDecimal"    => (0x53, false),
        // Extended keys
        "NumpadEnter"      => (0x1C, true),
        "ControlRight"     => (0x1D, true),
        "NumpadDivide"     => (0x35, true),
        "PrintScreen"      => (0x37, true),
        "AltRight"         => (0x38, true),
        "Home"             => (0x47, true),
        "ArrowUp"          => (0x48, true),
        "PageUp"           => (0x49, true),
        "ArrowLeft"        => (0x4B, true),
        "ArrowRight"       => (0x4D, true),
        "End"              => (0x4F, true),
        "ArrowDown"        => (0x50, true),
        "PageDown"         => (0x51, true),
        "Insert"           => (0x52, true),
        "Delete"           => (0x53, true),
        "MetaLeft"         => (0x5B, true),
        "MetaRight"        => (0x5C, true),
        "ContextMenu"      => (0x5D, true),
        _ => return None,
    };
    Some(r)
}

// ── FFI declarations ──────────────────────────────────────────────────────────

#[allow(non_camel_case_types)]
pub enum OrbRdpSession {}

/// Callback fired by the C bridge for each dirty-rect paint.
/// `data` points to the full BGRX32 framebuffer; `(x,y,w,h)` is the dirty
/// rectangle; `stride` is the full-framebuffer row stride in bytes.
pub type OrbFrameFn = unsafe extern "C" fn(
    user_ctx: *mut std::ffi::c_void,
    data: *const u8,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    stride: u32,
);
pub type OrbErrorFn =
    unsafe extern "C" fn(user_ctx: *mut std::ffi::c_void, msg: *const std::ffi::c_char);

extern "C" {
    fn orb_session_new(
        host: *const std::ffi::c_char,
        port: u16,
        username: *const std::ffi::c_char,
        password: *const std::ffi::c_char,
        domain: *const std::ffi::c_char,
        width: u16,
        height: u16,
        console_mode: bool,
        on_frame: OrbFrameFn,
        on_error: OrbErrorFn,
        user_ctx: *mut std::ffi::c_void,
    ) -> *mut OrbRdpSession;

    fn orb_session_free(session: *mut OrbRdpSession);
    fn orb_send_mouse(session: *mut OrbRdpSession, flags: u16, x: u16, y: u16);
    fn orb_send_key(session: *mut OrbRdpSession, flags: u16, scancode: u8);
    fn orb_resize(session: *mut OrbRdpSession, width: u16, height: u16);
    fn orb_set_clipboard(session: *mut OrbRdpSession, text: *const std::ffi::c_char);
}

// ── Encoder pipeline ──────────────────────────────────────────────────────────

/// A dirty-rect frame with pixels already converted to RGB.
struct FrameMsg {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    rgb: Vec<u8>,
}

/// Payload emitted to the frontend for each rendered frame.
#[derive(serde::Serialize, Clone)]
struct FramePayload {
    x: u32,
    y: u32,
    data: String,
}

/// Spawns a background thread that JPEG-encodes frames and emits Tauri events.
/// The thread exits automatically when `rx` is closed (i.e. when FrameState
/// and its `tx` are dropped).
fn spawn_encoder(app: AppHandle, session_id: String, rx: mpsc::Receiver<FrameMsg>) {
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            let mut jpeg_buf = Vec::new();
            if JpegEncoder::new_with_quality(&mut jpeg_buf, 80)
                .encode(&msg.rgb, msg.w, msg.h, ExtendedColorType::Rgb8)
                .is_ok()
            {
                let payload = FramePayload {
                    x: msg.x,
                    y: msg.y,
                    data: BASE64.encode(&jpeg_buf),
                };
                app.emit(&format!("rdp-frame-{}", session_id), payload).ok();
            }
        }
    });
}

// ── Callback state ────────────────────────────────────────────────────────────

struct FrameState {
    app: AppHandle,
    session_id: String,
    /// Bounded channel (capacity 2): on_frame sends here without blocking;
    /// frames are dropped when the encoder falls behind rather than backing up.
    tx: mpsc::SyncSender<FrameMsg>,
}

/// Called on the FreeRDP event-loop thread for each dirty-rect update.
/// Must return as fast as possible — encoding happens in the encoder thread.
unsafe extern "C" fn on_frame(
    user_ctx: *mut std::ffi::c_void,
    data: *const u8,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    stride: u32,
) {
    if w == 0 || h == 0 {
        return;
    }
    let state = &*(user_ctx as *const FrameState);

    // Slice only the rows we need to avoid reading the full framebuffer.
    let row_offset = (y * stride) as usize;
    let row_bytes  = (h * stride) as usize;
    let raw = std::slice::from_raw_parts(data.add(row_offset), row_bytes);

    // Convert BGRX → RGB for the dirty sub-image.
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for row in 0..h as usize {
        let row_start = row * stride as usize + x as usize * 4;
        let row_slice = &raw[row_start..row_start + w as usize * 4];
        for chunk in row_slice.chunks_exact(4) {
            rgb.push(chunk[2]); // R  (BGRX: B=0, G=1, R=2, X=3)
            rgb.push(chunk[1]); // G
            rgb.push(chunk[0]); // B
        }
    }

    // Non-blocking: drop the frame if the encoder is busy.
    let _ = state.tx.try_send(FrameMsg { x, y, w, h, rgb });
}

unsafe extern "C" fn on_error(
    user_ctx: *mut std::ffi::c_void,
    msg: *const std::ffi::c_char,
) {
    let state = &*(user_ctx as *const FrameState);
    let raw = if msg.is_null() {
        "Unknown RDP error".to_string()
    } else {
        std::ffi::CStr::from_ptr(msg)
            .to_string_lossy()
            .into_owned()
    };

    // "SESSION_ENDED" = clean user logoff (ERRINFO_LOGOFF_BY_USER).
    // Emit a separate event so the frontend can show a neutral "session ended"
    // screen instead of the red error UI.
    if raw == "SESSION_ENDED" {
        state
            .app
            .emit(&format!("rdp-disconnected-{}", state.session_id), ())
            .ok();
    } else {
        state
            .app
            .emit(&format!("rdp-error-{}", state.session_id), raw)
            .ok();
    }
}

// ── Public session type ───────────────────────────────────────────────────────

pub struct FreerdpSession {
    pub width: u16,
    pub height: u16,
    ptr: *mut OrbRdpSession,
    /// Kept alive until drop — the C bridge holds a raw pointer into this.
    _state: Box<FrameState>,
    pub stopped: Arc<AtomicBool>,
}

// SAFETY: `OrbRdpSession*` is only accessed through the thread-safe API
// defined in orb_rdp_bridge.h (input functions are explicitly thread-safe).
unsafe impl Send for FreerdpSession {}
unsafe impl Sync for FreerdpSession {}

impl Drop for FreerdpSession {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if !self.ptr.is_null() {
            unsafe { orb_session_free(self.ptr) };
            self.ptr = std::ptr::null_mut();
        }
        // _state (and its tx) are dropped here, closing the encoder channel.
        // The encoder thread exits when it drains the channel.
    }
}

pub fn launch(
    app: AppHandle,
    session_id: &str,
    host: &str,
    port: i64,
    username: &str,
    domain: &str,
    password: Option<&str>,
    width: u16,
    height: u16,
    console_mode: bool,
) -> Result<FreerdpSession, String> {
    let password = password.ok_or_else(|| {
        "NO_PASSWORD\nNo hay contraseña guardada para esta conexión.\n\
         Seleccioná la conexión → Propiedades → ingresá y guardá la contraseña."
            .to_string()
    })?;

    let c_host     = CString::new(host).map_err(|e| e.to_string())?;
    let c_username = CString::new(username).map_err(|e| e.to_string())?;
    let c_password = CString::new(password).map_err(|e| e.to_string())?;
    let c_domain   = CString::new(domain).map_err(|e| e.to_string())?;

    // Bounded channel: capacity 2 gives the encoder a small buffer but
    // drops frames (via try_send) rather than letting them accumulate.
    let (tx, rx) = mpsc::sync_channel::<FrameMsg>(2);

    let state = Box::new(FrameState {
        app: app.clone(),
        session_id: session_id.to_string(),
        tx,
    });
    let user_ctx = &*state as *const FrameState as *mut std::ffi::c_void;

    // Spawn encoder before connecting so frames are never dropped on startup.
    spawn_encoder(app, session_id.to_string(), rx);

    let ptr = unsafe {
        orb_session_new(
            c_host.as_ptr(),
            port as u16,
            c_username.as_ptr(),
            c_password.as_ptr(),
            c_domain.as_ptr(),
            width,
            height,
            console_mode,
            on_frame,
            on_error,
            user_ctx,
        )
    };

    if ptr.is_null() {
        return Err("Failed to allocate RDP session".to_string());
    }

    Ok(FreerdpSession {
        width,
        height,
        ptr,
        _state: state,
        stopped: Arc::new(AtomicBool::new(false)),
    })
}

impl FreerdpSession {
    pub fn send_mouse(&self, flags: u16, x: u16, y: u16) {
        if !self.stopped.load(Ordering::Relaxed) {
            unsafe { orb_send_mouse(self.ptr, flags, x, y) };
        }
    }

    pub fn send_key(&self, pressed: bool, code: &str) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        if let Some((scancode, extended)) = code_to_scancode(code) {
            let mut flags: u16 = if pressed { 0x4000 } else { 0x8000 };
            if extended {
                flags |= 0x0100;
            }
            unsafe { orb_send_key(self.ptr, flags, scancode) };
        }
    }

    pub fn resize(&self, width: u16, height: u16) {
        if !self.stopped.load(Ordering::Relaxed) {
            unsafe { orb_resize(self.ptr, width, height) };
        }
    }

    pub fn set_clipboard(&self, text: &str) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(c_text) = CString::new(text) {
            unsafe { orb_set_clipboard(self.ptr, c_text.as_ptr()) };
        }
    }
}
