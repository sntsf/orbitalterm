// Minimal mstscax connection tester.
// Usage (from src-tauri dir):
//   cargo run --bin rdp_test -- <host> <domain\user> <password> [port]
//
// Tests: CoCreate mstscax → set ClearTextPassword via IMsTscNonScriptable →
// Connect() → print OnConnected or OnDisconnected+discReason.
// No CredManager, no keyboard injection — pure COM credential path.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use windows::core::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;

// MsRdpClient10 / MsRdpClient9 CLSIDs
const CLSID_10: GUID = GUID::from_values(0xC0EFA91A,0xEEB7,0x41C7,[0x97,0xFA,0xF0,0xED,0x64,0x5E,0xFB,0x24]);
const CLSID_9:  GUID = GUID::from_values(0x8B918B82,0x7985,0x4C24,[0x89,0xDF,0xC3,0x3A,0xD2,0xBB,0xFB,0xCD]);

// DMsRdpClientEvents CP IID (enumerated at runtime on this mstscax build)
const IID_EVENTS_ALT: GUID = GUID::from_values(
    0x336D5562,0xEFA8,0x482E,[0x8C,0xB3,0xC5,0xC0,0xFC,0x7A,0x7D,0xB6]);
const IID_IDISPATCH: GUID = GUID::from_values(
    0x00020400,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IUNKNOWN: GUID = GUID::from_values(
    0x00000000,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);

// ── Minimal COM event sink ────────────────────────────────────────────────────

struct Sink {
    vtbl: *const SinkVtbl,
    ref_count: std::sync::atomic::AtomicU32,
    connected: Arc<AtomicBool>,
    disc_reason: Arc<AtomicI32>,
}

#[repr(C)]
struct SinkVtbl {
    qi:      unsafe extern "system" fn(*mut Sink, *const GUID, *mut *mut std::ffi::c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut Sink) -> u32,
    release: unsafe extern "system" fn(*mut Sink) -> u32,
    get_type_info_count: unsafe extern "system" fn(*mut Sink, *mut u32) -> HRESULT,
    get_type_info:       unsafe extern "system" fn(*mut Sink, u32, u32, *mut *mut std::ffi::c_void) -> HRESULT,
    get_ids_of_names:    unsafe extern "system" fn(*mut Sink, *const GUID, *mut PWSTR, u32, u32, *mut i32) -> HRESULT,
    invoke:              unsafe extern "system" fn(*mut Sink, i32, *const GUID, u32, u16, *const std::ffi::c_void, *mut VARIANT, *mut std::ffi::c_void, *mut u32) -> HRESULT,
}

unsafe extern "system" fn sink_qi(this: *mut Sink, riid: *const GUID, ppv: *mut *mut std::ffi::c_void) -> HRESULT {
    let g = *riid;
    if g == IID_IUNKNOWN || g == IID_IDISPATCH || g == IID_EVENTS_ALT {
        *ppv = this as *mut _;
        sink_add_ref(this);
        HRESULT(0)
    } else {
        *ppv = std::ptr::null_mut();
        HRESULT(0x80004002u32 as i32) // E_NOINTERFACE
    }
}
unsafe extern "system" fn sink_add_ref(this: *mut Sink) -> u32 {
    (*this).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}
unsafe extern "system" fn sink_release(this: *mut Sink) -> u32 {
    let prev = (*this).ref_count.fetch_sub(1, Ordering::Relaxed);
    if prev == 1 {
        drop(Box::from_raw(this));
    }
    prev - 1
}
unsafe extern "system" fn sink_get_type_info_count(_: *mut Sink, pc: *mut u32) -> HRESULT {
    *pc = 0; HRESULT(0)
}
unsafe extern "system" fn sink_get_type_info(_: *mut Sink, _: u32, _: u32, _: *mut *mut std::ffi::c_void) -> HRESULT {
    HRESULT(0x80004001u32 as i32)
}
unsafe extern "system" fn sink_get_ids_of_names(_: *mut Sink, _: *const GUID, _: *mut PWSTR, _: u32, _: u32, _: *mut i32) -> HRESULT {
    HRESULT(0x80004001u32 as i32)
}
unsafe extern "system" fn sink_invoke(this: *mut Sink, dispid: i32, _: *const GUID, _: u32, _: u16,
    params: *const std::ffi::c_void, _: *mut VARIANT, _: *mut std::ffi::c_void, _: *mut u32) -> HRESULT
{
    match dispid {
        2 => {
            // OnConnected
            println!("[rdp_test] DISPID 2 — OnConnected ✓ SESSION ESTABLISHED");
            (*this).connected.store(true, Ordering::SeqCst);
        }
        4 => {
            // OnDisconnected — first param is discReason (i32)
            let reason = if !params.is_null() {
                let dp = params as *const DISPPARAMS;
                if (*dp).cArgs > 0 && !(*dp).rgvarg.is_null() {
                    let v = &*(*dp).rgvarg;
                    let raw = v as *const VARIANT as *const VarRaw;
                    if (*raw).vt == 3 { (*raw).data.lVal } else { -1 }
                } else { -1 }
            } else { -1 };
            println!("[rdp_test] DISPID 4 — OnDisconnected discReason=0x{:08X} ({})", reason as u32, reason);
            (*this).disc_reason.store(reason, Ordering::SeqCst);
        }
        18 => println!("[rdp_test] DISPID 18 — OnAuthenticationWarningDisplayed (credential dialog appeared!)"),
        19 => println!("[rdp_test] DISPID 19 — OnAuthenticationWarningDismissed"),
        _  => println!("[rdp_test] DISPID {dispid}"),
    }
    HRESULT(0)
}

#[repr(C)]
struct VarRaw { vt: u16, _pad: [u16; 3], data: VarData }
#[repr(C)]
union VarData { lVal: i32, _u64: u64 }

static SINK_VTBL: SinkVtbl = SinkVtbl {
    qi:                  sink_qi,
    add_ref:             sink_add_ref,
    release:             sink_release,
    get_type_info_count: sink_get_type_info_count,
    get_type_info:       sink_get_type_info,
    get_ids_of_names:    sink_get_ids_of_names,
    invoke:              sink_invoke,
};

fn make_sink(connected: Arc<AtomicBool>, disc_reason: Arc<AtomicI32>) -> IUnknown {
    let s = Box::new(Sink {
        vtbl: &SINK_VTBL,
        ref_count: std::sync::atomic::AtomicU32::new(1),
        connected,
        disc_reason,
    });
    unsafe { <IUnknown as Interface>::from_raw(Box::into_raw(s) as *mut _) }
}

// ── IDispatch helpers ─────────────────────────────────────────────────────────

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
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 8; (*r).data._u64 = bval.as_ptr() as u64; }
        let named = -3i32;
        let _ = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut (named as i32), cArgs: 1, cNamedArgs: 1 },
            None, None, None);
    }
}
fn put_i32(disp: &IDispatch, name: &str, val: i32) {
    let Ok(id) = get_dispid(disp, name) else { return; };
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 3; (*r).data.lVal = val; }
        let named = -3i32;
        let _ = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut (named as i32), cArgs: 1, cNamedArgs: 1 },
            None, None, None);
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
                (*(r as *mut VarRaw)).vt = 0;
                return Some(IDispatch::from_raw(raw));
            }
        }
        VariantClear(&mut result).ok();
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

