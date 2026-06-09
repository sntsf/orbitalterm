// OrbitalRdpHost — standalone RDP ActiveX host for silent NLA login.
//
// Why this exists: hosting the MsRdpClient ActiveX control in-process from Rust
// required hand-rolling the entire OLE site (IOleClientSite/IOleInPlaceSite),
// and even then the credential dialog could not be suppressed under NLA
// (ClearTextPassword ignored, IMsTscNonScriptable QI failed, PromptForCredentials
// returned E_NOTIMPL). WinForms' AxHost gives the control a *correct* OLE site
// and message pump, which is what production C# RDP apps use — and it lets
// ClearTextPassword feed CredSSP/NLA silently.
//
// Usage (standalone test — opens its own window):
//   OrbitalRdpHost.exe --server 10.240.0.10 --user "DOMAIN\user" --password "pass"
//
// Usage (embedded — reparented into an existing host window):
//   OrbitalRdpHost.exe --parent <HWND-decimal> --server H --user "DOMAIN\u" --port 3389
//   (password is then read as the first line of stdin, so it never appears on
//    the command line)
//
// Status is reported on stdout, one event per line, flushed immediately:
//   STATE:connecting
//   STATE:connected
//   STATE:disconnected reason=<n>
//   ERROR:<message>
//   WARN:<message>

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OrbitalRdpHost
{
    // Hosts an ActiveX control by CLSID with a full WinForms OLE site.
    internal sealed class RdpAxControl : AxHost
    {
        public RdpAxControl(string clsidNoBraces) : base(clsidNoBraces) { }
        public object Ocx { get { return GetOcx(); } }
    }

    // IMsTscNonScriptable::put_ClearTextPassword is the first method after
    // IUnknown (vtable[3]); declaring only it is enough to call it. This is the
    // non-scriptable password path used for silent NLA login.
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

    // Windows Credential Manager interop. We write the password as a GENERIC
    // credential with the plaintext UTF-16LE blob (exactly what `cmdkey /generic`
    // produces). NLA/CredSSP reads TERMSRV/<host> from here during Connect(), so
    // login is silent and deterministic — it never depends on whatever stale
    // credential might be left in the store from earlier experiments.
    internal static class Cred
    {
        const uint CRED_TYPE_GENERIC = 1;
        const uint CRED_TYPE_DOMAIN_PASSWORD = 2;
        const uint CRED_PERSIST_LOCAL_MACHINE = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
            public long LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDeleteW(string target, uint type, uint flags);

        public static bool Write(string target, string user, string password)
        {
            // Clear any stale entries (e.g. a bad DPAPI blob from earlier tests)
            // so the GENERIC plaintext credential below is the only one CredSSP sees.
            CredDeleteW(target, CRED_TYPE_GENERIC, 0);
            CredDeleteW(target, CRED_TYPE_DOMAIN_PASSWORD, 0);

            byte[] blob = System.Text.Encoding.Unicode.GetBytes(password);
            IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length == 0 ? 1 : blob.Length);
            try
            {
                if (blob.Length > 0) Marshal.Copy(blob, 0, blobPtr, blob.Length);
                var cred = new CREDENTIAL
                {
                    Type = CRED_TYPE_GENERIC,
                    TargetName = target,
                    CredentialBlobSize = (uint)blob.Length,
                    CredentialBlob = blobPtr,
                    Persist = CRED_PERSIST_LOCAL_MACHINE,
                    UserName = user,
                };
                return CredWriteW(ref cred, 0);
            }
            finally { Marshal.FreeHGlobal(blobPtr); }
        }
    }

    internal static class Program
    {
        // Coclass CLSIDs (the same ones OrbitalTerm's Rust path uses).
        const string CLSID_CLIENT10 = "C0EFA91A-EEB7-41C7-97FA-F0ED645EFB24";
        const string CLSID_CLIENT9  = "8B918B82-7985-4C24-89DF-C33AD2BBFBCD";

        static RdpAxControl _rdpAx;
        static dynamic _rdp;
        static Form _form;
        static IntPtr _parent = IntPtr.Zero;
        static int _lastState = -999;

        static void Emit(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

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

            // Prefer the password from stdin so it never appears on the command
            // line. Standalone testers can pass --password instead.
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

            string combinedUser =
                (string.IsNullOrEmpty(domain) || user.Contains("\\")) ? user : domain + "\\" + user;

            // Suppress the local-resource / clipboard redirection warning dialog
            // (the one introduced by KB5057577). Must be set before the control
            // activates and connects. HKCU — no elevation required.
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
            Emit("INFO:clsid=" + clsid);
            _rdpAx = new RdpAxControl(clsid) { Dock = DockStyle.Fill };
            _form.Controls.Add(_rdpAx);

            _form.Shown += (s, e) =>
            {
                try
                {
                    if (embedded && Native.IsWindow(_parent)) EmbedInParent();
                    Configure(server, port, combinedUser, password);
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

        // Probe which RDP coclass is actually registered/creatable on this box.
        static string PickClsid()
        {
            foreach (var c in new[] { CLSID_CLIENT10, CLSID_CLIENT9 })
            {
                var t = Type.GetTypeFromCLSID(new Guid(c), false);
                if (t == null) continue;
                try
                {
                    var o = Activator.CreateInstance(t);
                    if (o != null) Marshal.ReleaseComObject(o);
                    return c;
                }
                catch { /* try next */ }
            }
            return CLSID_CLIENT10;
        }

        // Reverts the post-KB5057577 redirection warning to the version that
        // honors the WarnAbout* control settings, so the "local resources /
        // clipboard" trust dialog no longer appears. HKCU = no elevation.
        // The Policies\... path is GPO-locked on domain machines (access denied),
        // so we pre-consent per server in the user's non-policy LocalDevices key,
        // which is the same place the "Don't ask me again" checkbox writes to.
        static void SuppressRedirectionWarning(string server)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Terminal Server Client\LocalDevices"))
                {
                    // Bitmask of consented redirected resources for this server.
                    // 0x4D covers clipboard + the usual local resources.
                    if (k != null) k.SetValue(server, unchecked((int)0x4D), RegistryValueKind.DWord);
                }
            }
            catch (Exception ex) { Emit("WARN:registry " + ex.Message); }
        }

        static void Configure(string server, int port, string user, string password)
        {
            // Deterministic credential: write our own GENERIC plaintext entry to
            // the Credential Manager so NLA reads the correct password during
            // Connect(), regardless of any stale credential left in the store.
            bool c1 = Cred.Write("TERMSRV/" + server, user, password);
            Emit("INFO:CredWrite TERMSRV/" + server + " user=" + user + " ok=" + c1);
            if (port != 3389)
            {
                bool c2 = Cred.Write("TERMSRV/" + server + ":" + port, user, password);
                Emit("INFO:CredWrite TERMSRV/" + server + ":" + port + " ok=" + c2);
            }

            _rdp = _rdpAx.Ocx; // live OCX, accessed via IDispatch through `dynamic`
            _rdp.Server = server;
            _rdp.UserName = user;

            dynamic adv = _rdp.AdvancedSettings9;
            adv.RDPPort = port;
            adv.AuthenticationLevel = 0;     // connect even if the cert can't be verified
            adv.EnableCredSspSupport = true; // NLA
            try { adv.SmartSizing = true; } catch { }
            try { adv.RedirectClipboard = true; } catch { }
            // Suppress the local-resource / clipboard redirection warning dialogs.
            try { adv.WarnAboutClipboardRedirection = false; } catch { }
            // Scriptable password path (works under a proper OLE site like AxHost's).
            try { adv.ClearTextPassword = password; } catch (Exception ex) { Emit("WARN:adv.ClearTextPassword " + ex.Message); }

            // Non-scriptable password path — the canonical way to drive silent NLA.
            try
            {
                var ns = _rdpAx.Ocx as IMsTscNonScriptable;
                if (ns != null) ns.put_ClearTextPassword(password);
                else Emit("WARN:IMsTscNonScriptable cast returned null");
            }
            catch (Exception ex) { Emit("WARN:nonscriptable " + ex.Message); }

            try
            {
                _rdp.DesktopWidth = Math.Max(800, _form.ClientSize.Width);
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

            // The Rust host window is moved/resized by OrbitalTerm's existing
            // reposition machinery; we just keep filling its client area.
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
                else if (state == 0)
                {
                    int reason = -1;
                    try { reason = (int)_rdp.ExtendedDisconnectReason; } catch { }
                    Emit("STATE:disconnected reason=" + reason);
                    t.Stop();
                    Application.Exit();
                }
            };
            t.Start();
        }
    }
}
