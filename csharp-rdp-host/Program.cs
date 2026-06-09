// OrbitalRdpHost — strongly-typed RDP ActiveX host (mRemoteNG approach).
//
// Hosts AxMsRdpClient9NotSafeForScripting via the typed Interop/AxInterop
// assemblies that build.cmd generates from mstscax.dll with aximp.exe — exactly
// how mRemoteNG hosts the control. No `dynamic`/IDispatch late binding: every
// property is an early-bound vtable call, and we get the real .NET events
// (OnLogonError, OnFatalError, OnAuthenticationWarningDisplayed) so we can see
// the actual cause of any failure instead of a bare disconnect code.
//
// Usage (standalone test — opens its own window):
//   OrbitalRdpHost.exe --server 10.240.0.10 --user "DOMAIN\user" --password "pass"
//
// Usage (embedded — reparented into an existing host window):
//   OrbitalRdpHost.exe --parent <HWND-decimal> --server H --user "DOMAIN\u" --port 3389
//
// Status is reported on stdout, one event per line, flushed immediately.

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using AxMSTSCLib;
using MSTSCLib;

namespace OrbitalRdpHost
{
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

    // Subclass so we can reach the underlying OCX (GetOcx is protected in AxHost)
    // for the non-scriptable password path, just like mRemoteNG does.
    internal sealed class RdpClient : AxMsRdpClient9NotSafeForScripting
    {
        public object Ocx { get { return GetOcx(); } }
    }

    internal static class Program
    {
        static RdpClient _rdp;
        static Form _form;
        static IntPtr _parent = IntPtr.Zero;

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

            // Split DOMAIN\user into separate parts (mRemoteNG sets Domain and
            // UserName as distinct properties).
            string userName = user, dom = domain;
            int bs = user.IndexOf('\\');
            if (bs >= 0) { dom = user.Substring(0, bs); userName = user.Substring(bs + 1); }

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

            _rdp = new RdpClient { Dock = DockStyle.Fill };
            ((System.ComponentModel.ISupportInitialize)_rdp).BeginInit();
            _form.Controls.Add(_rdp);
            ((System.ComponentModel.ISupportInitialize)_rdp).EndInit();

            WireEvents();

            string srv = server; int prt = port; string usr = userName; string dm = dom; string pwd = password;
            _form.Shown += (s, e) =>
            {
                try
                {
                    if (embedded && Native.IsWindow(_parent)) EmbedInParent();
                    Configure(srv, prt, usr, dm, pwd);
                    Emit("STATE:connecting");
                    _rdp.Connect();
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

        static void WireEvents()
        {
            _rdp.OnConnecting    += (s, e) => Emit("EVENT:OnConnecting");
            _rdp.OnConnected     += (s, e) => Emit("EVENT:OnConnected STATE:connected");
            _rdp.OnLoginComplete += (s, e) => Emit("EVENT:OnLoginComplete");
            _rdp.OnWarning       += (s, e) => Emit("EVENT:OnWarning code=" + e.warningCode);
            _rdp.OnFatalError    += (s, e) => Emit("EVENT:OnFatalError code=" + e.errorCode);
            _rdp.OnLogonError    += (s, e) => Emit("EVENT:OnLogonError lError=" + e.lError);
            _rdp.OnAuthenticationWarningDisplayed += (s, e) => Emit("EVENT:OnAuthenticationWarningDisplayed");
            _rdp.OnAuthenticationWarningDismissed += (s, e) => Emit("EVENT:OnAuthenticationWarningDismissed");

            _rdp.OnDisconnected += (s, e) =>
            {
                int reason = e.discReason;
                Emit("EVENT:OnDisconnected discReason=" + reason + " (0x" + reason.ToString("X") + ")");
                int ext = -1;
                try { ext = _rdp.GetOcx() != null ? 0 : -1; } catch { }
                try { ext = (int)((IMsRdpClient)_rdp.GetOcx()).ExtendedDisconnectReason; Emit("INFO:ExtendedDisconnectReason=" + ext); }
                catch (Exception ex) { Emit("WARN:ExtendedDisconnectReason " + ex.Message); }
                try
                {
                    string desc = _rdp.GetErrorDescription((uint)reason, (uint)(ext < 0 ? 0 : ext));
                    Emit("INFO:ErrorDescription=" + desc);
                }
                catch (Exception ex) { Emit("WARN:GetErrorDescription " + ex.Message); }

                Emit("STATE:disconnected reason=" + reason);
                try { _form.BeginInvoke((Action)(() => Application.Exit())); } catch { Application.Exit(); }
            };
        }

        static void Configure(string server, int port, string userName, string domain, string password)
        {
            // ── mRemoteNG-equivalent property sequence ────────────────────────────
            _rdp.Server   = server;
            _rdp.UserName = userName;
            _rdp.Domain   = domain;
            Emit("INFO:Server=" + server + " Domain=" + domain + " UserName=" + userName);

            IMsRdpClientAdvancedSettings8 adv = _rdp.AdvancedSettings9;
            adv.RDPPort = port;
            adv.EnableCredSspSupport = true;     // NLA / CredSSP
            adv.AuthenticationLevel  = 2;        // authenticate server (required by CredSSP)
            adv.EncryptionEnabled    = 1;        // mRemoteNG sets this
            try { adv.SmartSizing = true; } catch { }
            try { adv.RedirectClipboard = true; } catch { }

            // Password — scriptable path (typed, early-bound).
            try { adv.ClearTextPassword = password; Emit("INFO:ClearTextPassword set (adv)"); }
            catch (Exception ex) { Emit("WARN:adv.ClearTextPassword " + ex.Message); }

            // Password — non-scriptable path, the canonical NLA injection.
            try
            {
                var ns = _rdp.Ocx as IMsTscNonScriptable;
                if (ns != null) { ns.ClearTextPassword = password; Emit("INFO:ClearTextPassword set (nonscriptable)"); }
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
    }
}
