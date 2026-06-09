// OrbitalRdpHost — RDP ActiveX host (no SDK tools required).
//
// Hosts the MsRdpClient ActiveX control via WinForms AxHost. Builds with only
// csc.exe (ships with .NET Framework 4.x on Windows 11) — no aximp/tlbimp/SDK.
//
// mRemoteNG (which connects silently on this machine) hosts the *version 9*
// control; ours was defaulting to version 10 (CLSID C0EFA91A…), which appears to
// self-cancel (discReason 7943) on this Windows build. We therefore prefer v9 and
// expose ORB_VER=9|10|11 to test each.
//
// Usage:
//   OrbitalRdpHost.exe --server H --user "DOMAIN\user" --password "pass"
//                      [--port N] [--parent HWND]
//
// Status is printed to stdout, one event per line, flushed immediately.

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OrbitalRdpHost
{
    // IMsTscAxEvents — the control's outgoing event interface. Declared as an
    // IDispatch sink; the runtime routes each event to the method whose DispId
    // matches. We listen to the credential/auth-relevant ones so a failure is
    // explained (OnLogonError, OnFatalError) instead of a bare disconnect code.
    [ComVisible(true)]
    [Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    public interface IMsTscAxEvents
    {
        [DispId(1)]  void OnConnecting();
        [DispId(2)]  void OnConnected();
        [DispId(3)]  void OnLoginComplete();
        [DispId(4)]  void OnDisconnected(int discReason);
        [DispId(10)] void OnFatalError(int errorCode);
        [DispId(11)] void OnWarning(int warningCode);
        [DispId(18)] void OnAuthenticationWarningDisplayed();
        [DispId(23)] void OnLogonError(int lError);
    }

    internal sealed class RdpAxControl : AxHost
    {
        public RdpAxControl(string clsidNoBraces) : base(clsidNoBraces) { }
        public object Ocx { get { return GetOcx(); } }
    }

    [ComImport]
    [Guid("C1E6743A-41C1-4A74-832A-0DD06C1C7A0E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMsTscNonScriptable
    {
        void put_ClearTextPassword([MarshalAs(UnmanagedType.BStr)] string pass);
    }

    internal static class Native
    {
        public const int GWL_STYLE = -16;
        public const long WS_CHILD = 0x40000000L;
        public const long WS_POPUP = 0x80000000L;
        public const long WS_CAPTION = 0x00C00000L;
        public const long WS_THICKFRAME = 0x00040000L;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
    }

    internal static class Program
    {
        static RdpAxControl _rdpAx;
        static dynamic _rdp;
        static Form _form;
        static IntPtr _parent = IntPtr.Zero;
        static int _lastState = -999;
        static IConnectionPoint _cp;
        static int _cookie;

        static void Emit(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

        sealed class EventSink : IMsTscAxEvents
        {
            public void OnConnecting()    { Emit("EVENT:OnConnecting"); }
            public void OnConnected()     { Emit("EVENT:OnConnected"); }
            public void OnLoginComplete() { Emit("EVENT:OnLoginComplete"); }
            public void OnFatalError(int errorCode) { Emit("EVENT:OnFatalError code=" + errorCode); }
            public void OnWarning(int warningCode)  { Emit("EVENT:OnWarning code=" + warningCode); }
            public void OnAuthenticationWarningDisplayed() { Emit("EVENT:OnAuthenticationWarningDisplayed"); }
            public void OnLogonError(int lError)    { Emit("EVENT:OnLogonError lError=" + lError); }

            public void OnDisconnected(int discReason)
            {
                Emit("EVENT:OnDisconnected discReason=" + discReason +
                     " (0x" + discReason.ToString("X") + ")");
                int ext = -1;
                try { ext = (int)_rdp.ExtendedDisconnectReason; Emit("INFO:ExtendedDisconnectReason=" + ext); }
                catch (Exception e) { Emit("WARN:ExtendedDisconnectReason " + e.Message); }
                try
                {
                    string desc = (string)_rdp.GetErrorDescription((uint)discReason, (uint)(ext < 0 ? 0 : ext));
                    Emit("INFO:ErrorDescription=" + desc);
                }
                catch (Exception e) { Emit("WARN:GetErrorDescription " + e.Message); }
                try { _form.BeginInvoke((Action)(() => Application.Exit())); } catch { Application.Exit(); }
            }
        }

        [STAThread]
        static int Main(string[] args)
        {
            string server = null, user = null, domain = "", password = null;
            int port = 3389;

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--parent":   _parent = new IntPtr(long.Parse(args[++i])); break;
                    case "--server":   server = args[++i]; break;
                    case "--port":     port = int.Parse(args[++i]); break;
                    case "--user":     user = args[++i]; break;
                    case "--domain":   domain = args[++i]; break;
                    case "--password": password = args[++i]; break;
                }
            }

            if (password == null)
            {
                try { password = Console.In.ReadLine() ?? ""; } catch { password = ""; }
            }

            if (string.IsNullOrEmpty(server) || string.IsNullOrEmpty(user))
            {
                Console.Error.WriteLine(
                    "usage: OrbitalRdpHost --server <host> --user <DOMAIN\\\\user> " +
                    "[--port N] [--domain D] [--parent HWND] [--password P]");
                return 2;
            }

            // Split DOMAIN\user into separate parts (mRemoteNG style).
            string userName = user, dom = domain;
            int bs = user.IndexOf('\\');
            if (bs >= 0) { dom = user.Substring(0, bs); userName = user.Substring(bs + 1); }

            SuppressRedirectionWarning(server);
            Application.EnableVisualStyles();

            bool embedded = _parent != IntPtr.Zero;
            _form = new Form
            {
                Text = "OrbitalRdpHost",
                FormBorderStyle = embedded ? FormBorderStyle.None : FormBorderStyle.Sizable,
                ShowInTaskbar = !embedded,
                StartPosition = FormStartPosition.Manual,
                Width = 1280,
                Height = 800,
                BackColor = Color.Black,
            };

            string clsid = PickClsid();
            if (clsid == null) { Emit("ERROR:no MsRdpClient control could be created"); return 3; }
            Emit("INFO:using clsid=" + clsid);
            _rdpAx = new RdpAxControl(clsid) { Dock = DockStyle.Fill };
            _form.Controls.Add(_rdpAx);

            string srv = server; int prt = port; string usr = userName; string dm = dom; string pwd = password;
            _form.Shown += (s, e) =>
            {
                try
                {
                    if (embedded && Native.IsWindow(_parent)) EmbedInParent();
                    Configure(srv, prt, usr, dm, pwd);
                    Emit("STATE:connecting");
                    _rdp.Connect();
                    StartPolling();
                }
                catch (Exception ex)
                {
                    Emit("ERROR:" + ex.Message);
                    Application.Exit();
                }
            };

            Application.Run(_form);
            return 0;
        }

        // The NotSafeForScripting coclasses have NO ProgIDs — only CLSIDs. So we
        // enumerate the registry for every COM class backed by mstscax.dll, print
        // them (CLSID + friendly name), and pick one. ORB_CLSID forces a specific
        // CLSID so we can test each control version (mRemoteNG hosts v9).
        static string PickClsid()
        {
            string forced = Environment.GetEnvironmentVariable("ORB_CLSID");
            if (!string.IsNullOrEmpty(forced))
            {
                forced = forced.Trim('{', '}');
                Emit("INFO:ORB_CLSID forced=" + forced);
            }

            var found = EnumerateMstscaxClasses();   // (clsid -> name)
            foreach (var kv in found)
                Emit("INFO:available clsid=" + kv.Key + " name=\"" + kv.Value + "\"");

            // Build the try-order: forced first, then any enumerated, then the
            // known-good v10 CLSID as a final fallback.
            var order = new System.Collections.Generic.List<string>();
            if (!string.IsNullOrEmpty(forced)) order.Add(forced);
            // Prefer the highest-named version that is NOT v10/v11 first? We don't
            // trust the name->version mapping, so just try all enumerated, then v10.
            foreach (var kv in found) if (!order.Contains(kv.Key)) order.Add(kv.Key);
            const string V10 = "c0efa91a-eeb7-41c7-97fa-f0ed645efb24";
            if (!order.Contains(V10)) order.Add(V10);

            foreach (var c in order)
            {
                try
                {
                    Type t = Type.GetTypeFromCLSID(new Guid(c), false);
                    if (t == null) continue;
                    object o = Activator.CreateInstance(t);
                    if (o != null) Marshal.ReleaseComObject(o);
                    return c;
                }
                catch (Exception ex) { Emit("WARN:create " + c + " failed: " + ex.Message); }
            }
            return null;
        }

        // Scan HKCR\CLSID for classes whose InprocServer32 is mstscax.dll.
        static System.Collections.Generic.Dictionary<string, string> EnumerateMstscaxClasses()
        {
            var result = new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using (var root = Registry.ClassesRoot.OpenSubKey("CLSID"))
                {
                    if (root == null) return result;
                    foreach (var sub in root.GetSubKeyNames())
                    {
                        if (sub.Length < 2 || sub[0] != '{') continue;
                        try
                        {
                            using (var k = root.OpenSubKey(sub))
                            {
                                if (k == null) continue;
                                using (var ip = k.OpenSubKey("InprocServer32"))
                                {
                                    if (ip == null) continue;
                                    string dll = ip.GetValue(null) as string;
                                    if (string.IsNullOrEmpty(dll)) continue;
                                    if (dll.IndexOf("mstscax.dll", StringComparison.OrdinalIgnoreCase) < 0) continue;
                                    string name = k.GetValue(null) as string ?? "";
                                    result[sub.Trim('{', '}')] = name;
                                }
                            }
                        }
                        catch { /* skip unreadable keys */ }
                    }
                }
            }
            catch (Exception ex) { Emit("WARN:enum " + ex.Message); }
            return result;
        }

        static void SuppressRedirectionWarning(string server)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Terminal Server Client\LocalDevices"))
                {
                    if (k != null) k.SetValue(server, unchecked((int)0x4D), RegistryValueKind.DWord);
                }
            }
            catch (Exception ex) { Emit("WARN:registry " + ex.Message); }
        }

        static void AdviseEvents(object ocx)
        {
            try
            {
                var cpc = ocx as IConnectionPointContainer;
                if (cpc == null) { Emit("WARN:no IConnectionPointContainer"); return; }
                Guid iid = typeof(IMsTscAxEvents).GUID;
                cpc.FindConnectionPoint(ref iid, out _cp);
                _cp.Advise(new EventSink(), out _cookie);
                Emit("INFO:events advised cookie=" + _cookie);
            }
            catch (Exception ex) { Emit("WARN:advise " + ex.Message); }
        }

        static void Configure(string server, int port, string userName, string domain, string password)
        {
            _rdp = _rdpAx.Ocx;
            AdviseEvents(_rdpAx.Ocx);
            _rdp.Server   = server;
            _rdp.UserName = userName;
            _rdp.Domain   = domain;
            Emit("INFO:Server=" + server + " Domain=" + domain + " UserName=" + userName);

            dynamic adv = _rdp.AdvancedSettings9;
            adv.RDPPort = port;
            adv.EnableCredSspSupport = true;
            adv.AuthenticationLevel  = 2;
            try { adv.EncryptionEnabled = 1; } catch { }
            try { adv.SmartSizing = true; } catch { }
            try { adv.RedirectClipboard = true; } catch { }
            try { adv.WarnAboutClipboardRedirection = false; } catch { }

            try { adv.ClearTextPassword = password; Emit("INFO:ClearTextPassword set (adv)"); }
            catch (Exception ex) { Emit("WARN:adv.ClearTextPassword " + ex.Message); }

            try
            {
                var ns = _rdpAx.Ocx as IMsTscNonScriptable;
                if (ns != null) { ns.put_ClearTextPassword(password); Emit("INFO:ClearTextPassword set (nonscriptable)"); }
                else Emit("WARN:IMsTscNonScriptable cast returned null");
            }
            catch (Exception ex) { Emit("WARN:nonscriptable " + ex.Message); }

            try
            {
                _rdp.DesktopWidth  = Math.Max(800, _form.ClientSize.Width);
                _rdp.DesktopHeight = Math.Max(600, _form.ClientSize.Height);
            }
            catch { }
        }

        static void EmbedInParent()
        {
            int style = Native.GetWindowLong(_form.Handle, Native.GWL_STYLE);
            long s = ((long)(uint)style | Native.WS_CHILD)
                     & ~Native.WS_POPUP & ~Native.WS_CAPTION & ~Native.WS_THICKFRAME;
            Native.SetWindowLong(_form.Handle, Native.GWL_STYLE, unchecked((int)s));
            Native.SetParent(_form.Handle, _parent);
            FitToParent();

            var t = new Timer { Interval = 150 };
            t.Tick += (s2, e2) =>
            {
                if (!Native.IsWindow(_parent)) { Application.Exit(); return; }
                FitToParent();
            };
            t.Start();
        }

        static void FitToParent()
        {
            Native.RECT rc;
            if (Native.GetClientRect(_parent, out rc))
            {
                int w = rc.Right - rc.Left, h = rc.Bottom - rc.Top;
                if (w > 0 && h > 0) _form.SetBounds(0, 0, w, h);
            }
        }

        static void StartPolling()
        {
            var t = new Timer { Interval = 250 };
            t.Tick += (s, e) =>
            {
                int state;
                try { state = (int)_rdp.Connected; } catch { state = -1; }
                if (state == _lastState) return;
                _lastState = state;
                if (state == 2) Emit("STATE:connecting");
                else if (state == 1) Emit("STATE:connected");
                else if (state == 0) { Emit("STATE:disconnected"); t.Stop(); Application.Exit(); }
            };
            t.Start();
        }
    }
}
