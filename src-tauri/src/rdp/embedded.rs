#![cfg(target_os = "linux")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{self, SyncSender};
use tauri::{AppHandle, Emitter};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::protocol::xtest::ConnectionExt as XTestExt;
use x11rb::rust_connection::RustConnection;

pub enum InputEvent {
    Mouse { event_type: u8, button: u8, x: i16, y: i16 },
    Key { pressed: bool, key: String },
}

pub struct EmbeddedSession {
    pub display: String,
    pub width: u16,
    pub height: u16,
    pub dims: Arc<Mutex<(u16, u16)>>,
    pub stop: Arc<AtomicBool>,
    /// Channel to the dedicated input thread — send() is instant and never
    /// blocks the async runtime; all X11 I/O stays on that thread.
    pub input_tx: SyncSender<InputEvent>,
    xvfb: std::process::Child,
    xfreerdp: Arc<Mutex<std::process::Child>>,
}

impl Drop for EmbeddedSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let mut proc = self.xfreerdp.lock().unwrap();
        // SIGTERM first so xfreerdp3 can send a proper RDP Disconnect PDU to
        // the server. Without this, Windows leaves a ghost disconnected session
        // that causes ERRINFO_RPC_INITIATED_DISCONNECT on the next connect.
        let _ = std::process::Command::new("kill")
            .args(["-s", "TERM", &proc.id().to_string()])
            .status();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        while proc.try_wait().ok().flatten().is_none() {
            if std::time::Instant::now() >= deadline {
                proc.kill().ok();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        drop(proc);
        self.xvfb.kill().ok();
    }
}

/// All parameters needed to spawn xfreerdp3, kept so the monitor thread
/// can restart with /admin without going back through the frontend.
#[derive(Clone)]
struct ConnParams {
    host: String,
    port: i64,
    clean_user: String,
    effective_domain: String,
    domain_is_ip: bool,
    domain_is_hostname: bool,
    password: String,
    width: u16,
    height: u16,
}