unsafe fn try_clear_text_password(com_ptr: *mut std::ffi::c_void, password: &str) -> bool {
    const IID_NS: GUID = GUID::from_values(
        0xC539BD95,0x2782,0x4D46,[0x96,0x06,0x50,0xB3,0x1E,0x9D,0x48,0x97]);
    let vtbl: *const usize = *(com_ptr as *const *const usize);
    type QiFn = unsafe extern "system" fn(*mut std::ffi::c_void, *const GUID, *mut *mut std::ffi::c_void) -> i32;
    let qi: QiFn = std::mem::transmute(*vtbl.add(0));
    let mut ns: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = qi(com_ptr, &IID_NS, &mut ns);
    if hr < 0 || ns.is_null() {
        println!("[rdp_test] IMsTscNonScriptable QI hr=0x{:08X} (not available)", hr as u32);
        return false;
    }
    println!("[rdp_test] IMsTscNonScriptable QI ok");
    let ns_vtbl: *const usize = *(ns as *const *const usize);
    let pw = BSTR::from(password);
    type PutFn = unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16) -> i32;
    let put: PutFn = std::mem::transmute(*ns_vtbl.add(3));
    let put_hr = put(ns, pw.as_ptr() as *mut u16);
    type RelFn = unsafe extern "system" fn(*mut std::ffi::c_void) -> u32;
    let rel: RelFn = std::mem::transmute(*ns_vtbl.add(2));
    rel(ns);
    println!("[rdp_test] IMsTscNonScriptable::put_ClearTextPassword hr=0x{:08X}", put_hr as u32);
    put_hr >= 0
}

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: rdp_test <host> <domain\\\\user_OR_user> <password> [port]");
        eprintln!("  Example: rdp_test 10.240.0.10 \"gmdsa\\\\canv_asantos\" MyPassword");
        std::process::exit(1);
    }
    let host     = &args[1];
    let username = &args[2];
    let password = &args[3];
    let port: u16 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3389);

    // Split domain\user
    let (domain_str, user_str): (&str, &str) = if let Some(pos) = username.find('\\') {
        (&username[..pos], &username[pos + 1..])
    } else {
        ("", username.as_str())
    };

    println!("[rdp_test] host={host}:{port}  user={user_str}  domain={domain_str}");
    println!("[rdp_test] password length: {} chars", password.len());

    let connected   = Arc::new(AtomicBool::new(false));
    let disc_reason = Arc::new(AtomicI32::new(i32::MIN));

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let rdp_unk: IUnknown = CoCreateInstance(&CLSID_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_9, None, CLSCTX_INPROC_SERVER))
            .expect("CoCreateInstance mstscax");
        println!("[rdp_test] CoCreateInstance ok");

        let disp: IDispatch = rdp_unk.cast().expect("IDispatch QI");

        // Set connection properties
        put_bstr(&disp, "Server", host);
        put_i32(&disp, "RDPPort", port as i32);
        put_bstr(&disp, "UserName", user_str);
        if !domain_str.is_empty() {
            put_bstr(&disp, "Domain", domain_str);
        }
        put_i32(&disp, "AuthenticationLevel", 0);
        println!("[rdp_test] Server/UserName/Domain set");

        // AdvancedSettings
        let adv_names = ["AdvancedSettings9","AdvancedSettings7","AdvancedSettings5","AdvancedSettings2"];
        let adv = adv_names.iter().find_map(|n| get_sub_disp(&disp, n).map(|d| { println!("[rdp_test] {n}"); d }));
        if let Some(ref adv) = adv {
            put_i32(adv, "RDPPort", port as i32);
            put_i32(adv, "AuthenticationLevel", 0);
            put_i32(adv, "EnableCredSspSupport", 1); // -1 = true as VT_BOOL
        }

        // Try IMsTscNonScriptable::ClearTextPassword (proper COM path)
        let raw_ptr = rdp_unk.as_raw() as *mut std::ffi::c_void;
        let ns_ok = try_clear_text_password(raw_ptr, password);
        if !ns_ok {
            // Fallback: try via IDispatch on AdvancedSettings (usually DISP_E_UNKNOWNNAME)
            if let Some(ref adv) = adv {
                put_bstr(adv, "ClearTextPassword", password);
                println!("[rdp_test] ClearTextPassword set via AdvancedSettings (fallback)");
            }
        }

        // Subscribe to events BEFORE Connect()
        eprintln!("[rdp_test] Casting to IConnectionPointContainer...");
        match rdp_unk.cast::<IConnectionPointContainer>() {
            Err(e) => eprintln!("[rdp_test] IConnectionPointContainer QI failed: {e}"),
            Ok(cpc) => {
                eprintln!("[rdp_test] IConnectionPointContainer ok");
                eprintln!("[rdp_test] FindConnectionPoint IID_EVENTS_ALT...");
                match cpc.FindConnectionPoint(&IID_EVENTS_ALT) {
                    Err(e) => eprintln!("[rdp_test] FindConnectionPoint failed: {e}"),
                    Ok(cp) => {
                        eprintln!("[rdp_test] FindConnectionPoint ok — creating sink...");
                        let sink = make_sink(connected.clone(), disc_reason.clone());
                        eprintln!("[rdp_test] Advise...");
                        match cp.Advise(&sink) {
                            Ok(cookie) => eprintln!("[rdp_test] Advise ok cookie={cookie}"),
                            Err(e)     => eprintln!("[rdp_test] Advise failed: {e}"),
                        }
                    }
                }
            }
        }

        // Connect
        eprintln!("[rdp_test] Calling Connect()...");
        match call_no_args(&disp, "Connect") {
            Ok(()) => eprintln!("[rdp_test] Connect() called ok"),
            Err(e) => { eprintln!("[rdp_test] Connect() FAILED: {e}"); return; }
        }

        eprintln!("[rdp_test] Waiting up to 30s for result...");
        let start = std::time::Instant::now();
        let mut msg = MSG::default();
        loop {
            // Process COM/Win32 messages
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if connected.load(Ordering::SeqCst) {
                println!("[rdp_test] SUCCESS: connected to {host}:{port} as {username}");
                let _ = call_no_args(&disp, "Disconnect");
                std::thread::sleep(std::time::Duration::from_millis(500));
                break;
            }
            if disc_reason.load(Ordering::SeqCst) != i32::MIN {
                let r = disc_reason.load(Ordering::SeqCst);
                println!("[rdp_test] FAILED: discReason=0x{:08X} ({})", r as u32, r);
                if r as u32 == 0x1F07 {
                    println!("[rdp_test]   -> 7943 = NLA credentials rejected by server");
                    println!("[rdp_test]      The username/password is WRONG or the account has no RDP access.");
                }
                break;
            }
            if start.elapsed() > std::time::Duration::from_secs(30) {
                println!("[rdp_test] TIMEOUT -- no connection result after 30s");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        CoUninitialize();
    }
}
