#![cfg(target_os = "linux")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::protocol::xtest::ConnectionExt as XTestExt;
use x11rb::rust_connection::RustConnection;

pub struct EmbeddedSession {
    pub display: String,
    pub width: u16,
    pub height: u16,
    pub stop: Arc<AtomicBool>,
    xvfb: std::process::Child,
    xfreerdp: std::process::Child,
}

impl Drop for EmbeddedSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.xfreerdp.kill().ok();
        self.xvfb.kill().ok();
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
) -> Result<EmbeddedSession, String> {
    let display_num = find_free_display_num();
    let display = format!(":{}", display_num);

    let xvfb = std::process::Command::new("Xvfb")
        .arg(&display)
        .arg("-screen")
        .arg("0")
        .arg(format!("{}x{}x24", width, height))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            format!("NO_XVFB\nXvfb no encontrado: {e}\nInstalar con: sudo apt install xvfb")
        })?;

    std::thread::sleep(std::time::Duration::from_millis(400));

    let mut cmd = std::process::Command::new("xfreerdp3");
    cmd.env("DISPLAY", &display);
    cmd.arg(format!("/v:{}:{}", host, port));
    cmd.arg(format!("/u:{}", username));
    if !domain.is_empty() {
        cmd.arg(format!("/d:{}", domain));
    }
    if let Some(p) = password {
        cmd.arg(format!("/p:{p}"));
    }
    cmd.arg(format!("/size:{}x{}", width, height));
    cmd.arg("/cert:ignore");
    cmd.arg("/clipboard");
    cmd.arg("/gdi:sw");
    cmd.arg("/bpp:24");
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let xfreerdp = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch xfreerdp3: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    let sid = session_id.to_string();
    let disp_clone = display.clone();

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1800));
        let (conn, screen_num) = match RustConnection::connect(Some(&disp_clone)) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("x11rb connect: {e}");
                return;
            }
        };
        let root = conn.setup().roots[screen_num].root;
        loop {
            if stop_clone.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(b64) = capture_frame_b64(&conn, root, width, height) {
                app.emit(&format!("rdp-frame-{sid}"), b64).ok();
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });

    Ok(EmbeddedSession { display, width, height, stop, xvfb, xfreerdp })
}

fn find_free_display_num() -> u32 {
    (100u32..200)
        .find(|n| !std::path::Path::new(&format!("/tmp/.X{}-lock", n)).exists())
        .unwrap_or(100)
}

fn capture_frame_b64(
    conn: &RustConnection,
    root: u32,
    width: u16,
    height: u16,
) -> Result<String, String> {
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root, 0, 0, width, height, u32::MAX)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;

    let raw = &reply.data;
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for px in raw.chunks(4) {
        if px.len() == 4 {
            rgb.push(px[2]);
            rgb.push(px[1]);
            rgb.push(px[0]);
        }
    }

    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 80)
        .encode(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;

    Ok(BASE64.encode(&out))
}

pub fn mouse_event(
    display: &str,
    event_type: u8,
    button: u8,
    x: i16,
    y: i16,
) -> Result<(), String> {
    let (conn, screen_num) =
        RustConnection::connect(Some(display)).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[screen_num].root;
    conn.xtest_fake_input(event_type, button, 0, root, x, y, 0)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn key_event(display: &str, pressed: bool, key: &str) -> Result<(), String> {
    let (conn, screen_num) =
        RustConnection::connect(Some(display)).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[screen_num].root;

    let keysym = match js_key_to_keysym(key) {
        Some(k) => k,
        None => return Ok(()),
    };

    let first = 8u8;
    let count = 248u8;
    let mapping = conn
        .get_keyboard_mapping(first, count)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    let per = mapping.keysyms_per_keycode as usize;
    let keycode = mapping
        .keysyms
        .chunks(per)
        .enumerate()
        .find_map(|(i, syms)| {
            if syms.contains(&keysym) {
                Some((i as u8) + first)
            } else {
                None
            }
        })
        .ok_or_else(|| format!("No keycode for keysym {keysym:#x}"))?;

    let event_type = if pressed { 2u8 } else { 3u8 };
    conn.xtest_fake_input(event_type, keycode, 0, root, 0, 0, 0)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(())
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
        "F1" => 0xffbe,
        "F2" => 0xffbf,
        "F3" => 0xffc0,
        "F4" => 0xffc1,
        "F5" => 0xffc2,
        "F6" => 0xffc3,
        "F7" => 0xffc4,
        "F8" => 0xffc5,
        "F9" => 0xffc6,
        "F10" => 0xffc7,
        "F11" => 0xffc8,
        "F12" => 0xffc9,
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
