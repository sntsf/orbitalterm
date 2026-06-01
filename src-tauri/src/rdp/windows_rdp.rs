#![cfg(target_os = "windows")]

//! Embedded RDP on Windows using Win32 window reparenting.
//!
//! mstsc.exe is launched, its main HWND is located by PID and window class,
//! then reparented as a child of the Tauri top-level window.  The window is
//! stripped of chrome and positioned over the RDP canvas area reported by the
//! frontend.  This gives a fully embedded experience identical to mRemoteNG.

use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::BOOL;

// ── Session ───────────────────────────────────────────────────────────────────

pub struct WindowsRdpSession {
    pub child: std::process::Child,
    pub mstsc_hwnd: isize, // HWND stored as isize for Send/Sync
}

// SAFETY: we only access mstsc_hwnd from the Tauri command thread under Mutex
unsafe impl Send for WindowsRdpSession {}
unsafe impl Sync for WindowsRdpSession {}

impl Drop for WindowsRdpSession {
    fn drop(&mut self) {
        unsafe {
            let hwnd = HWND(self.mstsc_hwnd as *mut _);
            // Hide before reparenting back to avoid flicker on close
            let _ = ShowWindow(hwnd, SW_HIDE);
            // Detach from Tauri parent so mstsc can clean up its own HWND
            let _ = SetParent(hwnd, None);
        }
        let _ = self.child.kill();
    }
}

// ── HWND search ───────────────────────────────────────────────────────────────

struct FindData {
    target_pid: u32,
    result: Option<HWND>,
}

unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let data = &mut *(lparam.0 as *mut FindData);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != data.target_pid {
        return BOOL(1);
    }
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if class == "TscShellContainerClass" {
            data.result = Some(hwnd);
            return BOOL(0); // stop enumeration
        }
    }
    BOOL(1)
}

/// Poll until mstsc's main window appears or `timeout_ms` elapses.
fn find_mstsc_hwnd(pid: u32, timeout_ms: u64) -> Option<HWND> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let mut data = FindData { target_pid: pid, result: None };
        unsafe {
            let _ = EnumWindows(Some(enum_windows_cb), LPARAM(&mut data as *mut _ as isize));
        }
        if let Some(h) = data.result {
            return Some(h);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Launch mstsc.exe and embed its window inside `parent_hwnd`.
///
/// `x`, `y` are window-relative coordinates of the top-left corner of the RDP
/// canvas area reported by the frontend.  `width`/`height` match the canvas.
pub fn launch(
    parent_hwnd: HWND,
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    admin_mode: bool,
) -> Result<WindowsRdpSession, String> {
    // Pre-store credentials so mstsc auto-connects without a password dialog
    if let Some(p) = password {
        let _ = std::process::Command::new("cmdkey")
            .args([
                &format!("/add:{}", host),
                &format!("/user:{}", username),
                &format!("/pass:{}", p),
            ])
            .status();
    }

    let mut cmd = std::process::Command::new("mstsc.exe");
    cmd.arg(format!("/v:{}:{}", host, port));
    cmd.arg(format!("/w:{}", width.max(640)));
    cmd.arg(format!("/h:{}", height.max(480)));
    if admin_mode {
        cmd.arg("/admin");
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to launch mstsc: {e}"))?;
    let pid = child.id();

    let mstsc_hwnd = find_mstsc_hwnd(pid, 10_000)
        .ok_or_else(|| "Timeout: mstsc window did not appear within 10 s".to_string())?;

    unsafe {
        // Strip decorations and add WS_CHILD
        let style = GetWindowLongW(mstsc_hwnd, GWL_STYLE);
        let new_style = (style
            & !(WS_CAPTION.0 as i32
                | WS_THICKFRAME.0 as i32
                | WS_MINIMIZEBOX.0 as i32
                | WS_MAXIMIZEBOX.0 as i32
                | WS_SYSMENU.0 as i32))
            | WS_CHILD.0 as i32;
        SetWindowLongW(mstsc_hwnd, GWL_STYLE, new_style);

        // Remove WS_EX_APPWINDOW so it disappears from the taskbar
        let ex_style = GetWindowLongW(mstsc_hwnd, GWL_EXSTYLE);
        SetWindowLongW(mstsc_hwnd, GWL_EXSTYLE, ex_style & !(WS_EX_APPWINDOW.0 as i32));

        // Reparent into the Tauri window
        SetParent(mstsc_hwnd, Some(parent_hwnd))
            .map_err(|e| format!("SetParent failed: {e}"))?;

        // Position above the WebView2 child, flush chrome changes
        let _ = SetWindowPos(
            mstsc_hwnd,
            Some(HWND_TOP),
            x,
            y,
            width,
            height,
            SWP_SHOWWINDOW | SWP_FRAMECHANGED,
        );
    }

    Ok(WindowsRdpSession {
        child,
        mstsc_hwnd: mstsc_hwnd.0 as isize,
    })
}

/// Move and resize the embedded mstsc window (called on canvas resize / tab switch).
pub fn reposition(session: &WindowsRdpSession, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        let hwnd = HWND(session.mstsc_hwnd as *mut _);
        let _ = SetWindowPos(hwnd, Some(HWND_TOP), x, y, width, height, SWP_SHOWWINDOW);
    }
}

pub fn show(session: &WindowsRdpSession) {
    unsafe {
        let hwnd = HWND(session.mstsc_hwnd as *mut _);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    }
}

pub fn hide(session: &WindowsRdpSession) {
    unsafe {
        let _ = ShowWindow(HWND(session.mstsc_hwnd as *mut _), SW_HIDE);
    }
}