fn spawn_xfreerdp(
    params: &ConnParams,
    display: &str,
    log_path: &str,
    admin_mode: bool,
) -> Result<std::process::Child, String> {
    let log_file = std::fs::File::create(log_path).map_err(|e| e.to_string())?;
    let log_file2 = log_file.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = std::process::Command::new("xfreerdp3");
    cmd.env("DISPLAY", display);
    cmd.env_remove("WAYLAND_DISPLAY");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(log_file2);
    cmd.stderr(log_file);

    cmd.arg(format!("/v:{}:{}", params.host, params.port));
    cmd.arg(format!("/u:{}", params.clean_user));

    if params.domain_is_ip {
        let krb5_conf = "/tmp/orbitalterm-nokrb.conf";
        let _ = std::fs::write(krb5_conf,
            "[libdefaults]\n    dns_lookup_kdc = false\n    dns_lookup_realm = false\n");
        cmd.env("KRB5_CONFIG", krb5_conf);
    } else if params.domain_is_hostname {
        cmd.arg(format!("/d:{}", params.effective_domain));
        let krb5_conf = "/tmp/orbitalterm-nokrb.conf";
        let _ = std::fs::write(krb5_conf,
            "[libdefaults]\n    dns_lookup_kdc = false\n    dns_lookup_realm = false\n");
        cmd.env("KRB5_CONFIG", krb5_conf);
    } else if !params.effective_domain.is_empty() {
        cmd.arg(format!("/d:{}", params.effective_domain));
    }

    cmd.arg(format!("/p:{}", params.password));
    cmd.arg(format!("/w:{}", params.width));
    cmd.arg(format!("/h:{}", params.height));
    cmd.arg("/cert:ignore");
    cmd.arg("/gdi:sw");
    cmd.arg("/bpp:32");
    cmd.arg("+clipboard");
    if admin_mode {
        cmd.arg("/admin");
    }

    cmd.spawn().map_err(|e| format!("Failed to launch xfreerdp3: {e}"))
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
    admin_mode: bool,
) -> Result<EmbeddedSession, String> {
    // Embedded mode can't show interactive prompts — require a saved password
    let password = match password {
        Some(p) => p,
        None => return Err(
            "NO_PASSWORD\nNo hay contraseña guardada para esta conexión.\n\
             Seleccioná la conexión → Propiedades → ingresá y guardá la contraseña."
                .to_string(),
        ),
    };

    let display_num = find_free_display_num();
    let display = format!(":{}", display_num);

    // Start Xvfb at 4K so resize never exceeds the virtual framebuffer.
    let mut xvfb = std::process::Command::new("Xvfb")
        .arg(&display)
        .arg("-screen").arg("0")
        .arg("3840x2160x24")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("NO_XVFB\nXvfb no encontrado: {e}\nInstalar con: sudo apt install xvfb"))?;

    std::thread::sleep(std::time::Duration::from_millis(400));

    // .\username means "local account on this machine" — strip the prefix and
    // omit /d: so xfreerdp3 authenticates via NTLM without a domain.
    let (clean_user, effective_domain) = if username.starts_with(".\\") || username.starts_with("./") {
        (username[2..].to_string(), String::new())
    } else {
        (username.to_string(), domain.to_string())
    };

    let domain_is_ip = !effective_domain.is_empty()
        && effective_domain.chars().all(|c| c.is_ascii_digit() || c == '.');
    let domain_is_hostname = !effective_domain.is_empty()
        && !effective_domain.contains('.')
        && !domain_is_ip;

    let params = ConnParams {
        host: host.to_string(),
        port,
        clean_user,
        effective_domain,
        domain_is_ip,
        domain_is_hostname,
        password: password.to_string(),
        width,
        height,
    };

    let log_path = format!("/tmp/orbitalterm-rdp-{}.log", session_id);
    let mut xfreerdp = spawn_xfreerdp(&params, &display, &log_path, admin_mode)
        .map_err(|e| { xvfb.kill().ok(); e })?;

    // Wait for initial auth, then verify xfreerdp3 is still alive
    std::thread::sleep(std::time::Duration::from_millis(1200));

    if let Ok(Some(exit_status)) = xfreerdp.try_wait() {
        let detail = read_log_tail(&log_path, 5);
        std::fs::remove_file(&log_path).ok();
        xvfb.kill().ok();

        return Err(format!(
            "xfreerdp3 cerró inmediatamente (código {}).\nVerificá:\n\
            • Credenciales correctas (guardá la contraseña en Propiedades)\n\
            • RDP habilitado en el servidor\n\
            • Firewall permite el puerto {}{}",
            exit_status.code().unwrap_or(-1),
            port,
            if !detail.is_empty() { format!("\n\nDetalle:\n{detail}") } else { String::new() }
        ));
    }

    // Dedicated input thread: owns its own X11 connection so it never
    // competes with the frame-capture thread or blocks the async runtime.
    // The async command handlers just try_send() and return immediately.
    let (input_tx, input_rx) = mpsc::sync_channel::<InputEvent>(256);
    let input_display = display.clone();
    std::thread::spawn(move || {
        let (conn, screen_num) = match RustConnection::connect(Some(&input_display)) {
            Ok(r) => r,
            Err(e) => { eprintln!("rdp input thread: x11rb connect: {e}"); return; }
        };
        let root = conn.setup().roots[screen_num].root;
        let kb_map: HashMap<u32, u8> = match conn
            .get_keyboard_mapping(8u8, 248u8)
            .ok()
            .and_then(|c| c.reply().ok())
        {
            Some(m) => {
                let per = m.keysyms_per_keycode as usize;
                m.keysyms.chunks(per).enumerate()
                    .flat_map(|(i, syms)| {
                        syms.iter().filter(|&&s| s != 0).map(move |&s| (s, (i as u8) + 8))
                    })
                    .collect()
            }
            None => { eprintln!("rdp input thread: get_keyboard_mapping failed"); return; }
        };

        while let Ok(ev) = input_rx.recv() {
            match ev {
                InputEvent::Mouse { event_type, button, x, y } => {
                    let _ = conn.xtest_fake_input(event_type, button, 0, root, x, y, 0);
                    let _ = conn.flush();
                }
                InputEvent::Key { pressed, key } => {
                    if let Some(ks) = js_key_to_keysym(&key) {
                        if let Some(&kc) = kb_map.get(&ks) {
                            let ev_type = if pressed { 2u8 } else { 3u8 };
                            let _ = conn.xtest_fake_input(ev_type, kc, 0, root, 0, 0, 0);
                            let _ = conn.flush();
                        }
                    }
                }
            }
        }
        // Sender dropped (session ended) → loop exits, thread terminates.
    });

    let xfreerdp = Arc::new(Mutex::new(xfreerdp));
    let xfreerdp_thread = Arc::clone(&xfreerdp);

    let dims = Arc::new(Mutex::new((width, height)));
    let dims_thread = Arc::clone(&dims);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    let sid = session_id.to_string();
    let disp_clone = display.clone();
    let log_path_thread = log_path.clone();
    let params_thread = params.clone();
    let initial_admin_mode = admin_mode;

    // Clipboard bridge: sync between the user's real display and the Xvfb virtual display.
    // xfreerdp3 (with +clipboard) bridges Xvfb X11 clipboard ↔ Windows RDP clipboard.
    // This thread bridges Linux real clipboard ↔ Xvfb X11 clipboard.
    // Requires: xclip (for Xvfb reads/writes) and wl-paste/wl-copy or xclip (for Linux clipboard).
    let stop_cb = Arc::clone(&stop);
    start_clipboard_bridge(display.clone(), stop_cb);

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));

        let (conn, screen_num) = match RustConnection::connect(Some(&disp_clone)) {
            Ok(r) => r,
            Err(e) => { eprintln!("x11rb connect: {e}"); return; }
        };
        let root = conn.setup().roots[screen_num].root;

        let mut keepalive_tick: u32 = 0;
        let mut session_start = std::time::Instant::now();
        let mut current_log = log_path_thread;
        let mut admin_retried = initial_admin_mode; // if already admin, no retry needed

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }

            // Detect xfreerdp3 exit via try_wait (avoids zombie false-positive from /proc check)
            match xfreerdp_thread.lock().unwrap().try_wait() {
                Ok(Some(status)) => {
                    let elapsed = session_start.elapsed().as_secs();
                    let is_conflict = detect_session_conflict(&current_log, elapsed);

                    // Auto-retry with /admin once, entirely within the backend.
                    // The canvas briefly goes black and then resumes — no frontend
                    // involvement means no React closure or infinite-loop risk.
                    if is_conflict && !admin_retried {
                        admin_retried = true;
                        std::fs::remove_file(&current_log).ok();
                        let new_log = format!("{}.admin", current_log);
                        match spawn_xfreerdp(&params_thread, &disp_clone, &new_log, true) {
                            Ok(new_proc) => {
                                *xfreerdp_thread.lock().unwrap() = new_proc;
                                current_log = new_log;
                                session_start = std::time::Instant::now();
                                // Give new process a moment to start before resuming loop
                                std::thread::sleep(std::time::Duration::from_millis(800));
                                continue;
                            }
                            Err(e) => {
                                app.emit(&format!("rdp-error-{sid}"),
                                    format!("No se pudo iniciar sesión admin: {e}")).ok();
                                break;
                            }
                        }
                    }

                    let detail = read_log_tail(&current_log, 20);
                    std::fs::remove_file(&current_log).ok();
                    let code = status.code().unwrap_or(-1);
                    let msg = if detail.is_empty() {
                        format!("La sesión RDP terminó (código {code}).")
                    } else {
                        format!("La sesión RDP terminó (código {code}).\n\n{detail}")
                    };
                    app.emit(&format!("rdp-error-{sid}"), msg).ok();
                    break;
                }
                Err(_) => {
                    std::fs::remove_file(&current_log).ok();
                    app.emit(&format!("rdp-error-{sid}"), "La sesión RDP terminó inesperadamente.").ok();
                    break;
                }
                Ok(None) => {}
            }

            let (cw, ch) = *dims_thread.lock().unwrap();
            if let Ok(b64) = capture_frame_b64(&conn, root, cw, ch) {
                app.emit(&format!("rdp-frame-{sid}"), b64).ok();
            }

            // Keepalive: inject a 1px mouse jitter every ~3s so Windows
            // does not consider the session idle and disconnect it.
            keepalive_tick += 1;
            if keepalive_tick >= 75 {
                keepalive_tick = 0;
                let _ = conn.xtest_fake_input(6, 0, 0, root, 1, 1, 0);
                let _ = conn.xtest_fake_input(6, 0, 0, root, 0, 0, 0);
                let _ = conn.flush();
            }

            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });

    Ok(EmbeddedSession { display, width, height, dims, stop, input_tx, xvfb, xfreerdp })
}

