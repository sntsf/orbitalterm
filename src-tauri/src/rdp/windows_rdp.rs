#![cfg(target_os = "windows")]

//! Embedded RDP on Windows by spawning OrbitalRdpHost.exe (C# WinForms + mstscax ActiveX).
//!
//! ## Z-order and WebView2
//! WebView2 renders via DirectComposition (DComp). Traditional WS_CHILD windows exist in the
//! Win32 z-order which lies BELOW the DComp layer — they appear as black rectangles. The fix is
//! a WS_POPUP window owned by the Tauri window so it floats above DComp while still allowing
//! other apps to come to the foreground. OrbitalRdpHost.exe reparents its own window into this
//! host popup via --parent <HWND>.

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;
use windows::Win32::Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, RGN_DIFF};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HOST_CLASS: &str = "OrbRdpHostWnd";

// ── Session handle ────────────────────────────────────────────────────────────

pub struct WindowsRdpSession {
    pub stop:          Arc<AtomicBool>,
    pub host_hwnd:     Arc<AtomicIsize>,
    pub parent_hwnd:   Arc<AtomicIsize>,
    pub rel_x:         Arc<AtomicIsize>,
    pub rel_y:         Arc<AtomicIsize>,
    pub width:         Arc<AtomicIsize>,
    pub height:        Arc<AtomicIsize>,
    /// Desired visibility — written by show()/hide(), read by the host thread.
    /// ShowWindow is always called from the host thread that owns the window.
    pub wants_visible:      Arc<AtomicBool>,
    pub reposition_pending: Arc<AtomicBool>,
}

// SAFETY: AtomicIsize/AtomicBool are Send+Sync; HWND is only accessed on the host thread.
unsafe impl Send for WindowsRdpSession {}
unsafe impl Sync for WindowsRdpSession {}

impl Drop for WindowsRdpSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

// ── Window class ──────────────────────────────────────────────────────────────

