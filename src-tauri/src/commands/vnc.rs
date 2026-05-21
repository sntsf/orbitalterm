use base64::Engine;
use image::{codecs::jpeg::JpegEncoder, ImageEncoder};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::{commands::sessions::load_connection, vnc::{VncMsg, VncSession, VncSessionMap}};

// ── RFB protocol helpers ──────────────────────────────────────────────────────

fn read_exact(s: &mut TcpStream, n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    s.read_exact(&mut buf).map_err(|e| format!("VNC read error: {e}"))?;
    Ok(buf)
}

fn read_u8(s: &mut TcpStream) -> Result<u8, String> {
    Ok(read_exact(s, 1)?[0])
}
fn read_u16be(s: &mut TcpStream) -> Result<u16, String> {
    let b = read_exact(s, 2)?;
    Ok(u16::from_be_bytes([b[0], b[1]]))
}
fn read_u32be(s: &mut TcpStream) -> Result<u32, String> {
    let b = read_exact(s, 4)?;
    Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn write_all(s: &mut TcpStream, data: &[u8]) -> Result<(), String> {
    s.write_all(data).map_err(|e| format!("VNC write error: {e}"))
}

// VNC DES auth: reverse the bits of each password byte, use as DES key
fn vnc_des_encrypt(challenge: &[u8; 16], password: &str) -> [u8; 16] {
    use des::cipher::{BlockEncrypt, KeyInit};
    use des::Des;

    let mut key = [0u8; 8];
    for (i, &b) in password.as_bytes().iter().take(8).enumerate() {
        key[i] = b.reverse_bits();
    }

    let cipher = Des::new(&key.into());
    let mut response = [0u8; 16];

    let mut block1: [u8; 8] = challenge[..8].try_into().unwrap();
    cipher.encrypt_block((&mut block1).into());
    response[..8].copy_from_slice(&block1);

    let mut block2: [u8; 8] = challenge[8..].try_into().unwrap();
    cipher.encrypt_block((&mut block2).into());
    response[8..].copy_from_slice(&block2);

    response
}

// Perform the full RFB handshake; returns (width, height)
fn rfb_handshake(s: &mut TcpStream, password: Option<&str>) -> Result<(u32, u32), String> {
    // ProtocolVersion
    let server_ver = read_exact(s, 12)?;
    let ver_str = String::from_utf8_lossy(&server_ver);
    // Accept 3.3, 3.7, 3.8 — always respond with 3.8
    write_all(s, b"RFB 003.008\n")?;

    // Security types
    let num_types = read_u8(s)?;
    if num_types == 0 {
        let reason_len = read_u32be(s)? as usize;
        let reason = read_exact(s, reason_len)?;
        return Err(format!("VNC server refused connection: {}", String::from_utf8_lossy(&reason)));
    }
    let sec_types = read_exact(s, num_types as usize)?;

    // Prefer None (1), then VNC auth (2)
    let chosen = if sec_types.contains(&1) {
        1u8
    } else if sec_types.contains(&2) {
        2u8
    } else {
        return Err(format!("No supported VNC security type. Server offers: {sec_types:?}"));
    };

    write_all(s, &[chosen])?;

    match chosen {
        1 => {
            // None — no authentication
            // 3.8 still sends a security-result
            if ver_str.contains("003.008") || ver_str.contains("003.007") {
                let result = read_u32be(s)?;
                if result != 0 {
                    return Err("VNC auth failed (None)".to_string());
                }
            }
        }
        2 => {
            // VNC Authentication — DES challenge/response
            let challenge_bytes = read_exact(s, 16)?;
            let challenge: [u8; 16] = challenge_bytes.try_into().unwrap();
            let response = vnc_des_encrypt(&challenge, password.unwrap_or(""));
            write_all(s, &response)?;
            let result = read_u32be(s)?;
            if result != 0 {
                // Try to read the reason string (3.8+)
                if let Ok(reason_len) = read_u32be(s) {
                    if let Ok(reason) = read_exact(s, reason_len as usize) {
                        return Err(format!("VNC authentication failed: {}", String::from_utf8_lossy(&reason)));
                    }
                }
                return Err("VNC authentication failed: wrong password".to_string());
            }
        }
        _ => unreachable!(),
    }

    // ClientInit: shared flag = 1 (allow other clients)
    write_all(s, &[1u8])?;

    // ServerInit
    let width = read_u16be(s)? as u32;
    let height = read_u16be(s)? as u32;
    // Skip pixel format (16 bytes) and server name
    read_exact(s, 16)?;
    let name_len = read_u32be(s)?;
    read_exact(s, name_len as usize)?;

    Ok((width, height))
}

// Tell server to send RGBA 32-bit pixels (R at byte 0, G at byte 1, B at byte 2)
fn send_set_pixel_format(s: &mut TcpStream) -> Result<(), String> {
    #[rustfmt::skip]
    let msg: &[u8] = &[
        0, 0, 0, 0,   // type=0, 3 padding bytes
        32,           // bits-per-pixel
        24,           // depth
        0,            // big-endian-flag  (little-endian)
        1,            // true-colour-flag
        0, 255,       // red-max
        0, 255,       // green-max
        0, 255,       // blue-max
        0,            // red-shift
        8,            // green-shift
        16,           // blue-shift
        0, 0, 0,      // padding
    ];
    write_all(s, msg)
}

// Request Raw (0) and CopyRect (1) encodings
fn send_set_encodings(s: &mut TcpStream) -> Result<(), String> {
    let mut msg = vec![2u8, 0]; // type=2, padding
    msg.extend_from_slice(&2u16.to_be_bytes()); // num-encodings=2
    msg.extend_from_slice(&0i32.to_be_bytes()); // Raw
    msg.extend_from_slice(&1i32.to_be_bytes()); // CopyRect
    write_all(s, &msg)
}

fn send_fb_update_request(
    s: &mut TcpStream,
    incremental: bool,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
) -> Result<(), String> {
    let mut msg = vec![3u8, if incremental { 1 } else { 0 }];
    msg.extend_from_slice(&x.to_be_bytes());
    msg.extend_from_slice(&y.to_be_bytes());
    msg.extend_from_slice(&w.to_be_bytes());
    msg.extend_from_slice(&h.to_be_bytes());
    write_all(s, &msg)
}

fn send_key_event(s: &mut TcpStream, down: bool, key: u32) -> Result<(), String> {
    let mut msg = vec![4u8, if down { 1 } else { 0 }, 0, 0];
    msg.extend_from_slice(&key.to_be_bytes());
    write_all(s, &msg)
}

fn send_pointer_event(s: &mut TcpStream, buttons: u8, x: u16, y: u16) -> Result<(), String> {
    let mut msg = vec![5u8, buttons];
    msg.extend_from_slice(&x.to_be_bytes());
    msg.extend_from_slice(&y.to_be_bytes());
    write_all(s, &msg)
}

// Encode framebuffer (RGBA layout) to JPEG base64
fn encode_frame(fb: &[u8], width: u32, height: u32) -> Option<String> {
    let expected = (width * height * 4) as usize;
    if fb.len() < expected {
        return None;
    }
    // RGBA → RGB
    let rgb: Vec<u8> = fb[..expected]
        .chunks(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 70)
        .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(&jpeg))
}

