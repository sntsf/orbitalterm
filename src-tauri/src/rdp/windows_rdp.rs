#![cfg(target_os = "windows")]

//! Embedded RDP on Windows via COM in-process hosting of mstscax.dll.
//! No mstsc.exe process is launched — identical to mRemoteNG's approach.
//!
//! ## Z-order and WebView2
//! WebView2 renders via DirectComposition (DComp). Traditional WS_CHILD windows
//! exist in the Win32 z-order which lies BELOW the DComp layer — they appear
//! as black rectangles regardless of HWND_TOP. The fix is to use a WS_POPUP
//! window (not WS_CHILD) owned by the Tauri window so it floats above the DComp
//! layer while still allowing other applications to be brought to the foreground.
//!
//! ## Reparenting and deadlocks
//! SetWindowLongPtrW(GWLP_HWNDPARENT) sends a synchronous cross-thread Win32
//! message that deadlocks the COM STA thread. We therefore never call it after
//! creation. Tearout/dock-back just updates the tracked parent variable so
//! canvas_to_screen() uses the correct reference window for positioning.

use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Foundation::{E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{implement, w, BOOL, BSTR, GUID, IUnknown, Interface, OutRef, Ref, PCWSTR};

// MsRdpClient10 (Windows 10+); MsRdpClient9 used as fallback
const CLSID_MSTSC_10: GUID = GUID::from_values(
    0xC0EFA91A, 0xEEB7, 0x41C7,
    [0x97, 0xFA, 0xF0, 0xED, 0x64, 0x5E, 0xFB, 0x24],
);
const CLSID_MSTSC_9: GUID = GUID::from_values(
    0x8B918B82, 0x7985, 0x4C24,
    [0x89, 0xDF, 0xC3, 0x3A, 0xD2, 0xBB, 0xFB, 0xCD],
);

// ── Command channel ───────────────────────────────────────────────────────────

enum ComCmd {
    Reposition { x: i32, y: i32, width: i32, height: i32 },
    Show,
    Hide,
    Disconnect,
    Reparent { new_parent: isize, rel_x: i32, rel_y: i32, width: i32, height: i32 },
}

// ── Session ───────────────────────────────────────────────────────────────────

pub struct WindowsRdpSession {
    tx: mpsc::SyncSender<ComCmd>,
}

unsafe impl Send for WindowsRdpSession {}
unsafe impl Sync for WindowsRdpSession {}

impl Drop for WindowsRdpSession {
    fn drop(&mut self) {
        let _ = self.tx.send(ComCmd::Disconnect);
    }
}

// ── OLE Frame ─────────────────────────────────────────────────────────────────
//
// IOleInPlaceFrame represents the outermost application window.
// Its GetWindow() MUST return the top-level frame (Tauri main window), NOT the
// container child window — mstscax uses this to know the app boundary.
// If we return the wrong HWND here, DoVerb(-5) silently fails → black screen.

#[implement(IOleInPlaceFrame)]
struct RdpFrame {
    hwnd: HWND, // top-level application window (Tauri main window)
}

impl IOleWindow_Impl for RdpFrame_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceUIWindow_Impl for RdpFrame_Impl {
    fn GetBorder(&self) -> windows::core::Result<RECT> { Err(E_NOTIMPL.into()) }
    fn RequestBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetActiveObject(
        &self,
        _: Ref<'_, IOleInPlaceActiveObject>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceFrame_Impl for RdpFrame_Impl {
    fn InsertMenus(&self, _: HMENU, _: *mut OLEMENUGROUPWIDTHS) -> windows::core::Result<()> { Ok(()) }
    fn SetMenu(&self, _: HMENU, _: isize, _: HWND) -> windows::core::Result<()> { Ok(()) }
    fn RemoveMenus(&self, _: HMENU) -> windows::core::Result<()> { Ok(()) }
    fn SetStatusText(&self, _: &PCWSTR) -> windows::core::Result<()> { Ok(()) }
    fn EnableModeless(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn TranslateAccelerator(&self, _: *const MSG, _: u16) -> windows::core::Result<()> {
        // S_FALSE tells the control the container didn't handle it → control processes it
        Err(windows::Win32::Foundation::S_FALSE.into())
    }
}

// ── OLE Site ──────────────────────────────────────────────────────────────────
//
// IOleClientSite + IOleInPlaceSite represent the immediate container window
// (host_hwnd). GetWindow() here returns host_hwnd (the popup we own).

#[implement(IOleClientSite, IOleInPlaceSite)]
struct RdpSite {
    hwnd: HWND,              // container popup window (host_hwnd)
    frame: IOleInPlaceFrame, // top-level frame (kept alive for GetWindowContext)
}

// SAFETY: used exclusively on the dedicated STA COM thread
unsafe impl Send for RdpSite {}

impl IOleClientSite_Impl for RdpSite_Impl {
    fn SaveObject(&self) -> windows::core::Result<()> { Err(E_NOTIMPL.into()) }
    fn GetMoniker(&self, _: &OLEGETMONIKER, _: &OLEWHICHMK) -> windows::core::Result<IMoniker> {
        Err(E_NOTIMPL.into())
    }
    fn GetContainer(&self) -> windows::core::Result<IOleContainer> { Err(E_NOTIMPL.into()) }
    fn ShowObject(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnShowWindow(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn RequestNewObjectLayout(&self) -> windows::core::Result<()> { Err(E_NOTIMPL.into()) }
}

impl IOleWindow_Impl for RdpSite_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceSite_Impl for RdpSite_Impl {
    fn CanInPlaceActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnInPlaceActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnUIActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn GetWindowContext(
        &self,
        ppframe: OutRef<'_, IOleInPlaceFrame>,
        ppdoc: OutRef<'_, IOleInPlaceUIWindow>,
        lprcposrect: *mut RECT,
        lprccliprect: *mut RECT,
        lpframeinfo: *mut OLEINPLACEFRAMEINFO,
    ) -> windows::core::Result<()> {
        unsafe {
            // ppframe → top-level app frame (critical — must be non-null)
            ppframe.write(Some(self.frame.clone()));
            // ppdoc → null for SDI (no separate document window)
            ppdoc.write(None);
            let mut rc = RECT::default();
            GetClientRect(self.hwnd, &mut rc).ok();
            if !lprcposrect.is_null()  { *lprcposrect  = rc; }
            if !lprccliprect.is_null() { *lprccliprect = rc; }
            if !lpframeinfo.is_null() {
                (*lpframeinfo).cb            = std::mem::size_of::<OLEINPLACEFRAMEINFO>() as u32;
                (*lpframeinfo).fMDIApp       = BOOL(0);
                (*lpframeinfo).hwndFrame     = self.hwnd;
                (*lpframeinfo).haccel        = HACCEL::default();
                (*lpframeinfo).cAccelEntries = 0;
            }
        }
        Ok(())
    }
    fn Scroll(&self, _: &windows::Win32::Foundation::SIZE) -> windows::core::Result<()> { Ok(()) }
    fn OnUIDeactivate(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn OnInPlaceDeactivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn DiscardUndoState(&self) -> windows::core::Result<()> { Ok(()) }
    fn DeactivateAndUndo(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnPosRectChange(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
}

// ── IDispatch helpers ─────────────────────────────────────────────────────────

fn get_dispid(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let pcwstr = PCWSTR(wide.as_ptr());
    let mut id = 0i32;
    unsafe { disp.GetIDsOfNames(&GUID::zeroed(), &pcwstr, 1, 0x0409, &mut id)?; }
    Ok(id)
}

// VARIANT on Win64: u16 vt + u16[3] reserved + 8-byte data = 16 bytes total.
#[repr(C)]
union VarData { bstrVal: *mut u16, lVal: i32, boolVal: i16, pdispVal: *mut core::ffi::c_void }
#[repr(C)]
struct VarRaw { vt: u16, _r: [u16; 3], data: VarData }

fn put_bstr(disp: &IDispatch, name: &str, value: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    let bval = std::mem::ManuallyDrop::new(BSTR::from(value));
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 8; (*r).data.bstrVal = bval.as_ptr() as *mut u16; }
        let mut named = DISPID_PROPERTYPUT;
        let res = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None);
        VariantClear(&mut var).ok();
        res
    }
}

fn put_i4(disp: &IDispatch, name: &str, value: i32) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 3; (*r).data.lVal = value; }
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None)
    }
}

fn put_bool_prop(disp: &IDispatch, name: &str, value: bool) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 11; (*r).data.boolVal = if value { -1i16 } else { 0i16 }; }
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None)
    }
}