fn register_host_class(hinstance: windows::Win32::Foundation::HINSTANCE) {
    unsafe {
        let class_name: Vec<u16> = HOST_CLASS.encode_utf16().chain(std::iter::once(0)).collect();
        let wc = WNDCLASSEXW {
            cbSize:        std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc:   Some(host_wnd_proc),
            hInstance:     hinstance,
            lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassExW(&wc);
    }
}

unsafe extern "system" fn host_wnd_proc(
    hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM,
) -> LRESULT {
    match msg {
        WM_DESTROY => { PostQuitMessage(0); LRESULT(0) }
        WM_SETFOCUS => {
            // Cascade focus to the WinForms/mstscax child so keyboard input reaches the RDP session.
            if let Ok(child) = GetWindow(hwnd, GW_CHILD) {
                if !child.0.is_null() { let _ = SetFocus(Some(child)); }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

// ── Screen positioning ────────────────────────────────────────────────────────

fn canvas_to_screen(parent: HWND, rel_x: i32, rel_y: i32) -> (i32, i32) {
    // getBoundingClientRect() returns coords relative to the WebView2 client area.
    // We must convert from client-area origin to screen by accounting for the
    // non-client area (title bar + borders). GetWindowRect gives the outer bounds;
    // GetClientRect gives the client size (always 0-based). The difference is the
    // non-client offsets on each side.
    unsafe {
        let mut wr = RECT::default();
        let mut cr = RECT::default();
        let _ = GetWindowRect(parent, &mut wr);
        let _ = GetClientRect(parent, &mut cr);
        // Horizontal border is symmetric; vertical non-client area = title + top border.
        let nc_x = ((wr.right - wr.left) - cr.right) / 2;
        let nc_y = ((wr.bottom - wr.top) - cr.bottom - nc_x).max(0);
        (wr.left + nc_x + rel_x, wr.top + nc_y + rel_y)
    }
}

// ── Helper binary lookup ──────────────────────────────────────────────────────

fn find_helper_exe() -> Option<std::path::PathBuf> {
    // 1. Env override
    if let Ok(p) = std::env::var("ORBITAL_RDP_HOST") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    // 2. Alongside our own exe (packaged: <app>/OrbitalRdpHost.exe)
    if let Ok(mut p) = std::env::current_exe() {
        p.pop();
        p.push("OrbitalRdpHost.exe");
        if p.exists() { return Some(p); }
    }
    // 3. Tauri resources dir (packaged: <app>/resources/OrbitalRdpHost.exe)
    if let Ok(mut p) = std::env::current_exe() {
        p.pop();
        p.push("resources");
        p.push("OrbitalRdpHost.exe");
        if p.exists() { return Some(p); }
    }
    // 4. Dev: exe is at src-tauri/target/debug/orbitalterm.exe → go up 3 dirs
    if let Ok(mut p) = std::env::current_exe() {
        p.pop(); p.pop(); p.pop(); // debug/ → target/ → src-tauri/
        p.pop();                    // src-tauri/ → project root
        p.push("csharp-rdp-host");
        p.push("OrbitalRdpHost.exe");
        if p.exists() { return Some(p); }
    }
    // 5. CWD is project root (tauri dev from root)
    if let Ok(mut p) = std::env::current_dir() {
        p.push("csharp-rdp-host");
        p.push("OrbitalRdpHost.exe");
        if p.exists() { return Some(p); }
    }
    // 6. CWD is src-tauri/ → go up one
    if let Ok(mut p) = std::env::current_dir() {
        p.pop();
        p.push("csharp-rdp-host");
        p.push("OrbitalRdpHost.exe");
        if p.exists() { return Some(p); }
    }
    None
}

// ── Launch params ─────────────────────────────────────────────────────────────

struct LaunchParams {
    app:        tauri::AppHandle,
    session_id: String,
    parent_hwnd: isize,
    host:       String,
    port:       u16,
    username:   String,
    domain:     String,
    password:   Option<String>,
    x: i32, y: i32, width: i32, height: i32,
    admin_mode: bool,
    rdp_security: String,
    _color_depth: i32,
}

// ── Host thread ───────────────────────────────────────────────────────────────

fn host_thread(params: LaunchParams, session: Arc<SessionShared>) {
    let exe = match find_helper_exe() {
        Some(p) => p,
        None => {
            eprintln!("[rdp] OrbitalRdpHost.exe not found");
            session.finished.store(true, Ordering::SeqCst);
            return;
        }
    };

    // Build user arg: "domain\user" if domain present, else just user
    let user_arg = if params.domain.is_empty() {
        params.username.clone()
    } else {
        format!("{}\\{}", params.domain, params.username)
    };

    // Create WS_POPUP host window (must exist before spawning helper so we have an HWND)
    let host_hwnd = unsafe {
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        register_host_class(HINSTANCE(hmod.0));

        let class_name: Vec<u16> = HOST_CLASS.encode_utf16().chain(std::iter::once(0)).collect();
        let parent = HWND(params.parent_hwnd as *mut _);
        let (sx, sy) = canvas_to_screen(parent, params.x, params.y);

        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::PCWSTR(class_name.as_ptr()),
            windows::core::PCWSTR(std::ptr::null()),
            WS_POPUP | WS_VISIBLE,
            sx, sy, params.width, params.height,
            Some(parent), // owner (not parent — keeps it above DComp)
            None, Some(HINSTANCE(hmod.0)), None,
        ).unwrap_or(HWND(std::ptr::null_mut()))
    };

    if host_hwnd.0.is_null() {
        eprintln!("[rdp] CreateWindowExW failed");
        session.finished.store(true, Ordering::SeqCst);
        return;
    }

    session.host_hwnd.store(host_hwnd.0 as isize, Ordering::Relaxed);

    // Spawn the C# helper, embedding its window inside our popup
    let mut cmd = Command::new(&exe);
    cmd.arg("--parent").arg((host_hwnd.0 as isize).to_string())
       .arg("--server").arg(&params.host)
       .arg("--port").arg(params.port.to_string())
       .arg("--user").arg(&user_arg)
       .arg("--width").arg(params.width.to_string())
       .arg("--height").arg(params.height.to_string())
       .arg("--security").arg(&params.rdp_security);
    if params.admin_mode { cmd.arg("--admin"); }
    cmd.stdin(Stdio::piped())
       .stdout(Stdio::piped())
       .stderr(Stdio::null())
       .creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[rdp] failed to spawn helper: {e}");
            session.finished.store(true, Ordering::SeqCst);
            unsafe { let _ = DestroyWindow(host_hwnd); }
            return;
        }
    };

    // Send password via stdin
    if let Some(mut stdin) = child.stdin.take() {
        let pw = params.password.clone().unwrap_or_default();
        let _ = writeln!(stdin, "{pw}");
    }

    // Background thread: read STATE: lines from helper stdout
    let connected  = Arc::clone(&session.connected);
    let finished   = Arc::clone(&session.finished);
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().flatten() {
                if line.contains("STATE:connected") || line.contains("OnLoginComplete") {
                    connected.store(true, Ordering::SeqCst);
                }
                if line.contains("STATE:disconnected") || line.starts_with("ERROR:") {
                    finished.store(true, Ordering::SeqCst);
                }
            }
            finished.store(true, Ordering::SeqCst);
        });
    }

    // ── Host event loop ───────────────────────────────────────────────────────
    let parent = HWND(params.parent_hwnd as *mut _);
    let mut last_parent_rect = RECT::default();
    let mut ever_connected = false;
    let mut cur_visible = false; // tracks actual SW state so we only call ShowWindow on change

    unsafe {
        ShowWindow(host_hwnd, SW_HIDE);

        let mut msg = MSG::default();
        loop {
            // Drain Win32 messages
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break; }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if session.stop.load(Ordering::SeqCst)
                || session.finished.load(Ordering::SeqCst)
            {
                break;
            }

            // Auto-show on first connection by setting wants_visible.
            // After that, wants_visible is driven entirely by show()/hide().
            if session.connected.load(Ordering::SeqCst) && !ever_connected {
                ever_connected = true;
                session.wants_visible.store(true, Ordering::SeqCst);
            }

            // Apply pending visibility change — always from this owner thread.
            let wants = session.wants_visible.load(Ordering::SeqCst);
            if wants != cur_visible {
                cur_visible = wants;
                if wants {
                    ShowWindow(host_hwnd, SW_SHOW);
                    // Transfer the foreground to the RDP popup so the OS routes keyboard
                    // input to its thread.  SetFocus alone doesn't work from a non-foreground
                    // thread; SetForegroundWindow is required first.  This process owns the
                    // Tauri window (the current foreground), so the call is allowed.
                    // WM_SETFOCUS will be delivered to host_wnd_proc which cascades to the
                    // WinForms child; the C# WndProc then focuses the deepest mstscax child.
                    let _ = SetForegroundWindow(host_hwnd);
                } else {
                    ShowWindow(host_hwnd, SW_HIDE);
                    // Return keyboard focus to the Tauri parent window.
                    let _ = SetForegroundWindow(parent);
                }
            }

            // Apply pending reposition — also from owner thread.
            if session.reposition_pending.swap(false, Ordering::SeqCst) {
                let x  = session.rel_x.load(Ordering::Relaxed) as i32;
                let y  = session.rel_y.load(Ordering::Relaxed) as i32;
                let w  = session.width.load(Ordering::Relaxed)  as i32;
                let h  = session.height.load(Ordering::Relaxed) as i32;
                let p  = HWND(session.parent_hwnd.load(Ordering::Relaxed) as *mut _);
                let (sx, sy) = canvas_to_screen(p, x, y);
                let _ = SetWindowPos(host_hwnd, None, sx, sy, w, h,
                    SWP_NOZORDER | SWP_NOACTIVATE);
                last_parent_rect = RECT::default(); // force re-check on next tick
            }

            // Follow parent window movement
            let p = HWND(session.parent_hwnd.load(Ordering::Relaxed) as *mut _);
            let rel_x = session.rel_x.load(Ordering::Relaxed) as i32;
            let rel_y = session.rel_y.load(Ordering::Relaxed) as i32;
            let mut cur = RECT::default();
            let _ = GetWindowRect(p, &mut cur);
            if cur.left != last_parent_rect.left || cur.top != last_parent_rect.top {
                let (sx, sy) = canvas_to_screen(p, rel_x, rel_y);
                let _ = SetWindowPos(host_hwnd, None, sx, sy, 0, 0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                last_parent_rect = cur;
            }

            std::thread::sleep(Duration::from_millis(16));
        }

        // Cleanup
        let _ = child.kill();
        DestroyWindow(host_hwnd).ok();
    }

    if ever_connected {
        params.app.emit(
            &format!("rdp-disconnected-{}", params.session_id),
            (),
        ).ok();
    }

    session.finished.store(true, Ordering::SeqCst);
}

