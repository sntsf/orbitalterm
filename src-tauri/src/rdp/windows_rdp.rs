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
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HOST_CLASS: &str = "OrbRdpHostWnd";

// ── Session handle ────────────────────────────────────────────────────────────

pub struct WindowsRdpSession {
    /// Signals the host loop to stop (hide + kill helper).
    pub stop: Arc<AtomicBool>,
    /// Handle of our WS_POPUP host window, stored as isize for Send.
    pub host_hwnd: Arc<AtomicIsize>,
    /// Current position/size relative to the parent canvas (for reposition).
    pub rel_x:  Arc<AtomicIsize>,
    pub rel_y:  Arc<AtomicIsize>,
    pub width:  Arc<AtomicIsize>,
    pub height: Arc<AtomicIsize>,
    /// Current reference parent (for canvas_to_screen).
    pub parent_hwnd: Arc<AtomicIsize>,
}

// SAFETY: AtomicIsize/AtomicBool are Send+Sync; HWND is only accessed on the host thread.
unsafe impl Send for WindowsRdpSession {}
unsafe impl Sync for WindowsRdpSession {}

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
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

// ── Screen positioning ────────────────────────────────────────────────────────

fn canvas_to_screen(parent: HWND, rel_x: i32, rel_y: i32) -> (i32, i32) {
    unsafe {
        let mut r = RECT::default();
        let _ = GetWindowRect(parent, &mut r);
        (r.left + rel_x, r.top + rel_y)
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
    let rel_x  = params.x;
    let rel_y  = params.y;
    let mut last_parent_rect = RECT::default();
    let mut ever_connected = false;
    let mut visible = false;

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

            // Show window once connected
            if session.connected.load(Ordering::SeqCst) && !visible {
                visible = true;
                ever_connected = true;
                ShowWindow(host_hwnd, SW_SHOW);
            }

            // Follow parent window movement
            let mut cur = RECT::default();
            let _ = GetWindowRect(parent, &mut cur);
            if cur.left != last_parent_rect.left || cur.top != last_parent_rect.top {
                let (sx, sy) = canvas_to_screen(parent, rel_x, rel_y);
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
    connected:   Arc<AtomicBool>,
    finished:    Arc<AtomicBool>,
    stop:        Arc<AtomicBool>,
    host_hwnd:   Arc<AtomicIsize>,
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
        connected: Arc::new(AtomicBool::new(false)),
        finished:  Arc::new(AtomicBool::new(false)),
        stop:      Arc::new(AtomicBool::new(false)),
        host_hwnd: Arc::new(AtomicIsize::new(0)),
    });

    let session = WindowsRdpSession {
        stop:        Arc::clone(&shared.stop),
        host_hwnd:   Arc::clone(&shared.host_hwnd),
        parent_hwnd: Arc::new(AtomicIsize::new(parent_hwnd.0 as isize)),
        rel_x:       Arc::new(AtomicIsize::new(x as isize)),
        rel_y:       Arc::new(AtomicIsize::new(y as isize)),
        width:       Arc::new(AtomicIsize::new(width as isize)),
        height:      Arc::new(AtomicIsize::new(height as isize)),
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

    let hwnd_raw = session.host_hwnd.load(Ordering::Relaxed);
    if hwnd_raw == 0 { return; }
    let host = HWND(hwnd_raw as *mut _);
    let parent = HWND(session.parent_hwnd.load(Ordering::Relaxed) as *mut _);
    let (sx, sy) = canvas_to_screen(parent, x, y);
    unsafe {
        let _ = SetWindowPos(host, None, sx, sy, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

pub fn show(session: &WindowsRdpSession) {
    let hwnd_raw = session.host_hwnd.load(Ordering::Relaxed);
    if hwnd_raw == 0 { return; }
    unsafe { ShowWindow(HWND(hwnd_raw as *mut _), SW_SHOW); }
}

pub fn hide(session: &WindowsRdpSession) {
    let hwnd_raw = session.host_hwnd.load(Ordering::Relaxed);
    if hwnd_raw == 0 { return; }
    unsafe { ShowWindow(HWND(hwnd_raw as *mut _), SW_HIDE); }
}

pub fn reparent(session: &WindowsRdpSession, new_parent: HWND, rel_x: i32, rel_y: i32, width: i32, height: i32) {
    session.parent_hwnd.store(new_parent.0 as isize, Ordering::Relaxed);
    reposition(session, rel_x, rel_y, width, height);
}