fn get_dispatch_sub(disp: &IDispatch, name: &str) -> windows::core::Result<IDispatch> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None)?;
        let r = &result as *const VARIANT as *const VarRaw;
        if (*r).vt == 9 {
            let raw = (*r).data.pdispVal;
            if !raw.is_null() {
                (*(r as *mut VarRaw)).vt = 0;
                return Ok(IDispatch::from_raw(raw));
            }
        }
        VariantClear(&mut result).ok();
        Err(E_NOTIMPL.into())
    }
}

fn get_i4(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None)?;
        let r = &result as *const VARIANT as *const VarRaw;
        let val = if (*r).vt == 3 { (*r).data.lVal } else { 0 };
        VariantClear(&mut result).ok();
        Ok(val)
    }
}

// Write credentials directly into Windows Credential Manager via CredWriteW.
// More reliable than spawning cmdkey.exe (no process creation, no UAC, no
// quoting issues). NLA/CredSSP picks these up automatically during Connect().
fn store_rdp_credential(host: &str, port: u16, username: &str, domain: &str, password: &str) {
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_DOMAIN_PASSWORD, CRED_TYPE_GENERIC,
    };
    use windows::core::PWSTR;

    // Build the set of (target, username) pairs to store.
    // CredSSP looks up TERMSRV/<host> with type CRED_TYPE_GENERIC.
    // For local accounts (no domain), also store with the ".\username" prefix
    // that Windows uses internally so CredSSP finds the credential regardless
    // of which username format it resolves to.
    let user_plain = if domain.is_empty() {
        username.to_owned()
    } else {
        format!("{}\\{}", domain, username)
    };
    let user_dot = if domain.is_empty() {
        Some(format!(".\\{}", username))
    } else {
        None
    };

    let mut base_targets = vec![format!("TERMSRV/{}", host)];
    if port != 3389 {
        base_targets.push(format!("TERMSRV/{}:{}", host, port));
    }

    // Credential blob is the password as UTF-16LE with no null terminator.
    let pw_blob: Vec<u8> = password
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();

    for target in &base_targets {
        let mut target_wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        // Build the list of username variants to store for this target.
        let mut user_variants: Vec<String> = vec![user_plain.clone()];
        if let Some(ref dot) = user_dot { user_variants.push(dot.clone()); }
        for user_str in &user_variants {
            let mut user_wide: Vec<u16> = user_str.encode_utf16().chain(Some(0)).collect();
            // mstsc.exe stores as CRED_TYPE_GENERIC; CredSSP reads GENERIC.
            // DOMAIN_PASSWORD is kept for fallback on domain-joined targets.
            for cred_type in [CRED_TYPE_GENERIC, CRED_TYPE_DOMAIN_PASSWORD] {
                let cred = CREDENTIALW {
                    Flags: CRED_FLAGS(0),
                    Type: cred_type,
                    TargetName: PWSTR(target_wide.as_mut_ptr()),
                    Comment: PWSTR::null(),
                    LastWritten: unsafe { std::mem::zeroed() },
                    CredentialBlobSize: pw_blob.len() as u32,
                    CredentialBlob: pw_blob.as_ptr() as *mut u8,
                    Persist: CRED_PERSIST_LOCAL_MACHINE,
                    AttributeCount: 0,
                    Attributes: std::ptr::null_mut(),
                    TargetAlias: PWSTR::null(),
                    UserName: PWSTR(user_wide.as_mut_ptr()),
                };
                let ok = unsafe { CredWriteW(&cred, 0).is_ok() };
                eprintln!("[rdp] CredWriteW {target} user={user_str} type={} ok={ok}", cred_type.0);
            }
        }
    }
}

