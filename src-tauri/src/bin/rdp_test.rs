// Minimal mstscax connection tester with proper OLE in-place hosting.
// Usage (from src-tauri dir):
//   cargo run --bin rdp_test -- <host> <domain\user> <password> [port]

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::Security::Credentials::{
    CredWriteW, CredDeleteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CRED_TYPE_DOMAIN_PASSWORD,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

const CLSID_10: GUID = GUID::from_values(0xC0EFA91A,0xEEB7,0x41C7,[0x97,0xFA,0xF0,0xED,0x64,0x5E,0xFB,0x24]);
const CLSID_9:  GUID = GUID::from_values(0x8B918B82,0x7985,0x4C24,[0x89,0xDF,0xC3,0x3A,0xD2,0xBB,0xFB,0xCD]);

const IID_IOLE_OBJECT:    GUID = GUID::from_values(0x00000112,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IOLE_CLIENTSITE:GUID = GUID::from_values(0x00000118,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IOLE_INPLACESITE:GUID= GUID::from_values(0x00000119,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IOLE_WINDOW:    GUID = GUID::from_values(0x00000114,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
const IID_IUNKNOWN:       GUID = GUID::from_values(0x00000000,0x0000,0x0000,[0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);

// ── COM site object implementing IOleClientSite + IOleInPlaceSite ─────────────
//
// Layout:
//   [offset 0]  ocs_vtbl: *const OCSVtbl        ← IOleClientSite entry point
//   [offset 8]  ips_inner: IPSInner             ← IOleInPlaceSite entry point
//   [offset 16] ref_count: u32
//   [offset 20] (pad)
//   [offset 24] hwnd: HWND
//
// QI for IOleClientSite / IUnknown → returns `this` (ocs_vtbl at offset 0)
// QI for IOleInPlaceSite / IOleWindow → returns `&this.ips_inner`
// IOleInPlaceSite methods recover `this` from inner via stored `parent` ptr.

#[repr(C)]
struct OCSVtbl {
    qi:            unsafe extern "system" fn(*mut SiteObj, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref:       unsafe extern "system" fn(*mut SiteObj) -> u32,
    release:       unsafe extern "system" fn(*mut SiteObj) -> u32,
    save_object:   unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
    get_moniker:   unsafe extern "system" fn(*mut SiteObj, u32, u32, *mut *mut c_void) -> HRESULT,
    get_container: unsafe extern "system" fn(*mut SiteObj, *mut *mut c_void) -> HRESULT,
    show_object:   unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
    on_show:       unsafe extern "system" fn(*mut SiteObj, BOOL) -> HRESULT,
    request_new:   unsafe extern "system" fn(*mut SiteObj) -> HRESULT,
}

#[repr(C)]
struct IPSVtbl {
    qi:          unsafe extern "system" fn(*mut IPSInner, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref:     unsafe extern "system" fn(*mut IPSInner) -> u32,
    release:     unsafe extern "system" fn(*mut IPSInner) -> u32,
    get_window:  unsafe extern "system" fn(*mut IPSInner, *mut HWND) -> HRESULT,
    ctx_help:    unsafe extern "system" fn(*mut IPSInner, BOOL) -> HRESULT,
    can_inplace: unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    on_inplace:  unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    on_ui_act:   unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    get_wnd_ctx: unsafe extern "system" fn(*mut IPSInner, *mut *mut c_void, *mut *mut c_void, *mut RECT, *mut RECT, *mut c_void) -> HRESULT,
    scroll:      unsafe extern "system" fn(*mut IPSInner, i32, i32) -> HRESULT,
    on_ui_deact: unsafe extern "system" fn(*mut IPSInner, BOOL) -> HRESULT,
    on_deact:    unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    discard:     unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    deact_undo:  unsafe extern "system" fn(*mut IPSInner) -> HRESULT,
    pos_change:  unsafe extern "system" fn(*mut IPSInner, *const RECT) -> HRESULT,
}

#[repr(C)]
struct IPSInner {
    vtbl:   *const IPSVtbl,
    parent: *mut SiteObj,
}

#[repr(C)]
struct SiteObj {
    ocs_vtbl:  *const OCSVtbl,
    ips_inner: IPSInner,
    ref_count: u32,
    hwnd:      HWND,
}

// ── IOleClientSite methods ────────────────────────────────────────────────────

unsafe extern "system" fn ocs_qi(this: *mut SiteObj, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    let iid = *riid;
    if iid == IID_IUNKNOWN || iid == IID_IOLE_CLIENTSITE {
        *ppv = this as *mut c_void;
        ocs_addref(this); HRESULT(0)
    } else if iid == IID_IOLE_INPLACESITE || iid == IID_IOLE_WINDOW {
        *ppv = &mut (*this).ips_inner as *mut IPSInner as *mut c_void;
        ips_addref(&mut (*this).ips_inner); HRESULT(0)
    } else {
        *ppv = std::ptr::null_mut(); HRESULT(0x80004002u32 as i32)
    }
}
unsafe extern "system" fn ocs_addref(this: *mut SiteObj) -> u32 { (*this).ref_count += 1; (*this).ref_count }
unsafe extern "system" fn ocs_release(this: *mut SiteObj) -> u32 { if (*this).ref_count > 0 { (*this).ref_count -= 1; } (*this).ref_count }
unsafe extern "system" fn ocs_e_notimpl(_: *mut SiteObj) -> HRESULT { HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn ocs_s_ok(_: *mut SiteObj) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ocs_get_moniker(_: *mut SiteObj, _: u32, _: u32, ppv: *mut *mut c_void) -> HRESULT
    { *ppv = std::ptr::null_mut(); HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn ocs_get_container(_: *mut SiteObj, ppv: *mut *mut c_void) -> HRESULT
    { *ppv = std::ptr::null_mut(); HRESULT(0x80004001u32 as i32) }
unsafe extern "system" fn ocs_on_show(_: *mut SiteObj, _: BOOL) -> HRESULT { HRESULT(0) }

static OCS_VTBL: OCSVtbl = OCSVtbl {
    qi: ocs_qi, add_ref: ocs_addref, release: ocs_release,
    save_object: ocs_e_notimpl, get_moniker: ocs_get_moniker,
    get_container: ocs_get_container, show_object: ocs_s_ok,
    on_show: ocs_on_show, request_new: ocs_e_notimpl,
};

// ── IOleInPlaceSite methods ───────────────────────────────────────────────────

unsafe extern "system" fn ips_qi(this: *mut IPSInner, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    ocs_qi((*this).parent, riid, ppv)
}
unsafe extern "system" fn ips_addref(this: *mut IPSInner) -> u32 { ocs_addref((*this).parent) }
unsafe extern "system" fn ips_release(this: *mut IPSInner) -> u32 { ocs_release((*this).parent) }
unsafe extern "system" fn ips_get_window(this: *mut IPSInner, phwnd: *mut HWND) -> HRESULT
    { *phwnd = (*(*this).parent).hwnd; HRESULT(0) }
unsafe extern "system" fn ips_ctx_help(_: *mut IPSInner, _: BOOL) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_can_inplace(_: *mut IPSInner) -> HRESULT { HRESULT(0) } // S_OK = yes
unsafe extern "system" fn ips_on_inplace(_: *mut IPSInner) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_on_ui_act(_: *mut IPSInner) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_get_wnd_ctx(
    this: *mut IPSInner,
    pp_frame: *mut *mut c_void, pp_doc: *mut *mut c_void,
    rc_pos: *mut RECT, rc_clip: *mut RECT, _frame_info: *mut c_void,
) -> HRESULT {
    if !pp_frame.is_null() { *pp_frame = std::ptr::null_mut(); }
    if !pp_doc.is_null()   { *pp_doc   = std::ptr::null_mut(); }
    let r = RECT { left: 0, top: 0, right: 100, bottom: 100 };
    if !rc_pos.is_null()  { *rc_pos  = r; }
    if !rc_clip.is_null() { *rc_clip = r; }
    let _ = this; HRESULT(0)
}
unsafe extern "system" fn ips_scroll(_: *mut IPSInner, _: i32, _: i32) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_on_ui_deact(_: *mut IPSInner, _: BOOL) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_on_deact(_: *mut IPSInner) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_discard(_: *mut IPSInner) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_deact_undo(_: *mut IPSInner) -> HRESULT { HRESULT(0) }
unsafe extern "system" fn ips_pos_change(_: *mut IPSInner, _: *const RECT) -> HRESULT { HRESULT(0) }

static IPS_VTBL: IPSVtbl = IPSVtbl {
    qi: ips_qi, add_ref: ips_addref, release: ips_release,
    get_window: ips_get_window, ctx_help: ips_ctx_help,
    can_inplace: ips_can_inplace, on_inplace: ips_on_inplace,
    on_ui_act: ips_on_ui_act, get_wnd_ctx: ips_get_wnd_ctx,
    scroll: ips_scroll, on_ui_deact: ips_on_ui_deact, on_deact: ips_on_deact,
    discard: ips_discard, deact_undo: ips_deact_undo, pos_change: ips_pos_change,
};

fn make_site(hwnd: HWND) -> Box<SiteObj> {
    let mut s = Box::new(SiteObj {
        ocs_vtbl:  &OCS_VTBL,
        ips_inner: IPSInner { vtbl: &IPS_VTBL, parent: std::ptr::null_mut() },
        ref_count: 1,
        hwnd,
    });
    s.ips_inner.parent = &mut *s as *mut SiteObj;
    s
}

// ── IDispatch helpers ─────────────────────────────────────────────────────────

#[repr(C)]
struct VarRaw { vt: u16, _pad: [u16; 3], data: VarData }
#[repr(C)]
union VarData { l_val: i32, i16_val: i16, _u64: u64 }

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

fn put_bool_prop(disp: &IDispatch, name: &str, val: bool) -> Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        let r = &mut var as *mut VARIANT as *mut VarRaw;
        (*r).vt = 11; (*r).data.i16_val = if val { -1i16 } else { 0i16 }; // VT_BOOL
        let mut named = -3i32;
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None)
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
        let v = match (*r).vt {
            2  => Some((*r).data.i16_val as i32),                           // VT_I2
            3  => Some((*r).data.l_val),                                     // VT_I4
            11 => Some(if (*r).data.i16_val != 0 { 1 } else { 0 }),         // VT_BOOL
            _ => { eprintln!("[rdp_test] {name} VT={}", (*r).vt); None }
        };
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
        eprintln!("[rdp_test] IMsTscNonScriptable: not available"); return false;
    };
    let ns_vtbl: *const usize = *(ns as *const *const usize);
    let pw = BSTR::from(password);
    type PutFn = unsafe extern "system" fn(*mut c_void, *mut u16) -> i32;
    let put: PutFn = std::mem::transmute(*ns_vtbl.add(3));
    let hr = put(ns, pw.as_ptr() as *mut u16);
    raw_release(ns);
    eprintln!("[rdp_test] IMsTscNonScriptable::put_ClearTextPassword hr=0x{hr:08X}");
    hr >= 0
}

// ── Credential Manager ────────────────────────────────────────────────────────

// DPAPI-encrypt a UTF-16LE password. mstscax reads the GENERIC credential blob
// and calls CryptUnprotectData on it — the result must be the UTF-16LE password.
fn dpapi_encrypt(password: &str) -> Option<Vec<u8>> {
    extern "system" { fn LocalFree(p: *mut std::ffi::c_void) -> *mut std::ffi::c_void; }
    let pw_bytes: Vec<u8> = password.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    unsafe {
        let mut input  = CRYPT_INTEGER_BLOB { cbData: pw_bytes.len() as u32, pbData: pw_bytes.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = CryptProtectData(&mut input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).is_ok();
        if ok && !output.pbData.is_null() {
            let blob = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as *mut _);
            eprintln!("[rdp_test] dpapi_encrypt: {} plaintext bytes → {} blob bytes", pw_bytes.len(), blob.len());
            // Verify round-trip: decrypt immediately to confirm mstscax can read it.
            let mut enc = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
            let mut dec = CRYPT_INTEGER_BLOB::default();
            let vok = CryptUnprotectData(&mut enc, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut dec).is_ok();
            if vok && !dec.pbData.is_null() {
                let plain = std::slice::from_raw_parts(dec.pbData, dec.cbData as usize).to_vec();
                LocalFree(dec.pbData as *mut _);
                // Re-encode expected to compare
                let expected = pw_bytes.clone();
                if plain == expected {
                    eprintln!("[rdp_test] dpapi round-trip OK — blob decrypts correctly");
                } else {
                    eprintln!("[rdp_test] dpapi round-trip MISMATCH — decrypted {} bytes, expected {}", plain.len(), expected.len());
                }
            } else {
                eprintln!("[rdp_test] dpapi round-trip DECRYPT FAILED");
            }
            Some(blob)
        } else {
            eprintln!("[rdp_test] dpapi_encrypt FAILED — falling back to plain UTF-16LE");
            None
        }
    }
}

fn store_cred(host: &str, port: u16, user_plain: &str, password: &str) {
    let targets: Vec<String> = if port == 3389 {
        vec![format!("TERMSRV/{}", host)]
    } else {
        vec![format!("TERMSRV/{}", host), format!("TERMSRV/{}:{}", host, port)]
    };
    // GENERIC with DPAPI-encrypted blob: mstscax finds this credential, calls
    // CryptUnprotectData on the blob, and uses the resulting plaintext for NLA.
    // This is what suppresses the mstscax credential dialog entirely.
    let pw_utf16: Vec<u8> = password.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let blob = dpapi_encrypt(password).unwrap_or_else(|| pw_utf16.clone());
    for target in &targets {
        let mut target_w: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let mut user_w:   Vec<u16> = user_plain.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let _ = CredDeleteW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, Some(0));
            let _ = CredDeleteW(PCWSTR(target_w.as_ptr()), CRED_TYPE_DOMAIN_PASSWORD, Some(0));
            let cred = CREDENTIALW {
                Flags: CRED_FLAGS(0),
                Type: CRED_TYPE_GENERIC,
                TargetName: windows::core::PWSTR(target_w.as_mut_ptr()),
                Comment: windows::core::PWSTR::null(),
                LastWritten: std::mem::zeroed(),
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: windows::core::PWSTR::null(),
                UserName: windows::core::PWSTR(user_w.as_mut_ptr()),
            };
            let ok = CredWriteW(&cred, 0).is_ok();
            eprintln!("[rdp_test] CredWriteW {target} user={user_plain} GENERIC/DPAPI blob={} ok={ok}", blob.len());
        }
    }
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

    let combined_user = if domain_str.is_empty() {
        user_str.to_string()
    } else {
        format!("{}\\{}", domain_str, user_str)
    };

    eprintln!("[rdp_test] host={host}:{port}  user={user_str}  domain={domain_str}");
    eprintln!("[rdp_test] password length: {} chars", password.len());

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // Hidden host window
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0), w!("STATIC"), w!("rdp_test"),
            WS_POPUP, 0, 0, 100, 100, None, None, None, None,
        ).unwrap_or(HWND(std::ptr::null_mut()));
        eprintln!("[rdp_test] HWND {:?}", hwnd.0);

        // CoCreate mstscax
        let rdp_unk: IUnknown = CoCreateInstance(&CLSID_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_9, None, CLSCTX_INPROC_SERVER))
            .expect("CoCreateInstance");
        eprintln!("[rdp_test] CoCreateInstance ok");

        let raw_rdp = rdp_unk.as_raw() as *mut c_void;

        // ── OLE hosting: SetClientSite + DoVerb ───────────────────────────────
        let mut site = make_site(hwnd);
        let site_ocs = &mut *site as *mut SiteObj as *mut c_void;   // IOleClientSite ptr
        let site_ips = &mut site.ips_inner as *mut IPSInner as *mut c_void; // IOleInPlaceSite ptr

        if let Some(ole) = raw_qi(raw_rdp, &IID_IOLE_OBJECT) {
            eprintln!("[rdp_test] IOleObject ok");
            let v: *const usize = *(ole as *const *const usize);

            // IOleObject::SetClientSite (vtable[3])
            type SetSiteFn = unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32;
            let set_site: SetSiteFn = std::mem::transmute(*v.add(3));
            let hr = set_site(ole, site_ocs);
            eprintln!("[rdp_test] SetClientSite hr=0x{hr:08X}");

            // IOleObject::DoVerb OLEIVERB_INPLACEACTIVATE = -5 (vtable[11])
            type DoVerbFn = unsafe extern "system" fn(*mut c_void, i32, *const MSG, *mut c_void, i32, HWND, *const RECT) -> i32;
            let do_verb: DoVerbFn = std::mem::transmute(*v.add(11));
            let rect = RECT { left: 0, top: 0, right: 100, bottom: 100 };
            let hr2 = do_verb(ole, -5, std::ptr::null(), site_ips, -1, hwnd, &rect);
            eprintln!("[rdp_test] DoVerb(INPLACE_ACTIVATE) hr=0x{hr2:08X}");
            if hr2 != 0 {
                // Try OLEIVERB_SHOW = -1 as fallback
                let hr3 = do_verb(ole, -1, std::ptr::null(), site_ips, -1, hwnd, &rect);
                eprintln!("[rdp_test] DoVerb(SHOW) hr=0x{hr3:08X}");
            }

            raw_release(ole);
        } else {
            eprintln!("[rdp_test] WARNING: IOleObject not available");
        }

        // ── Store credential in Windows Credential Manager ────────────────────
        // Uses CRED_TYPE_DOMAIN_PASSWORD with plain UTF-16LE — same as cmdkey.
        // mstscax/CredSSP finds it by TERMSRV/<host> and performs silent NLA.
        store_cred(host, port, &combined_user, password);

        // ── RDP properties via IDispatch ──────────────────────────────────────
        let disp: IDispatch = rdp_unk.cast().expect("IDispatch");

        put_bstr(&disp, "Server", host);
        put_i32(&disp, "RDPPort", port as i32);
        // Combined "DOMAIN\user" — matches the DOMAIN_PASSWORD credential by username.
        put_bstr(&disp, "UserName", &combined_user);
        put_i32(&disp, "AuthenticationLevel", 0);
        eprintln!("[rdp_test] Server/UserName set (combined={combined_user})");

        let adv_names = ["AdvancedSettings9","AdvancedSettings7","AdvancedSettings5","AdvancedSettings2"];
        let adv = adv_names.iter().find_map(|n| get_sub_disp(&disp, n).map(|d| { eprintln!("[rdp_test] {n}"); d }));
        if let Some(ref adv) = adv {
            put_i32(adv, "RDPPort", port as i32);
            put_i32(adv, "AuthenticationLevel", 0);
            put_i32(adv, "EnableCredSspSupport", 1);
            // Suppress the credential dialog — mstscax must use the CredMgr entry silently.
            // Without these, mstscax shows the ATL prompt even when a credential is stored.
            let r1 = put_bool_prop(adv, "PromptForCredentials", false);
            let r2 = put_bool_prop(adv, "PromptForCredentialsOnClient", false);
            eprintln!("[rdp_test] PromptForCredentials hr=0x{:08X}  PromptForCredentialsOnClient hr=0x{:08X}",
                r1.err().map(|e| e.code().0 as u32).unwrap_or(0),
                r2.err().map(|e| e.code().0 as u32).unwrap_or(0));
        }

        // Do NOT use ClearTextPassword or IMsTscNonScriptable — we want to test
        // that mstscax picks up the DOMAIN_PASSWORD credential silently.
        eprintln!("[rdp_test] Skipping ClearTextPassword (testing CredMgr path)");
        let _ = try_ns_clear_text_password; // suppress unused-fn warning

        // ── Connect ───────────────────────────────────────────────────────────
        eprintln!("[rdp_test] Connect()...");
        match call_no_args(&disp, "Connect") {
            Ok(()) => eprintln!("[rdp_test] Connect() ok"),
            Err(e) => { eprintln!("[rdp_test] Connect() FAILED: {e}"); std::process::exit(1); }
        }

        // ── Poll Connected (0=disc 1=conn 2=connecting) ───────────────────────
        eprintln!("[rdp_test] Polling Connected for 30s...");
        let start = std::time::Instant::now();
        let mut prev: i32 = -999;
        let mut saw_connecting = false;
        let mut msg = MSG::default();

        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let state = get_i32_prop(&disp, "Connected").unwrap_or(-1);
            if state != prev {
                eprintln!("[rdp_test] Connected={state}");
                if state == 2 { saw_connecting = true; }
                prev = state;
            }

            if state == 1 {
                println!("[rdp_test] SUCCESS: Connected to {host}:{port} as {username}");
                let _ = call_no_args(&disp, "Disconnect");
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::process::exit(0);
            }
            if state == 0 && saw_connecting {
                let ext = get_i32_prop(&disp, "ExtendedDisconnectReason").unwrap_or(-1);
                println!("[rdp_test] FAILED: disconnected after connecting");
                println!("[rdp_test]   ExtendedDisconnectReason={ext}");
                println!("[rdp_test]   Most likely: wrong password (NLA rejected).");
                println!("[rdp_test]   Test manually: mstsc /v:{host}:{port}");
                std::process::exit(1);
            }
            if start.elapsed() > std::time::Duration::from_secs(30) {
                println!("[rdp_test] TIMEOUT (30s) Connected={prev} saw_connecting={saw_connecting}");
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
