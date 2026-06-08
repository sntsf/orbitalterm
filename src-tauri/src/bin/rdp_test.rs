// Minimal mstscax connection tester — no COM sink, uses property polling.
// Usage (from src-tauri dir):
//   cargo run --bin rdp_test -- <host> <domain\user> <password> [port]
//
// Tests: CoCreate mstscax → set credentials → Connect() → poll Connected property.
// Reports success/fail without requiring a COM event sink (avoids Advise crashes).

#![cfg(target_os = "windows")]

use windows::core::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;

// MsRdpClient10 / MsRdpClient9 CLSIDs
const CLSID_10: GUID = GUID::from_values(0xC0EFA91A,0xEEB7,0x41C7,[0x97,0xFA,0xF0,0xED,0x64,0x5E,0xFB,0x24]);
const CLSID_9:  GUID = GUID::from_values(0x8B918B82,0x7985,0x4C24,[0x89,0xDF,0xC3,0x3A,0xD2,0xBB,0xFB,0xCD]);

// ── IDispatch helpers ─────────────────────────────────────────────────────────

#[repr(C)]
struct VarRaw { vt: u16, _pad: [u16; 3], data: VarData }
#[repr(C)]
union VarData { l_val: i32, _u64: u64 }

fn get_dispid(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut id = 0i32;
    let names = [PCWSTR(wide.as_ptr())];
    unsafe { disp.GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, 0x0409, &mut id) }?;
    Ok(id)
}

fn put_bstr(disp: &IDispatch, name: &str, val: &str) {
    let Ok(id) = get_dispid(disp, name) else { return; };
    let bval = std::mem::ManuallyDrop::new(BSTR::from(val));
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        let r = &mut var as *mut VARIANT as *mut VarRaw;
        (*r).vt = 8; (*r).data._u64 = bval.as_ptr() as u64;
        let mut named = -3i32;
        let _ = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None);
    }
}

fn put_i32(disp: &IDispatch, name: &str, val: i32) {
    let Ok(id) = get_dispid(disp, name) else { return; };
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        let r = &mut var as *mut VARIANT as *mut VarRaw;
        (*r).vt = 3; (*r).data.l_val = val;
        let mut named = -3i32;
        let _ = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None);
    }
}

fn get_i32_prop(disp: &IDispatch, name: &str) -> Option<i32> {
    let id = get_dispid(disp, name).ok()?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None).ok()?;
        let r = &result as *const VARIANT as *const VarRaw;
        let v = if (*r).vt == 3 { Some((*r).data.l_val) } else { None };
        let _ = VariantClear(&mut result);
        v
    }
}

fn get_sub_disp(disp: &IDispatch, name: &str) -> Option<IDispatch> {
    let id = get_dispid(disp, name).ok()?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None).ok()?;
        let r = &result as *const VARIANT as *const VarRaw;
        if (*r).vt == 9 {
            let raw = (*r).data._u64 as *mut std::ffi::c_void;
            if !raw.is_null() {
                (*(r as *mut VarRaw)).vt = 0; // prevent VariantClear from releasing
                return Some(IDispatch::from_raw(raw));
            }
        }
        let _ = VariantClear(&mut result);
        None
    }
}

fn call_no_args(disp: &IDispatch, name: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe { disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_METHOD,
        &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
        None, None, None) }
}

// ── IMsTscNonScriptable::ClearTextPassword via raw vtable ─────────────────────