// Suppress the two dialogs that appear on every RDP connection:
//   1. Clipboard/redirect security warning
//   2. "Windows Security – enter credentials" credential prompt
//
// The April-2026 Windows security update replaced the old WarnAbout* dialog
// system with a new per-connection redirection warning dialog. The new system
// ignores WarnAbout* (they return E_INVALIDARG). The fix is to QI for
// IMsRdpExtendedSettings and set RedirectionWarningDialogVersion=1, which
// reverts to the pre-update dialog behavior where WarnAbout*=FALSE is honored.
// Reference: https://support.microsoft.com/kb/5057577 (developer section)
unsafe fn suppress_rdp_dialogs(rdp_unk: &IUnknown) {
    // IIDs
    // IMsRdpExtendedSettings 302D8188-0052-4807-806A-362B628F9AC5 (property bag)
    // NS3                    B3378D90-0728-45C7-8ED7-B6159FB92219 (QI confirmed)
    // NS5                    4EB5335B-6429-477D-B922-D06B48F2D364 (E_NOINTERFACE)
    const IID_EXT: GUID = GUID::from_values(
        0x302D8188, 0x0052, 0x4807,
        [0x80, 0x6A, 0x36, 0x2B, 0x62, 0x8F, 0x9A, 0xC5],
    );
    const IID_NS3: GUID = GUID::from_values(
        0xB3378D90, 0x0728, 0x45C7,
        [0x8E, 0xD7, 0xB6, 0x15, 0x9F, 0xB9, 0x22, 0x19],
    );
    const IID_NS5: GUID = GUID::from_values(
        0x4EB5335B, 0x6429, 0x477D,
        [0xB9, 0x22, 0xD0, 0x6B, 0x48, 0xF2, 0xD3, 0x64],
    );

    type QIFn       = unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> i32;
    type PutBool    = unsafe extern "system" fn(*mut core::ffi::c_void, i16) -> i32;
    type PutPropFn  = unsafe extern "system" fn(*mut core::ffi::c_void, *mut u16, *mut VARIANT) -> i32;
    type RelFn      = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;

    let raw = rdp_unk.as_raw() as *mut core::ffi::c_void;
    let unk_vtbl: *const usize = *(raw as *const *const usize);
    let qi: QIFn = core::mem::transmute(*unk_vtbl.add(0));

    // ── IMsRdpExtendedSettings: revert April-2026 redirection dialog ──────────
    // Vtable: [0-2] IUnknown, [3] put_Property, [4] get_Property
    // Must be called AFTER DoVerb — before activation the interface pointer is
    // uninitialised and Release() on it crashes (STATUS_ACCESS_VIOLATION).
    //
    // Safety notes:
    //  • IUnknown::from_raw takes ownership of the QI'd pointer and calls
    //    Release through windows-rs's type-safe mechanism when dropped.
    //  • ManuallyDrop<BSTR> prevents a double-free if the callee incorrectly
    //    releases the [in] BSTR parameter (non-standard but observed behaviour).
    let mut ext_raw: *mut core::ffi::c_void = core::ptr::null_mut();
    let hr_ext = qi(raw, &IID_EXT, &mut ext_raw);
    eprintln!("[rdp] QI IMsRdpExtendedSettings hr=0x{:08X}", hr_ext as u32);
    if hr_ext >= 0 && !ext_raw.is_null() {
        let ext_unk = IUnknown::from_raw(ext_raw as *mut _); // owns the ref; Release on drop
        let ev: *const usize = *(ext_unk.as_raw() as *const *const usize);
        let put_prop: PutPropFn = core::mem::transmute(*ev.add(3));
        let prop = core::mem::ManuallyDrop::new(BSTR::from("RedirectionWarningDialogVersion"));
        let mut val: VARIANT = core::mem::zeroed();
        { let r = &mut val as *mut VARIANT as *mut VarRaw; (*r).vt = 3; (*r).data.lVal = 1; }
        let h = put_prop(ext_unk.as_raw() as *mut _, prop.as_ptr() as *mut u16, &mut val);
        eprintln!("[rdp] ExtSettings RedirectionWarningDialogVersion=1 hr=0x{:08X}", h as u32);
        // ext_unk dropped here → Release via windows-rs (safe even if put_prop failed)
    }

    // ── NS3: WarnAboutClipboardRedirection + WarnAboutSendingCredentials ──────
    // Flat vtable offsets (NS3 pointer):
    //   [0-2]  IUnknown
    //   [3-4]  NS1: NotifyRedirectDeviceChange, SendKeys
    //   [5-16] NS2 (inherited): UIParentWindowHandle(2), ShowRedirectionWarningDialog(2),
    //               PromptForCredentials(2), NegotiateSecurityLayer(2),
    //               EnableCredSspSupport(2), AuthenticationServiceClass(2)
    //   [17] get_WarnAboutSendingCredentials
    //   [18] put_WarnAboutSendingCredentials
    //   [19] get_WarnAboutClipboardRedirection
    //   [20] put_WarnAboutClipboardRedirection
    //   [21] get_ConnectionBarText
    //   [22] put_ConnectionBarText
    let mut ns3: *mut core::ffi::c_void = core::ptr::null_mut();
    if qi(raw, &IID_NS3, &mut ns3) >= 0 && !ns3.is_null() {
        let v: *const usize = *(ns3 as *const *const usize);
        let put_show_redir:   PutBool = core::mem::transmute(*v.add(8));  // ShowRedirectionWarningDialog (NS2)
        let put_prompt_creds: PutBool = core::mem::transmute(*v.add(10)); // PromptForCredentials (NS2)
        let put_neg_sec:      PutBool = core::mem::transmute(*v.add(12)); // NegotiateSecurityLayer (NS2)
        let put_warn_creds:   PutBool = core::mem::transmute(*v.add(18)); // WarnAboutSendingCredentials (NS3)
        let put_warn_clip:    PutBool = core::mem::transmute(*v.add(20)); // WarnAboutClipboardRedirection (NS3)
        let release: RelFn            = core::mem::transmute(*v.add(2));
        let h1 = put_show_redir(ns3, 0i16);
        let h2 = put_prompt_creds(ns3, 0i16);
        let h3 = put_neg_sec(ns3, -1i16);
        let h4 = put_warn_creds(ns3, 0i16);
        let h5 = put_warn_clip(ns3, 0i16);
        eprintln!("[rdp] NS2 ShowRedirectionWarningDialog=0  hr=0x{:08X}", h1 as u32);
        eprintln!("[rdp] NS2 PromptForCredentials=0          hr=0x{:08X}", h2 as u32);
        eprintln!("[rdp] NS2 NegotiateSecurityLayer=1         hr=0x{:08X}", h3 as u32);
        eprintln!("[rdp] NS3 WarnAboutSendingCredentials=0   hr=0x{:08X}", h4 as u32);
        eprintln!("[rdp] NS3 WarnAboutClipboardRedirection=0  hr=0x{:08X}", h5 as u32);
        release(ns3);
    }

    // ── NS5: AllowPromptingForCredentials ────────────────────────────────────
    // NS5 vtable [30] put_AllowPromptingForCredentials (E_NOINTERFACE on this Windows)
    let mut ns5: *mut core::ffi::c_void = core::ptr::null_mut();
    let hr5 = qi(raw, &IID_NS5, &mut ns5);
    eprintln!("[rdp] QI NS5 hr=0x{:08X}", hr5 as u32);
    if hr5 >= 0 && !ns5.is_null() {
        let v: *const usize = *(ns5 as *const *const usize);
        let put_allow: PutBool = core::mem::transmute(*v.add(30));
        let release: RelFn     = core::mem::transmute(*v.add(2));
        let h = put_allow(ns5, 0i16);
        eprintln!("[rdp] NS5 AllowPromptingForCredentials=0 hr=0x{:08X}", h as u32);
        release(ns5);
    }
}