// ── Shared atomics (between host thread and public API) ───────────────────────

struct SessionShared {
    connected:          Arc<AtomicBool>,
    finished:           Arc<AtomicBool>,
    stop:               Arc<AtomicBool>,
    host_hwnd:          Arc<AtomicIsize>,
    parent_hwnd:        Arc<AtomicIsize>,
    rel_x:              Arc<AtomicIsize>,
    rel_y:              Arc<AtomicIsize>,
    width:              Arc<AtomicIsize>,
    height:             Arc<AtomicIsize>,
    wants_visible:      Arc<AtomicBool>,
    reposition_pending: Arc<AtomicBool>,
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn launch(
    app: tauri::AppHandle,
    session_id: &str,
    parent_hwnd: HWND,
    host: &str,
    port: u16,
    username: &str,
    domain: &str,
    password: Option<&str>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    admin_mode: bool,
    rdp_security: &str,
    color_depth: i32,
) -> Result<WindowsRdpSession, String> {
    let shared = Arc::new(SessionShared {
        connected:          Arc::new(AtomicBool::new(false)),
        finished:           Arc::new(AtomicBool::new(false)),
        stop:               Arc::new(AtomicBool::new(false)),
        host_hwnd:          Arc::new(AtomicIsize::new(0)),
        parent_hwnd:        Arc::new(AtomicIsize::new(parent_hwnd.0 as isize)),
        rel_x:              Arc::new(AtomicIsize::new(x as isize)),
        rel_y:              Arc::new(AtomicIsize::new(y as isize)),
        width:              Arc::new(AtomicIsize::new(width as isize)),
        height:             Arc::new(AtomicIsize::new(height as isize)),
        wants_visible:      Arc::new(AtomicBool::new(false)),
        reposition_pending: Arc::new(AtomicBool::new(false)),
    });

    let session = WindowsRdpSession {
        stop:               Arc::clone(&shared.stop),
        host_hwnd:          Arc::clone(&shared.host_hwnd),
        parent_hwnd:        Arc::clone(&shared.parent_hwnd),
        rel_x:              Arc::clone(&shared.rel_x),
        rel_y:              Arc::clone(&shared.rel_y),
        width:              Arc::clone(&shared.width),
        height:             Arc::clone(&shared.height),
        wants_visible:      Arc::clone(&shared.wants_visible),
        reposition_pending: Arc::clone(&shared.reposition_pending),
    };

    let params = LaunchParams {
        app,
        session_id: session_id.to_string(),
        parent_hwnd: parent_hwnd.0 as isize,
        host: host.to_string(),
        port,
        username: username.to_string(),
        domain: domain.to_string(),
        password: password.map(str::to_string),
        x, y, width, height,
        admin_mode,
        rdp_security: rdp_security.to_string(),
        _color_depth: color_depth,
    };

    let shared_thread = Arc::clone(&shared);
    std::thread::spawn(move || host_thread(params, shared_thread));

    Ok(session)
}

pub fn reposition(session: &WindowsRdpSession, x: i32, y: i32, width: i32, height: i32) {
    session.rel_x.store(x as isize, Ordering::Relaxed);
    session.rel_y.store(y as isize, Ordering::Relaxed);
    session.width.store(width as isize, Ordering::Relaxed);
    session.height.store(height as isize, Ordering::Relaxed);
    session.reposition_pending.store(true, Ordering::SeqCst);
}

pub fn show(session: &WindowsRdpSession) {
    session.wants_visible.store(true, Ordering::SeqCst);
}

pub fn hide(session: &WindowsRdpSession) {
    session.wants_visible.store(false, Ordering::SeqCst);
}

pub fn reparent(session: &WindowsRdpSession, new_parent: HWND, rel_x: i32, rel_y: i32, width: i32, height: i32) {
    session.parent_hwnd.store(new_parent.0 as isize, Ordering::Relaxed);
    reposition(session, rel_x, rel_y, width, height);
}

/// Carve a rectangular hole in the WS_POPUP so an HTML menu rendered inside WebView2
/// shows through it.  `menu_rect` is in viewport (WebView2 client-area) coordinates
/// matching `getBoundingClientRect()`.  Pass `None` to restore the full region.
///
/// SetWindowRgn may be called safely from any thread; the region update is immediate.
pub fn set_menu_region(session: &WindowsRdpSession, menu_rect: Option<[i32; 4]>) {
    let host_hwnd = HWND(session.host_hwnd.load(Ordering::Relaxed) as *mut _);
    if host_hwnd.0.is_null() {
        return;
    }
    unsafe {
        match menu_rect {
            None => {
                // NULL region → entire window is visible
                let _ = SetWindowRgn(host_hwnd, None, BOOL(1));
            }
            Some([menu_vp_x, menu_vp_y, menu_vp_w, menu_vp_h]) => {
                let popup_vp_x = session.rel_x.load(Ordering::Relaxed) as i32;
                let popup_vp_y = session.rel_y.load(Ordering::Relaxed) as i32;
                let popup_w    = session.width.load(Ordering::Relaxed) as i32;
                let popup_h    = session.height.load(Ordering::Relaxed) as i32;

                // The nc offsets cancel when computing menu-local coords (both calls to
                // canvas_to_screen add the same nc_x/nc_y), so local coords = vp delta.
                let lx = (menu_vp_x - popup_vp_x).max(0);
                let ly = (menu_vp_y - popup_vp_y).max(0);
                let rx = (lx + menu_vp_w).min(popup_w);
                let by = (ly + menu_vp_h).min(popup_h);

                // Build: full_region MINUS hole_region
                let full = CreateRectRgn(0, 0, popup_w, popup_h);
                let hole = CreateRectRgn(lx, ly, rx, by);
                CombineRgn(full, full, hole, RGN_DIFF);
                // After SetWindowRgn succeeds, the OS owns full_rgn — do NOT delete it.
                let _ = SetWindowRgn(host_hwnd, full, BOOL(1));
                // hole is ours; delete it.
                let _ = DeleteObject(hole.into());
            }
        }
    }
}
