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

// Suppress two persistent dialogs that appear on every RDP connection:
//   1. "Precaución: conexión remota desconocida" (clipboard/redirect warning)
//   2. "Seguridad de Windows - Escribir credenciales" (credential re-prompt)
//
// Both are controlled by IMsRdpClientNonScriptable2 which is not exposed via
// IDispatch. We QueryInterface for it and poke the vtable directly.
//
// Vtable layout (flat, including IUnknown + NS1 inheritance):
//   [0-2]  IUnknown (QI, AddRef, Release)
//   [3]    NotifyRedirectDeviceChange  (NS1)
//   [4]    SendKeys                    (NS1)
//   [5]    get_UIParentWindowHandle    (NS2)
//   [6]    put_UIParentWindowHandle    (NS2)
//   [7]    get_ShowRedirectionWarningDialog  (NS2)
//   [8]    put_ShowRedirectionWarningDialog  (NS2) ← clipboard warning
//   [9]    get_PromptForCredentials    (NS2)
//   [10]   put_PromptForCredentials    (NS2) ← credential re-prompt
unsafe fn suppress_rdp_dialogs(rdp_unk: &IUnknown) {
    // Try NS2 first (has the properties we need), fall back through NS3.
    // IIDs for IMsRdpClientNonScriptable2 and IMsRdpClientNonScriptable3.
    const IID_NS2: GUID = GUID::from_values(
        0x17A5E535, 0x4072, 0x4FA4,
        [0xAF, 0x11, 0x26, 0xBE, 0x74, 0xED, 0x31, 0x40],
    );
    const IID_NS3: GUID = GUID::from_values(
        0xB3378D90, 0x0728, 0x45C7,
        [0x8E, 0xD7, 0xB6, 0x15, 0x9F, 0xB9, 0x22, 0x19],
    );

    // windows-rs does not expose QueryInterface as a callable Rust method on
    // &IUnknown, so call it through vtable index 0 directly.
    type QIFn    = unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> i32;
    type PutBool = unsafe extern "system" fn(*mut core::ffi::c_void, i16) -> i32;
    type RelFn   = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;

    let raw = rdp_unk.as_raw() as *mut core::ffi::c_void;
    let unk_vtbl: *const usize = *(raw as *const *const usize);
    let qi: QIFn = core::mem::transmute(*unk_vtbl.add(0));

    // Try NS2 first, then NS3 (NS3 inherits NS2 so same offsets work)
    let mut obj: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut hr = qi(raw, &IID_NS2, &mut obj);
    eprintln!("[rdp] QI NS2 hr=0x{:08X} obj={obj:?}", hr as u32);
    if hr < 0 || obj.is_null() {
        hr = qi(raw, &IID_NS3, &mut obj);
        eprintln!("[rdp] QI NS3 hr=0x{:08X} obj={obj:?}", hr as u32);
    }
    if hr < 0 || obj.is_null() {
        eprintln!("[rdp] IMsRdpClientNonScriptable2/3 QI failed — dialogs may still appear");
        return;
    }

    // Vtable layout (flat, IUnknown[0-2] + NS1[3-4] + NS2[5-16]):
    //   [7]  get_ShowRedirectionWarningDialog  ← clipboard/redirection warning
    //   [8]  put_ShowRedirectionWarningDialog
    //   [9]  get_PromptForCredentials          ← Windows Security credential dialog
    //   [10] put_PromptForCredentials
    //   [11] get_NegotiateSecurityLayer
    //   [12] put_NegotiateSecurityLayer
    let vtbl: *const usize = *(obj as *const *const usize);
    let put_show_warn:     PutBool = core::mem::transmute(*vtbl.add(8));
    let put_prompt_creds:  PutBool = core::mem::transmute(*vtbl.add(10));
    let put_neg_sec_layer: PutBool = core::mem::transmute(*vtbl.add(12));
    let release:           RelFn   = core::mem::transmute(*vtbl.add(2));

    // VARIANT_BOOL: FALSE = 0, TRUE = -1 (0xFFFF as i16)
    let hr1 = put_show_warn(obj, 0i16);     // ShowRedirectionWarningDialog = FALSE
    let hr2 = put_prompt_creds(obj, 0i16);  // PromptForCredentials = FALSE
    let hr3 = put_neg_sec_layer(obj, -1i16); // NegotiateSecurityLayer = TRUE
    eprintln!("[rdp] put_ShowRedirectionWarningDialog hr=0x{:08X}", hr1 as u32);
    eprintln!("[rdp] put_PromptForCredentials         hr=0x{:08X}", hr2 as u32);
    eprintln!("[rdp] put_NegotiateSecurityLayer       hr=0x{:08X}", hr3 as u32);
    release(obj);
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
        // NLA/CredSSP reads from Credential Manager to suppress the credential
        // prompt even when ClearTextPassword is also set.
        if let Some(ref pw) = params.password {
            let target = format!("TERMSRV/{}", params.host);
            let user = if params.domain.is_empty() {
                params.username.clone()
            } else {
                format!("{}\\{}", params.domain, params.username)
            };
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("cmdkey")
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .args([
                        &format!("/add:{}", target),
                        &format!("/user:{}", user),
                        &format!("/pass:{}", pw),
                    ])
                    .status();
            }
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
            if params.admin_mode {
                let _ = put_i4(adv, "ConnectToAdministerServer", 1);
            }
        }

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