fn call_no_args(disp: &IDispatch, name: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_METHOD,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            None, None, None)
    }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

/// Map a point in `hwnd`'s client coordinates to screen coordinates.
///
/// `ClientToScreen` is not exposed by the `windows` crate bindings, so we
/// derive the same result from `GetWindowRect` (outer position) and
/// `GetClientRect` (client size).  For standard Win32 windows:
///   left_border == right_border == bottom_border  (symmetric frame)
///   top_border = outer_height - client_height - left_border
///
/// This is exact for Tauri windows because WebView2 fills the whole client area
/// and there is no custom client-area padding.
unsafe fn canvas_to_screen(hwnd: HWND, cx: i32, cy: i32) -> (i32, i32) {
    let mut outer = RECT::default();
    let mut inner = RECT::default();
    GetWindowRect(hwnd, &mut outer).ok();
    GetClientRect(hwnd, &mut inner).ok();
    let outer_w = outer.right - outer.left;
    let outer_h = outer.bottom - outer.top;
    let client_w = inner.right;  // GetClientRect top-left is always (0,0)
    let client_h = inner.bottom;
    let bx = (outer_w - client_w) / 2;  // left/right frame
    let by = outer_h - client_h - bx;   // top = title bar + top frame
    (outer.left + bx + cx, outer.top + by + cy)
}