pub fn resize(display: &str, dims: &Arc<Mutex<(u16, u16)>>, width: u16, height: u16) -> Result<(), String> {
    *dims.lock().unwrap() = (width, height);

    let (conn, screen_num) = RustConnection::connect(Some(display)).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[screen_num].root;

    let tree = conn.query_tree(root).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    for &child in &tree.children {
        conn.configure_window(child, &ConfigureWindowAux::new()
            .x(0).y(0)
            .width(width as u32)
            .height(height as u32))
            .ok();
    }
    conn.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn detect_session_conflict(log_path: &str, elapsed_secs: u64) -> bool {
    let log = std::fs::read_to_string(log_path).unwrap_or_default();
    // Case 1: explicit session-continue + RPC disconnect (existing user denied takeover).
    let explicit = (log.contains("LOGON_MSG_SESSION_CONTINUE")
        || log.contains("LOGON_TYPE_RECONNECT"))
        && (log.contains("ERRINFO_RPC_INITIATED_DISCONNECT")
            || log.contains("ERRINFO_DISCONNECTED_BY_OTHER_CONNECTION")
            || log.contains("ERRINFO_SESSION_TAKEN_OVER"));
    // Case 2: RPC-initiated disconnect within the first 20 s without a
    // user-visible reason — almost always a ghost/conflicting session on
    // Windows workstations. Using /admin bypasses this.
    let fast_rpc = elapsed_secs < 20
        && log.contains("ERRINFO_RPC_INITIATED_DISCONNECT")
        && !log.contains("ERRINFO_LOGOFF_BY_USER");
    explicit || fast_rpc
}

fn read_log_tail(path: &str, max_lines: usize) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn find_free_display_num() -> u32 {
    (100u32..200)
        .find(|n| !std::path::Path::new(&format!("/tmp/.X{}-lock", n)).exists())
        .unwrap_or(100)
}

fn capture_frame_b64(conn: &RustConnection, root: u32, width: u16, height: u16) -> Result<String, String> {
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root, 0, 0, width, height, u32::MAX)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;

    let raw = &reply.data;
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for px in raw.chunks(4) {
        if px.len() == 4 {
            rgb.push(px[2]); // R (Xvfb stores BGRX)
            rgb.push(px[1]); // G
            rgb.push(px[0]); // B
        }
    }

    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 80)
        .encode(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;

    Ok(BASE64.encode(&out))
}


