#pragma once
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque session handle returned to Rust */
typedef struct OrbRdpSession OrbRdpSession;

/*
 * on_frame   – called on the RDP event-loop thread each time FreeRDP paints.
 *              data   : raw pixels in BGRX32 format (4 bytes per pixel)
 *              w,h    : dimensions in pixels
 *              stride : bytes per row (may be > w*4)
 *
 * on_error   – called when the session terminates unexpectedly.
 *              msg    : UTF-8 error string (valid only for the call duration)
 *
 * user_ctx   : opaque pointer passed back verbatim to every callback.
 */
typedef void (*orb_frame_fn )(void *user_ctx,
                               const uint8_t *data,
                               uint32_t x,      /* dirty rect left */
                               uint32_t y,      /* dirty rect top */
                               uint32_t w,      /* dirty rect width */
                               uint32_t h,      /* dirty rect height */
                               uint32_t stride  /* full framebuffer stride */
                               );
typedef void (*orb_error_fn )(void *user_ctx, const char *msg);

/*
 * on_clipboard – called when the REMOTE clipboard changes and we have fetched
 *                its text.  text is a UTF-8 string valid only for the call
 *                duration; copy it if you need to keep it.  Enables the
 *                remote → local direction of clipboard sync.
 */
typedef void (*orb_clipboard_fn)(void *user_ctx, const char *text);

/*
 * Security mode values for orb_session_new security_mode parameter:
 *   0 = negotiate  (FreeRDP default: NLA preferred, falls back to TLS/RDP)
 *   1 = nla        (NLA only)
 *   2 = tls        (TLS only, no NLA)
 *   3 = rdp        (Classic RDP security, no NLA/TLS)
 */
#define ORB_SEC_NEGOTIATE 0
#define ORB_SEC_NLA       1
#define ORB_SEC_TLS       2
#define ORB_SEC_RDP       3

/*
 * orb_session_new – allocate and connect an RDP session.
 *
 * Returns NULL on allocation failure; connection errors are reported
 * asynchronously via on_error.
 */
OrbRdpSession *orb_session_new(const char   *host,
                                uint16_t      port,
                                const char   *username,
                                const char   *password,
                                const char   *domain,      /* may be "" */
                                uint16_t      width,
                                uint16_t      height,
                                bool          console_mode,
                                int           security_mode, /* ORB_SEC_* */
                                uint16_t      color_depth,   /* 8/15/16/24/32 */
                                orb_frame_fn  on_frame,
                                orb_error_fn  on_error,
                                orb_clipboard_fn on_clipboard,
                                void         *user_ctx);

/*
 * orb_session_free – disconnect and release all resources.
 * Safe to call from any thread.
 */
void orb_session_free(OrbRdpSession *session);

/*
 * Mouse input.
 *
 * flags combines PTR_FLAGS_* constants:
 *   0x0800  PTR_FLAGS_MOVE
 *   0x1000  PTR_FLAGS_BUTTON1  (left)
 *   0x2000  PTR_FLAGS_BUTTON2  (right)
 *   0x4000  PTR_FLAGS_BUTTON3  (middle)
 *   0x8000  PTR_FLAGS_DOWN     (button press; absent = release)
 *   0x0200  PTR_FLAGS_WHEEL
 *   0x0100  PTR_FLAGS_WHEEL_NEGATIVE
 *
 * Wheel rotation magnitude is in the low byte of flags when PTR_FLAGS_WHEEL.
 */
void orb_send_mouse(OrbRdpSession *session, uint16_t flags,
                    uint16_t x, uint16_t y);

/*
 * Keyboard input.
 *
 * scancode : AT-set-1 scan code (e.g. 0x1E for 'A').
 * flags:
 *   0x4000  KBD_FLAGS_DOWN
 *   0x8000  KBD_FLAGS_RELEASE
 *   0x0100  KBD_FLAGS_EXTENDED  (right-side modifiers, numpad, etc.)
 */
void orb_send_key(OrbRdpSession *session, uint16_t flags, uint8_t scancode);

/*
 * Dynamic resize.  Requires DISP channel support on the server.
 * No-op if the channel isn't available.
 */
void orb_resize(OrbRdpSession *session, uint16_t width, uint16_t height);

/*
 * orb_set_clipboard: push text to the remote clipboard.
 */
void orb_set_clipboard(OrbRdpSession *session, const char *text);

/*
 * orb_refresh: ask the server to repaint the entire framebuffer.
 * Call this when the viewer canvas becomes visible after being hidden,
 * or after the initial connection to ensure the full desktop is rendered.
 */
void orb_refresh(OrbRdpSession *session);

#ifdef __cplusplus
}
#endif