// ── Host window class ─────────────────────────────────────────────────────────

const HOST_CLASS: PCWSTR = w!("OrbRdpHostWnd");

unsafe extern "system" fn host_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn register_host_class() {
    unsafe {
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(host_wnd_proc),
            lpszClassName: HOST_CLASS,
            hInstance: hmod.into(),
            ..Default::default()
        };
        RegisterClassW(&wc);
    }
}

// ── STA thread ────────────────────────────────────────────────────────────────

struct LaunchParams {
    parent_hwnd: isize,
    host: String,
    port: u16,
    username: String,
    domain: String,
    password: Option<String>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    admin_mode: bool,
}

fn sta_thread(
    params: LaunchParams,
    result_tx: mpsc::SyncSender<Result<mpsc::SyncSender<ComCmd>, String>>,
) {
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            let _ = result_tx.send(Err("CoInitializeEx failed".into()));
            return;
        }

        register_host_class();

        let hmod = GetModuleHandleW(None).unwrap_or_default();
        // parent = Tauri main window (top-level application frame)
        let mut parent = HWND(params.parent_hwnd as *mut _);
        let w = params.width.max(640);
        let h = params.height.max(480);

        // Convert canvas-relative coords to screen coords.
        // The params x/y are relative to the Tauri window's client area.
        let (sx, sy) = canvas_to_screen(parent, params.x, params.y);

        // WS_POPUP (not WS_CHILD): floats above WebView2's DirectComposition layer.
        // WS_CHILD windows sit below DComp and appear black regardless of z-order.
        // WS_EX_TOOLWINDOW: suppress taskbar entry for this auxiliary window.
        // Passing `parent` as hWndParent sets the Win32 owner at creation time —
        // owned popups stay above their owner in z-order but are NOT topmost,
        // so other applications can be brought to the foreground normally.
        // Never change the owner at runtime via SetWindowLongPtrW(GWLP_HWNDPARENT):
        // that sends a synchronous cross-thread Win32 message which deadlocks.
        let host_hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            HOST_CLASS, w!(""),
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            sx, sy, w, h,
            Some(parent), None, Some(hmod.into()), None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = result_tx.send(Err(format!("CreateWindowExW: {e}")));
                CoUninitialize();
                return;
            }
        };

        // HWND_TOP: owned popup (owner set in CreateWindowExW) stays above its
        // owner (Tauri) in z-order but is NOT always-on-top, so other applications
        // can be brought to the foreground normally.
        // Start hidden: shown by the tick once ConnectionState == 2, so no white
        // flash appears during NLA/cert authentication dialogs.
        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, w, h,
            SWP_NOACTIVATE).ok();

        // Try MsRdpClient10 first, fall back to MsRdpClient9 for older Windows
        let rdp_unk: IUnknown = match CoCreateInstance(&CLSID_MSTSC_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_MSTSC_9, None, CLSCTX_INPROC_SERVER))
        {
            Ok(u) => u,
            Err(e) => {
                let _ = result_tx.send(Err(format!(
                    "mstscax.dll no encontrado ({e})\nInstala Remote Desktop Connection."
                )));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        let ole_obj: IOleObject = match rdp_unk.cast() {
            Ok(o) => o,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IOleObject QI: {e}")));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        // frame → top-level application window (Tauri main window).
        // IOleInPlaceFrame::GetWindow MUST return the top-level frame, not the
        // container. mstscax validates this to create its rendering surface.
        let frame: IOleInPlaceFrame = RdpFrame { hwnd: parent }.into();
        let site: IOleClientSite = RdpSite { hwnd: host_hwnd, frame: frame.clone() }.into();

        if let Err(e) = ole_obj.SetClientSite(Some(&site)) {
            let _ = result_tx.send(Err(format!("SetClientSite: {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let _ = OleSetContainedObject(&rdp_unk, true);
        let _ = ole_obj.SetHostNames(w!("OrbitalTerm"), w!(""));

        // Set NegotiateSecurityLayer and dialog-suppression properties before
        // DoVerb via the NS3 vtable. IMsRdpExtendedSettings is NOT called here
        // because it requires the control to be fully activated (after DoVerb);
        // calling it before activation returns an uninitialised pointer that
        // crashes on Release. It is called in suppress_rdp_dialogs instead.
        {
            const IID_NS3: GUID = GUID::from_values(0xB3378D90, 0x0728, 0x45C7, [0x8E, 0xD7, 0xB6, 0x15, 0x9F, 0xB9, 0x22, 0x19]);
            type QIFn    = unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> i32;
            type PutBool = unsafe extern "system" fn(*mut core::ffi::c_void, i16) -> i32;
            type RelFn   = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;
            let raw = rdp_unk.as_raw() as *mut core::ffi::c_void;
            let qi: QIFn = core::mem::transmute(*(*(raw as *const *const usize)).add(0));
            let mut ns3: *mut core::ffi::c_void = core::ptr::null_mut();
            if qi(raw, &IID_NS3, &mut ns3) >= 0 && !ns3.is_null() {
                let v: *const usize = *(ns3 as *const *const usize);
                let put_show_redir:   PutBool = core::mem::transmute(*v.add(8));
                let put_prompt_creds: PutBool = core::mem::transmute(*v.add(10));
                let put_neg_sec:      PutBool = core::mem::transmute(*v.add(12));
                let put_warn_creds:   PutBool = core::mem::transmute(*v.add(18));
                let put_warn_clip:    PutBool = core::mem::transmute(*v.add(20));
                let release: RelFn            = core::mem::transmute(*v.add(2));
                let h1 = put_show_redir(ns3, 0i16);
                let h2 = put_prompt_creds(ns3, 0i16);
                let h3 = put_neg_sec(ns3, -1i16);
                let h4 = put_warn_creds(ns3, 0i16);
                let h5 = put_warn_clip(ns3, 0i16);
                eprintln!("[rdp] pre-DoVerb ShowRedirectionWarningDialog=0  hr=0x{:08X}", h1 as u32);
                eprintln!("[rdp] pre-DoVerb PromptForCredentials=0          hr=0x{:08X}", h2 as u32);
                eprintln!("[rdp] pre-DoVerb NegotiateSecurityLayer=1         hr=0x{:08X}", h3 as u32);
                eprintln!("[rdp] pre-DoVerb WarnAboutSendingCredentials=0   hr=0x{:08X}", h4 as u32);
                eprintln!("[rdp] pre-DoVerb WarnAboutClipboardRedirection=0  hr=0x{:08X}", h5 as u32);
                release(ns3);
            }
        }

        let mut rc = RECT { left: 0, top: 0, right: w, bottom: h };

        let dv_result = ole_obj.DoVerb(-5i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        if dv_result.is_err() {
            let _ = ole_obj.DoVerb(-1i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        }

        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
            let _ = ipo.SetObjectRects(&rc, &rc);
        }

        let disp: IDispatch = match rdp_unk.cast() {
            Ok(d) => d,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IDispatch QI: {e}")));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        // ── Store credentials in Windows Credential Manager ───────────────────
        // NLA/CredSSP reads from Credential Manager to authenticate silently.
        // We use CredWriteW directly (no subprocess) for reliability.
        if let Some(ref pw) = params.password {
            store_rdp_credential(&params.host, params.port, &params.username, &params.domain, pw);
        }

        // ── RDP properties ────────────────────────────────────────────────────
        let _ = put_bstr(&disp, "Server", &params.host);
        let _ = put_i4(&disp, "RDPPort", params.port as i32);
        let _ = put_bstr(&disp, "UserName", &params.username);
        if !params.domain.is_empty() {
            let _ = put_bstr(&disp, "Domain", &params.domain);
        }
        let _ = put_i4(&disp, "DesktopWidth", w);
        let _ = put_i4(&disp, "DesktopHeight", h);
        let _ = put_bool_prop(&disp, "FullScreen", false);
        // IMsRdpClient5::AuthenticationLevel = 0 → connect without certificate warning.
        // Setting it here on the main client AND on AdvancedSettings ensures both
        // interfaces suppress the "Precaución: conexión remota desconocida" dialog.
        let _ = put_i4(&disp, "AuthenticationLevel", 0);

        // AdvancedSettings: password, security layer, and AuthenticationLevel.
        // AuthenticationLevel MUST be set on AdvancedSettings (not the main
        // client object) to actually suppress the "unknown certificate" warning.
        let adv = get_dispatch_sub(&disp, "AdvancedSettings9")
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings7"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings5"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings2"));
        if let Ok(ref adv) = adv {
            if let Some(ref pw) = params.password {
                let _ = put_bstr(adv, "ClearTextPassword", pw);
            }
            let _ = put_i4(adv, "RDPPort", params.port as i32);
            let _ = put_bool_prop(adv, "EnableCredSspSupport", true);
            let _ = put_bool_prop(adv, "SmartSizing", true);
            // 0 = always connect even if cert doesn't match → suppresses warning dialog
            let _ = put_i4(adv, "AuthenticationLevel", 0);
            // Enable clipboard redirect explicitly so WarnAboutClipboardRedirection
            // can be set to FALSE below without returning E_INVALIDARG.
            let _ = put_bool_prop(adv, "RedirectClipboard", true);
            if params.admin_mode {
                let _ = put_i4(adv, "ConnectToAdministerServer", 1);
            }
        }

        // WarnAbout* suppression must happen AFTER clipboard redirect is enabled
        // (AdvancedSettings above). Calling before DoVerb or before
        // RedirectClipboard=TRUE causes E_INVALIDARG on these properties.
        suppress_rdp_dialogs(&rdp_unk);

        if let Err(e) = call_no_args(&disp, "Connect") {
            let _ = result_tx.send(Err(format!("RDP Connect(): {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let (tx, rx) = mpsc::sync_channel::<ComCmd>(16);
        let _ = result_tx.send(Ok(tx));

        // Track canvas-relative position so we can re-apply ClientToScreen
        // when the parent moves (e.g. window drag).
        let mut rel_x = params.x;
        let mut rel_y = params.y;
        let mut last_parent_rect = RECT::default();
        GetWindowRect(parent, &mut last_parent_rect).ok();
        // Gate visibility on ConnectionState==2 so the blank host window never
        // appears during authentication dialogs (NLA credential prompt, cert
        // warning, etc.).  The frontend may call Show before mstscax has
        // finished authenticating; we hold it here and flush once connected.
        let mut rdp_connected = false; // true once ConnectionState reaches 2
        let mut was_connected  = false; // latches true, used for disconnect detect
        let mut show_pending   = false; // Show arrived before rdp_connected

        // ── Message / command loop ─────────────────────────────────────────────
        let mut msg = MSG::default();
        let mut tick = 0u32;
        'outer: loop {
            // Drain the command channel
            loop {
                match rx.try_recv() {
                    Ok(ComCmd::Reposition { x, y, width, height }) => {
                        rel_x = x;
                        rel_y = y;
                        let (sx, sy) = canvas_to_screen(parent, x, y);
                        // No SWP_SHOWWINDOW: never reveal during auth dialogs.
                        // Visibility is controlled exclusively by Show/Hide and tick.
                        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, width, height,
                            SWP_NOACTIVATE).ok();
                        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
                            let r = RECT { left: 0, top: 0, right: width, bottom: height };
                            let _ = ipo.SetObjectRects(&r, &r);
                        }
                    }
                    Ok(ComCmd::Show) => {
                        if rdp_connected {
                            let _ = ShowWindow(host_hwnd, SW_SHOW);
                            SetWindowPos(host_hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();
                        } else {
                            show_pending = true;
                        }
                    }
                    Ok(ComCmd::Hide) => {
                        show_pending = false;
                        let _ = ShowWindow(host_hwnd, SW_HIDE);
                    }
                    Ok(ComCmd::Reparent { new_parent, rel_x: new_rel_x, rel_y: new_rel_y, width, height }) => {
                        let new_hwnd = HWND(new_parent as *mut _);
                        // Update the tracked parent for canvas_to_screen calculations.
                        // Do NOT call SetWindowLongPtrW(GWLP_HWNDPARENT) — it sends a
                        // synchronous cross-thread Win32 message that deadlocks this STA thread.
                        // HWND_TOP keeps the WS_POPUP above the new window's DComp layer.
                        parent = new_hwnd;
                        GetWindowRect(parent, &mut last_parent_rect).ok();
                        rel_x = new_rel_x;
                        rel_y = new_rel_y;
                        let (sx, sy) = canvas_to_screen(parent, rel_x, rel_y);
                        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, width, height,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW).ok();
                        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
                            let r = RECT { left: 0, top: 0, right: width, bottom: height };
                            let _ = ipo.SetObjectRects(&r, &r);
                        }
                    }
                    Ok(ComCmd::Disconnect) | Err(mpsc::TryRecvError::Disconnected) => {
                        let _ = call_no_args(&disp, "Disconnect");
                        PostQuitMessage(0);
                        break 'outer;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }

            // Pump the COM STA message queue
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break 'outer; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Every ~100ms: check parent liveness, reposition, and detect disconnect.
            tick += 1;
            if tick % 6 == 0 {
                // If the owner window (Tauri) was destroyed (e.g. detached window
                // closed without going through disconnect_rdp), clean up and exit
                // so the WS_POPUP doesn't orphan on the screen.
                if !IsWindow(Some(parent)).as_bool() {
                    let _ = call_no_args(&disp, "Disconnect");
                    PostQuitMessage(0);
                    break 'outer;
                }

                // Gate visibility on ConnectionState so the blank host window
                // never appears during NLA/cert auth dialogs, and hides
                // immediately when the remote session ends.
                if let Ok(state) = get_i4(&disp, "ConnectionState") {
                    match state {
                        2 if !rdp_connected => {
                            rdp_connected = true;
                            was_connected = true;
                            if show_pending {
                                show_pending = false;
                                let _ = ShowWindow(host_hwnd, SW_SHOW);
                                SetWindowPos(host_hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();
                            }
                        }
                        0 if was_connected => {
                            rdp_connected = false;
                            show_pending  = false;
                            let _ = ShowWindow(host_hwnd, SW_HIDE);
                        }
                        _ => {}
                    }
                }

                let mut cur = RECT::default();
                GetWindowRect(parent, &mut cur).ok();
                if cur.left != last_parent_rect.left || cur.top != last_parent_rect.top {
                    let (sx, sy) = canvas_to_screen(parent, rel_x, rel_y);
                    SetWindowPos(host_hwnd, None, sx, sy, 0, 0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE).ok();
                    last_parent_rect = cur;
                }
            }

            std::thread::sleep(Duration::from_millis(16));
        }

        let _ = ole_obj.SetClientSite(None);
        DestroyWindow(host_hwnd).ok();
        drop(disp);
        drop(ole_obj);
        drop(site);
        drop(frame);
        CoUninitialize();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn launch(
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
) -> Result<WindowsRdpSession, String> {
    let params = LaunchParams {
        parent_hwnd: parent_hwnd.0 as isize,
        host: host.to_string(),
        port,
        username: username.to_string(),
        domain: domain.to_string(),
        password: password.map(str::to_string),
        x, y, width, height,
        admin_mode,
    };
    let (result_tx, result_rx) = mpsc::sync_channel::<Result<mpsc::SyncSender<ComCmd>, String>>(1);
    std::thread::spawn(move || sta_thread(params, result_tx));
    let tx = result_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "El hilo COM-RDP no respondió a tiempo".to_string())??;
    Ok(WindowsRdpSession { tx })
}

pub fn reposition(session: &WindowsRdpSession, x: i32, y: i32, width: i32, height: i32) {
    let _ = session.tx.try_send(ComCmd::Reposition { x, y, width, height });
}

pub fn show(session: &WindowsRdpSession) {
    let _ = session.tx.try_send(ComCmd::Show);
}

pub fn hide(session: &WindowsRdpSession) {
    let _ = session.tx.try_send(ComCmd::Hide);
}

pub fn reparent(session: &WindowsRdpSession, new_parent: HWND, rel_x: i32, rel_y: i32, width: i32, height: i32) {
    let _ = session.tx.try_send(ComCmd::Reparent {
        new_parent: new_parent.0 as isize,
        rel_x, rel_y, width, height,
    });
}