fn js_key_to_keysym(key: &str) -> Option<u32> {
    Some(match key {
        " " => 0x0020,
        "Enter" => 0xff0d,
        "BackSpace" => 0xff08,
        "Tab" => 0xff09,
        "Escape" => 0xff1b,
        "Delete" => 0xffff,
        "Insert" => 0xff63,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "F1"  => 0xffbe, "F2"  => 0xffbf, "F3"  => 0xffc0, "F4"  => 0xffc1,
        "F5"  => 0xffc2, "F6"  => 0xffc3, "F7"  => 0xffc4, "F8"  => 0xffc5,
        "F9"  => 0xffc6, "F10" => 0xffc7, "F11" => 0xffc8, "F12" => 0xffc9,
        "Control" | "ControlLeft" | "ControlRight" => 0xffe3,
        "Alt" | "AltLeft" => 0xffe9,
        "AltRight" => 0xffea,
        "Shift" | "ShiftLeft" | "ShiftRight" => 0xffe1,
        "Meta" | "Super" | "MetaLeft" | "MetaRight" => 0xffeb,
        "CapsLock" => 0xffe5,
        "NumLock" => 0xff7f,
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => c as u32,
                _ => return None,
            }
        }
    })
}

// ── Clipboard bridge ──────────────────────────────────────────────────────────
//
// Two-direction clipboard support:
//   Linux → Windows: handled on-demand via rdp_set_clipboard called from the
//                    frontend when the user presses Ctrl+V in the canvas.
//   Windows → Linux: polled every 500 ms; xfreerdp3 (+clipboard / cliprdr)
//                    writes Windows clipboard to Xvfb X11 clipboard automatically.
//
// Requirements: sudo apt install xclip wl-clipboard