unsafe fn try_ns_clear_text_password(com_ptr: *mut std::ffi::c_void, password: &str) -> bool {
    const IID_NS: GUID = GUID::from_values(
        0xC539BD95,0x2782,0x4D46,[0x96,0x06,0x50,0xB3,0x1E,0x9D,0x48,0x97]);
    let vtbl: *const usize = *(com_ptr as *const *const usize);
    type QiFn = unsafe extern "system" fn(*mut std::ffi::c_void, *const GUID, *mut *mut std::ffi::c_void) -> i32;
    let qi: QiFn = std::mem::transmute(*vtbl);
    let mut ns: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = qi(com_ptr, &IID_NS, &mut ns);
    if hr < 0 || ns.is_null() {
        eprintln!("[rdp_test] IMsTscNonScriptable QI hr=0x{:08X} (not available)", hr as u32);
        return false;
    }
    eprintln!("[rdp_test] IMsTscNonScriptable QI ok");
    let ns_vtbl: *const usize = *(ns as *const *const usize);
    let pw = BSTR::from(password);
    type PutFn = unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16) -> i32;
    let put: PutFn = std::mem::transmute(*ns_vtbl.add(3));
    let put_hr = put(ns, pw.as_ptr() as *mut u16);
    type RelFn = unsafe extern "system" fn(*mut std::ffi::c_void) -> u32;
    let rel: RelFn = std::mem::transmute(*ns_vtbl.add(2));
    rel(ns);
    eprintln!("[rdp_test] IMsTscNonScriptable::put_ClearTextPassword hr=0x{:08X}", put_hr as u32);
    put_hr >= 0
}

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: rdp_test <host> <domain\\\\user OR user> <password> [port]");
        eprintln!("  e.g.: rdp_test 10.240.0.10 \"gmdsa\\\\canv_asantos\" MyPassword");
        std::process::exit(1);
    }
    let host     = &args[1];
    let username = &args[2];
    let password = &args[3];
    let port: u16 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3389);

    let (domain_str, user_str): (&str, &str) = if let Some(pos) = username.find('\\') {
        (&username[..pos], &username[pos + 1..])
    } else {
        ("", username.as_str())
    };

    eprintln!("[rdp_test] host={host}:{port}  user={user_str}  domain={domain_str}");
    eprintln!("[rdp_test] password length: {} chars", password.len());

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // CoCreate mstscax
        let rdp_unk: IUnknown = CoCreateInstance(&CLSID_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_9, None, CLSCTX_INPROC_SERVER))
            .expect("CoCreateInstance mstscax");
        eprintln!("[rdp_test] CoCreateInstance ok");

        let disp: IDispatch = rdp_unk.cast().expect("IDispatch");

        // Basic connection params
        put_bstr(&disp, "Server", host);
        put_i32(&disp, "RDPPort", port as i32);
        put_bstr(&disp, "UserName", user_str);
        if !domain_str.is_empty() { put_bstr(&disp, "Domain", domain_str); }
        put_i32(&disp, "AuthenticationLevel", 0);
        eprintln!("[rdp_test] Server/UserName/Domain/AuthLevel set");

        // AdvancedSettings
        let adv_names = ["AdvancedSettings9","AdvancedSettings7","AdvancedSettings5","AdvancedSettings2"];
        let adv = adv_names.iter().find_map(|n| get_sub_disp(&disp, n).map(|d| { eprintln!("[rdp_test] {n} ok"); d }));
        if let Some(ref adv) = adv {
            put_i32(adv, "RDPPort", port as i32);
            put_i32(adv, "AuthenticationLevel", 0);
            put_i32(adv, "EnableCredSspSupport", 1);
        }

        // Attempt ClearTextPassword via IMsTscNonScriptable (raw vtable)
        let raw_ptr = rdp_unk.as_raw() as *mut std::ffi::c_void;
        let ns_ok = try_ns_clear_text_password(raw_ptr, password);
        if !ns_ok {
            if let Some(ref adv) = adv {
                put_bstr(adv, "ClearTextPassword", password);
                eprintln!("[rdp_test] ClearTextPassword via AdvancedSettings (fallback)");
            }
        }

        // Connect
        eprintln!("[rdp_test] Calling Connect()...");
        match call_no_args(&disp, "Connect") {
            Ok(()) => eprintln!("[rdp_test] Connect() ok"),
            Err(e) => { eprintln!("[rdp_test] Connect() FAILED: {e}"); CoUninitialize(); return; }
        }

        // Poll Connected property in message loop
        // 0 = disconnected, 1 = connected, 2 = connecting
        eprintln!("[rdp_test] Polling Connected property (0=disc, 1=conn, 2=connecting)...");
        let start = std::time::Instant::now();
        let mut prev_state: i32 = -1;
        let mut saw_connecting = false;
        let mut msg = MSG::default();

        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let state = get_i32_prop(&disp, "Connected").unwrap_or(-1);
            if state != prev_state {
                eprintln!("[rdp_test] Connected={state}");
                if state == 2 { saw_connecting = true; }
                prev_state = state;
            }

            if state == 1 {
                println!("[rdp_test] SUCCESS: Connected to {host}:{port} as {username}");
                let _ = call_no_args(&disp, "Disconnect");
                std::thread::sleep(std::time::Duration::from_millis(800));
                break;
            }

            // Disconnected after having been connecting → failed
            if state == 0 && saw_connecting {
                let ext = get_i32_prop(&disp, "ExtendedDisconnectReason").unwrap_or(-1);
                println!("[rdp_test] FAILED: disconnected after connecting attempt");
                println!("[rdp_test]   ExtendedDisconnectReason={ext}");
                println!("[rdp_test]   (ExtReason 2=logoff, 3=disconnect — check mstscax docs)");
                println!("[rdp_test]   Most likely: wrong password (NLA rejected by server).");
                println!("[rdp_test]   Verify credentials with: mstsc /v:{host}:{port}");
                break;
            }

            // Give up after 30s even if never saw connecting state
            if start.elapsed() > std::time::Duration::from_secs(30) {
                println!("[rdp_test] TIMEOUT (30s) — no connection result");
                println!("[rdp_test]   Last Connected state: {prev_state}");
                if !saw_connecting {
                    println!("[rdp_test]   Never saw state=2 (connecting) — possible network issue");
                }
                break;
            }

            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        CoUninitialize();
    }
}