// ── Session thread ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct VncFrame {
    data: String,
    width: u32,
    height: u32,
}

fn session_thread(
    app: tauri::AppHandle,
    session_id: String,
    stream: TcpStream,
    width: u32,
    height: u32,
    rx: mpsc::Receiver<VncMsg>,
) {
    const BPP: u32 = 4;
    let mut fb = vec![0u8; (width * height * BPP) as usize];

    let mut read_s = stream;
    let mut write_s = match read_s.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };

    // Initial setup
    if send_set_pixel_format(&mut write_s).is_err() { return; }
    if send_set_encodings(&mut write_s).is_err() { return; }
    if send_fb_update_request(&mut write_s, false, 0, 0, width as u16, height as u16).is_err() {
        return;
    }

    // Use a short read timeout so we can interleave client-event processing
    read_s.set_read_timeout(Some(Duration::from_millis(20))).ok();

    let mut update_pending = true;

    loop {
        // Drain client events
        loop {
            match rx.try_recv() {
                Ok(VncMsg::Disconnect) => return,
                Ok(VncMsg::KeyEvent { down, key }) => {
                    send_key_event(&mut write_s, down, key).ok();
                }
                Ok(VncMsg::PointerEvent { buttons, x, y }) => {
                    send_pointer_event(&mut write_s, buttons, x, y).ok();
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        // Read one byte to determine the server message type
        let mut type_buf = [0u8; 1];
        match read_s.read_exact(&mut type_buf) {
            Ok(()) => {}
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Nothing from server right now; request next update if needed
                if !update_pending {
                    send_fb_update_request(
                        &mut write_s,
                        true,
                        0,
                        0,
                        width as u16,
                        height as u16,
                    )
                    .ok();
                    update_pending = true;
                }
                continue;
            }
            Err(_) => {
                app.emit(&format!("vnc-disconnected-{session_id}"), ()).ok();
                return;
            }
        }

        match type_buf[0] {
            // FramebufferUpdate
            0 => {
                let mut hdr = [0u8; 3]; // padding + num_rects(2)
                if read_s.read_exact(&mut hdr).is_err() { break; }
                let num_rects = u16::from_be_bytes([hdr[1], hdr[2]]);
                let mut bad = false;

                for _ in 0..num_rects {
                    let mut rh = [0u8; 12];
                    if read_s.read_exact(&mut rh).is_err() { bad = true; break; }
                    let rx = u16::from_be_bytes([rh[0], rh[1]]) as u32;
                    let ry = u16::from_be_bytes([rh[2], rh[3]]) as u32;
                    let rw = u16::from_be_bytes([rh[4], rh[5]]) as u32;
                    let rh_ = u16::from_be_bytes([rh[6], rh[7]]) as u32;
                    let enc = i32::from_be_bytes([rh[8], rh[9], rh[10], rh[11]]);

                    match enc {
                        0 => {
                            // Raw
                            let nbytes = (rw * rh_ * BPP) as usize;
                            let mut pixels = vec![0u8; nbytes];
                            if read_s.read_exact(&mut pixels).is_err() { bad = true; break; }
                            for row in 0..rh_ {
                                let src = (row * rw * BPP) as usize;
                                let dst_row = ry + row;
                                let dst = ((dst_row * width + rx) * BPP) as usize;
                                let row_bytes = (rw * BPP) as usize;
                                if dst + row_bytes <= fb.len() {
                                    fb[dst..dst + row_bytes].copy_from_slice(&pixels[src..src + row_bytes]);
                                }
                            }
                        }
                        1 => {
                            // CopyRect
                            let mut src_buf = [0u8; 4];
                            if read_s.read_exact(&mut src_buf).is_err() { bad = true; break; }
                            let sx = u16::from_be_bytes([src_buf[0], src_buf[1]]) as u32;
                            let sy = u16::from_be_bytes([src_buf[2], src_buf[3]]) as u32;
                            // Row-by-row copy (may overlap, use temp)
                            for row in 0..rh_ {
                                let src_off = (((sy + row) * width + sx) * BPP) as usize;
                                let row_bytes = (rw * BPP) as usize;
                                if src_off + row_bytes <= fb.len() {
                                    let temp: Vec<u8> = fb[src_off..src_off + row_bytes].to_vec();
                                    let dst_off = (((ry + row) * width + rx) * BPP) as usize;
                                    if dst_off + row_bytes <= fb.len() {
                                        fb[dst_off..dst_off + row_bytes].copy_from_slice(&temp);
                                    }
                                }
                            }
                        }
                        _ => {
                            // Unsupported encoding — we can't skip without knowing the length
                            bad = true;
                            break;
                        }
                    }
                }

                if bad { break; }

                // Emit the updated frame
                if let Some(b64) = encode_frame(&fb, width, height) {
                    app.emit(
                        &format!("vnc-frame-{session_id}"),
                        VncFrame { data: b64, width, height },
                    )
                    .ok();
                }
                update_pending = false;
            }

            // SetColourMapEntries — skip
            1 => {
                let mut skip = [0u8; 5]; // padding(1) + first-colour(2) + num-colours(2)
                if read_s.read_exact(&mut skip).is_err() { break; }
                let num_colours = u16::from_be_bytes([skip[3], skip[4]]) as usize;
                let mut data = vec![0u8; num_colours * 6];
                if read_s.read_exact(&mut data).is_err() { break; }
            }
            // Bell — ignore
            2 => {}
            // ServerCutText — skip
            3 => {
                let mut skip = [0u8; 3];
                if read_s.read_exact(&mut skip).is_err() { break; }
                let mut lbuf = [0u8; 4];
                if read_s.read_exact(&mut lbuf).is_err() { break; }
                let len = u32::from_be_bytes(lbuf) as usize;
                let mut text = vec![0u8; len];
                if read_s.read_exact(&mut text).is_err() { break; }
            }
            _ => break, // Unknown — bail
        }

        // Request next incremental update
        if !update_pending {
            send_fb_update_request(&mut write_s, true, 0, 0, width as u16, height as u16).ok();
            update_pending = true;
        }
    }

    app.emit(&format!("vnc-disconnected-{session_id}"), ()).ok();
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct VncConnectResult {
    pub session_id: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn vnc_connect(
    app: tauri::AppHandle,
    vnc_sessions: State<'_, VncSessionMap>,
    connection_id: String,
) -> Result<VncConnectResult, String> {
    let connection = load_connection(&connection_id)?;
    let addr = format!("{}:{}", connection.host, connection.port);

    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect failed: {e}"))?;

    let password = if connection.auth_type == "password" {
        crate::commands::sessions::get_saved_password_pub(&connection_id)
    } else {
        None
    };

    let (width, height) = rfb_handshake(&mut stream, password.as_deref())?;

    let (tx, rx) = mpsc::sync_channel::<VncMsg>(128);
    let session_id = Uuid::new_v4().to_string();

    vnc_sessions.lock().unwrap().insert(
        session_id.clone(),
        VncSession { width, height, tx },
    );

    let app2 = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || session_thread(app2, sid, stream, width, height, rx));

    Ok(VncConnectResult { session_id, width, height })
}

#[tauri::command]
pub async fn vnc_key_event(
    vnc_sessions: State<'_, VncSessionMap>,
    session_id: String,
    down: bool,
    key: u32,
) -> Result<(), String> {
    let map = vnc_sessions.lock().unwrap();
    let session = map.get(&session_id).ok_or("VNC session not found")?;
    session.tx.send(VncMsg::KeyEvent { down, key }).map_err(|_| "VNC thread gone".to_string())
}

#[tauri::command]
pub async fn vnc_pointer_event(
    vnc_sessions: State<'_, VncSessionMap>,
    session_id: String,
    buttons: u8,
    x: u16,
    y: u16,
) -> Result<(), String> {
    let map = vnc_sessions.lock().unwrap();
    let session = map.get(&session_id).ok_or("VNC session not found")?;
    session
        .tx
        .send(VncMsg::PointerEvent { buttons, x, y })
        .map_err(|_| "VNC thread gone".to_string())
}

#[tauri::command]
pub async fn vnc_disconnect(
    vnc_sessions: State<'_, VncSessionMap>,
    session_id: String,
) -> Result<(), String> {
    let mut map = vnc_sessions.lock().unwrap();
    if let Some(sess) = map.remove(&session_id) {
        sess.tx.send(VncMsg::Disconnect).ok();
    }
    Ok(())
}