/// Set the clipboard on the Xvfb virtual display so xfreerdp3's cliprdr
/// can offer the content to Windows. Called just before Ctrl+V is forwarded.
pub fn set_clipboard(display: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut c = std::process::Command::new("xclip")
        .args(["-display", display, "-selection", "clipboard", "-loops", "-1"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "xclip not found — run: sudo apt install xclip".to_string())?;
    if let Some(mut s) = c.stdin.take() {
        s.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    // Don't wait — xclip stays alive on the Xvfb display serving clipboard
    // requests until Xvfb is killed at session end (which cleans it up).
    Ok(())
}

/// Read the user's real Linux clipboard (Wayland or X11/XWayland).
pub fn read_linux_clipboard() -> Option<String> {
    // Prefer wl-paste (Wayland-native)
    let out = std::process::Command::new("wl-paste")
        .args(["--no-newline", "--type", "text/plain"])
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            if let Ok(s) = String::from_utf8(o.stdout) {
                if !s.is_empty() { return Some(s); }
            }
        }
    }
    // Fallback: xclip on the user's real X11/XWayland DISPLAY
    let display = std::env::var("DISPLAY").unwrap_or_default();
    if display.is_empty() { return None; }
    let out = std::process::Command::new("xclip")
        .args(["-display", &display, "-selection", "clipboard", "-o"])
        .stderr(std::process::Stdio::null())
        .output().ok()?;
    if out.status.success() { String::from_utf8(out.stdout).ok() } else { None }
}

fn start_clipboard_bridge(xvfb_display: String, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_xvfb = String::new();

        loop {
            if stop.load(Ordering::Relaxed) { break; }

            // Windows → Linux: xfreerdp3 cliprdr puts Windows clipboard into Xvfb.
            // We poll it here and push to the real display so the user can paste
            // in Linux apps after copying something in the Windows session.
            if let Some(cur) = read_xvfb_clipboard(&xvfb_display) {
                if !cur.is_empty() && cur != last_xvfb {
                    write_linux_clipboard(&cur);
                    last_xvfb = cur;
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

fn write_linux_clipboard(text: &str) {
    use std::io::Write;
    if let Ok(mut c) = std::process::Command::new("wl-copy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        if let Some(mut s) = c.stdin.take() { let _ = s.write_all(text.as_bytes()); }
        return;
    }
    let display = std::env::var("DISPLAY").unwrap_or_default();
    if display.is_empty() { return; }
    if let Ok(mut c) = std::process::Command::new("xclip")
        .args(["-display", &display, "-selection", "clipboard"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        if let Some(mut s) = c.stdin.take() { let _ = s.write_all(text.as_bytes()); }
        let _ = c.wait();
    }
}

fn read_xvfb_clipboard(display: &str) -> Option<String> {
    let out = std::process::Command::new("xclip")
        .args(["-display", display, "-selection", "clipboard", "-o"])
        .stderr(std::process::Stdio::null())
        .output().ok()?;
    if out.status.success() { String::from_utf8(out.stdout).ok() } else { None }
}
