// Minimal mstscax connection tester with proper OLE hosting.
// Usage (from src-tauri dir):
//   cargo run --bin rdp_test -- <host> <domain\user> <password> [port]

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const CLSID_10: GUID = GUID::from_values(0xC0EFA91A,0xEEB7,0x41C7,[0x97,0xFA,0xF0,0xED,0x64,0x5E,0xFB,0x24]);
const CLSID_9:  GUID = GUID::from_values(0x8B918B82,0x7985,0x4C24,[0x89,0xDF,0xC3,0x3A,0xD2,0xBB,0xFB,0xCD]);

const IID_IOLE_OBJECT:    GUID = GUID::from_values(0x00000112,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IOLE_CLIENTSITE: GUID = GUID::from_values(0x00000118,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IUNKNOWN:        GUID = GUID::from_values(0x00000000,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);

// ── Minimal IOleClientSite stub (all methods return E_NOTIMPL except QI/AddRef/Release) ──

#[repr(C)]
struct SiteVtbl {
    qi:          unsafe extern "system" fn(*mut SiteObj, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref:     unsafe extern "system" fn(*mut SiteObj) -> u32,
    release:     unsafe extern "system" fn(*mut SiteObj) -> u32,
    save_object: unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
    get_moniker: unsafe extern "system" fn(*mut SiteObj, u32, u32, *mut *mut c_void) -> HRESULT,
    get_container: unsafe extern "system" fn(*mut SiteObj, *mut *mut c_void) -> HRESULT,
    show_object: unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
    on_show:     unsafe extern "system" fn(*mut SiteObj, BOOL) -> HRESULT,
    request_new: unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
}

struct SiteObj { vtbl: *const SiteVtbl, ref_count: u32 }

unsafe extern "system" fn site_qi(this: *mut SiteObj, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if *riid == IID_IUNKNOWN || *riid == IID_IOLE_CLIENTSITE {
        *ppv = this as _; site_addref(this); HRESULT(0)
    } else { *ppv = std::ptr::null_mut(); HRESULT(0x80004002u32 as i32) }
}
unsafe extern "system" fn site_addref(this: *mut SiteObj) -> u32 { (*this).ref_count += 1; (*this).ref_count }
unsafe extern "system" fn site_release(this: *mut SiteObj) -> u32 { (*this).ref_count -= 1; (*this).ref_count }
unsafe extern "system" fn site_e_notimpl(_: *mut SiteObj) -> HRESULT { HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn site_get_moniker(_: *mut SiteObj, _: u32, _: u32, ppv: *mut *mut c_void) -> HRESULT
    { *ppv = std::ptr::null_mut(); HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn site_get_container(_: *mut SiteObj, ppv: *mut *mut c_void) -> HRESULT
    { *ppv = std::ptr::null_mut(); HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn site_on_show(_: *mut SiteObj, _: BOOL) -> HRESULT { HRESULT(0) }

static SITE_VTBL: SiteVtbl = SiteVtbl {
    qi: site_qi, add_ref: site_addref, release: site_release,
    save_object: site_e_notimpl, get_moniker: site_get_moniker,
    get_container: site_get_container, show_object: site_e_notimpl,
    on_show: site_on_show, request_new: site_e_notimpl,
};

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
            let raw = (*r).data._u64 as *mut c_void;
            if !raw.is_null() {
                (*(r as *mut VarRaw)).vt = 0;
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

// ── Raw vtable helpers ────────────────────────────────────────────────────────

unsafe fn raw_qi(obj: *mut c_void, iid: &GUID) -> Option<*mut c_void> {
    let vtbl: *const usize = *(obj as *const *const usize);
    type QiFn = unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32;
    let qi: QiFn = std::mem::transmute(*vtbl);
    let mut out: *mut c_void = std::ptr::null_mut();
    if qi(obj, iid, &mut out) >= 0 && !out.is_null() { Some(out) } else { None }
}

unsafe fn raw_release(obj: *mut c_void) {
    let vtbl: *const usize = *(obj as *const *const usize);
    type RelFn = unsafe extern "system" fn(*mut c_void) -> u32;
    let rel: RelFn = std::mem::transmute(*vtbl.add(2));
    rel(obj);
}

// ── IMsTscNonScriptable::ClearTextPassword ────────────────────────────────────

unsafe fn try_ns_clear_text_password(obj: *mut c_void, password: &str) -> bool {
    const IID_NS: GUID = GUID::from_values(
        0xC539BD95,0x2782,0x4D46,[0x96,0x06,0x50,0xB3,0x1E,0x9D,0x48,0x97]);
    let Some(ns) = raw_qi(obj, &IID_NS) else {
        eprintln!("[rdp_test] IMsTscNonScriptable: not available (E_NOINTERFACE)");
        return false;
    };
    eprintln!("[rdp_test] IMsTscNonScriptable QI ok");
    let ns_vtbl: *const usize = *(ns as *const *const usize);
    let pw = BSTR::from(password);
    type PutFn = unsafe extern "system" fn(*mut c_void, *mut u16) -> i32;
    let put: PutFn = std::mem::transmute(*ns_vtbl.add(3));
    let hr = put(ns, pw.as_ptr() as *mut u16);
    raw_release(ns);
    eprintln!("[rdp_test] put_ClearTextPassword hr=0x{:08X}", hr as u32);
    hr >= 0
}

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: rdp_test <host> <domain\\\\user> <password> [port]");
        std::process::exit(1);
    }
    let host     = &args[1];
    let username = &args[2];
    let password = &args[3];
    let port: u16 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3389);

    let (domain_str, user_str): (&str, &str) = if let Some(pos) = username.find('\\') {
        (&username[..pos], &username[pos + 1..])
    } else { ("", username.as_str()) };

    eprintln!("[rdp_test] host={host}:{port}  user={user_str}  domain={domain_str}");
    eprintln!("[rdp_test] password length: {} chars", password.len());

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // Create a hidden host window (mstscax needs OLE hosting to actually connect)
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"), w!("rdp_test"),
            WS_POPUP,
            0, 0, 100, 100,
            None, None, None, None,
        ).unwrap_or(HWND(std::ptr::null_mut()));
        eprintln!("[rdp_test] host HWND: {:?}", hwnd.0);

        // CoCreate mstscax
        let rdp_unk: IUnknown = CoCreateInstance(&CLSID_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_9, None, CLSCTX_INPROC_SERVER))
            .expect("CoCreateInstance mstscax");
        eprintln!("[rdp_test] CoCreateInstance ok");

        let raw_rdp = rdp_unk.as_raw() as *mut c_void;

        // ── OLE hosting: SetClientSite + DoVerb via raw vtable ────────────────
        let mut site_obj = SiteObj { vtbl: &SITE_VTBL, ref_count: 1 };
        let site_ptr: *mut SiteObj = &mut site_obj;

        if let Some(ole) = raw_qi(raw_rdp, &IID_IOLE_OBJECT) {
            eprintln!("[rdp_test] IOleObject ok");
            let vtbl: *const usize = *(ole as *const *const usize);

            // SetClientSite (vtable index 3)
            type SetClientSiteFn = unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32;
            let set_site: SetClientSiteFn = std::mem::transmute(*vtbl.add(3));
            let hr = set_site(ole, site_ptr as *mut c_void);
            eprintln!("[rdp_test] SetClientSite hr=0x{:08X}", hr as u32);

            // DoVerb OLEIVERB_INPLACEACTIVATE = -5 (vtable index 11)
            type DoVerbFn = unsafe extern "system" fn(*mut c_void, i32, *const MSG, *mut c_void, i32, HWND, *const RECT) -> i32;
            let do_verb: DoVerbFn = std::mem::transmute(*vtbl.add(11));
            let rect = RECT { left: 0, top: 0, right: 100, bottom: 100 };
            let hr2 = do_verb(ole, -5, std::ptr::null(), site_ptr as *mut c_void, -1, hwnd, &rect);
            eprintln!("[rdp_test] DoVerb(INPLACE_ACTIVATE) hr=0x{:08X}", hr2 as u32);

            raw_release(ole);
        } else {
            eprintln!("[rdp_test] WARNING: IOleObject not available — control may not connect");
        }

        // ── Set credentials via IDispatch ─────────────────────────────────────
        let disp: IDispatch = rdp_unk.cast().expect("IDispatch");

        put_bstr(&disp, "Server", host);
        put_i32(&disp, "RDPPort", port as i32);
        put_bstr(&disp, "UserName", user_str);
        if !domain_str.is_empty() { put_bstr(&disp, "Domain", domain_str); }
        put_i32(&disp, "AuthenticationLevel", 0);
        eprintln!("[rdp_test] Server/UserName/Domain set");

        let adv_names = ["AdvancedSettings9","AdvancedSettings7","AdvancedSettings5","AdvancedSettings2"];
        let adv = adv_names.iter().find_map(|n| get_sub_disp(&disp, n).map(|d| { eprintln!("[rdp_test] {n}"); d }));
        if let Some(ref adv) = adv {
            put_i32(adv, "RDPPort", port as i32);
            put_i32(adv, "AuthenticationLevel", 0);
            put_i32(adv, "EnableCredSspSupport", 1);
        }

        // ClearTextPassword
        let ns_ok = try_ns_clear_text_password(raw_rdp, password);
        if !ns_ok {
            if let Some(ref adv) = adv {
                put_bstr(adv, "ClearTextPassword", password);
                eprintln!("[rdp_test] ClearTextPassword via AdvancedSettings");
            }
        }

        // ── Connect ───────────────────────────────────────────────────────────
        eprintln!("[rdp_test] Calling Connect()...");
        match call_no_args(&disp, "Connect") {
            Ok(()) => eprintln!("[rdp_test] Connect() ok"),
            Err(e) => { eprintln!("[rdp_test] Connect() FAILED: {e}"); std::process::exit(1); }
        }

        // ── Poll Connected property ───────────────────────────────────────────
        // 0 = disconnected, 1 = connected, 2 = connecting
        eprintln!("[rdp_test] Polling Connected (0=disc 1=conn 2=connecting) for 30s...");
        let start = std::time::Instant::now();
        let mut prev_state: i32 = -999;
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
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::process::exit(0);
            }

            if state == 0 && saw_connecting {
                let ext = get_i32_prop(&disp, "ExtendedDisconnectReason").unwrap_or(-1);
                println!("[rdp_test] FAILED: disconnected after attempting to connect");
                println!("[rdp_test]   ExtendedDisconnectReason={ext}");
                println!("[rdp_test]   Most likely cause: wrong password (server rejected NLA).");
                println!("[rdp_test]   Verify manually: mstsc /v:{host}:{port}");
                std::process::exit(1);
            }

            if start.elapsed() > std::time::Duration::from_secs(30) {
                println!("[rdp_test] TIMEOUT (30s) — last Connected={prev_state}  saw_connecting={saw_connecting}");
                if !saw_connecting {
                    println!("[rdp_test]   Never saw state=2 — possible network/OLE issue");
                }
                std::process::exit(1);
            }

            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
