export function friendlyConnError(raw: string, lang: "es" | "en", connType?: string): string {
  const r = raw.toLowerCase();

  // ── Special markers ──────────────────────────────────────────────────────────
  if (r === "session_ended" || r.startsWith("session_ended")) {
    return lang === "es"
      ? "La sesión se desconectó. El servidor puede haberse reiniciado o la red fue interrumpida."
      : "The session disconnected. The server may have restarted or the network was lost.";
  }

  if (lang === "es") {
    // ── Host apagado / sin red / timeout ─────────────────────────────────────
    if (
      r.includes("timed out") || r.includes("timeout") || r.includes("connection timed") ||
      r.includes("no route to host") || r.includes("network is unreachable") || r.includes("host unreachable") ||
      r.includes("connect_transport_failed") || r.includes("transport failed")
    ) {
      if (connType === "rdp") {
        return (
          "No se puede conectar al equipo remoto.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o no disponible en la red\n" +
          "  2) El acceso remoto (RDP) no está habilitado en el servidor\n" +
          "  3) El puerto 3389 está bloqueado por un firewall\n\n" +
          "Asegúrate de que el equipo esté encendido, conectado a la red\n" +
          "y con el acceso remoto habilitado."
        );
      }
      if (connType === "vnc") {
        return (
          "No se puede conectar al servidor VNC.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o no disponible en la red\n" +
          "  2) El servidor VNC no está en ejecución\n" +
          "  3) El puerto VNC está bloqueado por un firewall"
        );
      }
      if (connType === "ssh" || connType === "sftp") {
        return (
          "No se puede conectar al servidor SSH.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o no disponible en la red\n" +
          "  2) El puerto SSH está bloqueado por un firewall\n" +
          "  3) El servicio SSH no está en ejecución (sshd detenido)"
        );
      }
      if (connType === "ftp") {
        return (
          "No se puede conectar al servidor FTP.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o no disponible en la red\n" +
          "  2) El servicio FTP no está en ejecución\n" +
          "  3) El puerto FTP está bloqueado por un firewall"
        );
      }
      return "Tiempo de espera agotado — el host no respondió. Puede estar apagado o bloqueado por un firewall.";
    }

    // ── Conexión rechazada ───────────────────────────────────────────────────
    if (r.includes("connection refused")) {
      if (connType === "rdp") {
        return (
          "Conexión rechazada en el puerto RDP.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o sin red\n" +
          "  2) El Escritorio Remoto no está habilitado en el servidor\n" +
          "  3) El puerto 3389 está bloqueado por un firewall"
        );
      }
      if (connType === "ssh" || connType === "sftp") {
        return (
          "Conexión rechazada en el puerto SSH.\n\n" +
          "Posibles causas:\n" +
          "  1) El equipo remoto está apagado o sin red\n" +
          "  2) El servicio SSH no está en ejecución (sshd detenido)\n" +
          "  3) El puerto SSH está bloqueado por un firewall"
        );
      }
      return "Conexión rechazada — el puerto está cerrado o el servicio no está activo en el servidor.";
    }

    // ── Autenticación ────────────────────────────────────────────────────────
    if (
      r.includes("authentication failed") || r.includes("permission denied") ||
      r.includes("login failed") || r.includes("invalid credentials") ||
      r.includes("logon_failure") || r.includes("logon failure") ||
      (r.includes("incorrect") && !r.includes("protocol"))
    ) {
      if (connType === "rdp") return "Autenticación RDP fallida — verifica el nombre de usuario, contraseña y dominio.";
      if (connType === "ftp") return "Login FTP fallido — verifica el usuario y la contraseña.";
      if (connType === "vnc") return "Autenticación VNC fallida — verifica la contraseña VNC del servidor.";
      return "Autenticación fallida — verifica el usuario y la contraseña o llave SSH.";
    }

    // ── Llave de host / certificado ──────────────────────────────────────────
    if (r.includes("host key verification") || r.includes("host key changed") || r.includes("host key mismatch"))
      return "La llave del host no coincide — el servidor puede haber cambiado o reinstalado. Revisa los hosts conocidos.";
    if (r.includes("certificate") || r.includes("nla") || r.includes("network level authentication"))
      return "Error de autenticación NLA/certificado. Verifica las credenciales o la configuración de seguridad del servidor.";

    // ── DNS ──────────────────────────────────────────────────────────────────
    if (
      r.includes("name or service not known") || r.includes("name resolution") ||
      r.includes("nodename nor servname") || r.includes("could not resolve") ||
      r.includes("dns_lookup_failed")
    )
      return "No se pudo resolver el nombre DNS — verifica el hostname o tu conexión a la red.";

    // ── VNC específico ───────────────────────────────────────────────────────
    if (r.includes("vnc authentication failed") || r.includes("vnc auth failed"))
      return "Autenticación VNC fallida — verifica la contraseña VNC del servidor.";
    if (r.includes("no supported vnc security"))
      return "El servidor VNC usa un tipo de seguridad no compatible.";
    if (r.includes("vnc server refused") || r.includes("vnc read error") || r.includes("vnc write error"))
      return "El servidor VNC rechazó o interrumpió la conexión.";

    // ── Marcadores especiales ────────────────────────────────────────────────
    if (r.includes("no_rdp_client"))
      return "No hay cliente RDP instalado. Instala freerdp o remmina.";
    if (r.includes("no_password"))
      return "No hay contraseña guardada. Agrégala en las propiedades de la conexión.";

    // ── Corte inesperado ─────────────────────────────────────────────────────
    if (r.includes("connection reset") || r.includes("broken pipe") || r.includes("connection aborted"))
      return "La conexión fue interrumpida inesperadamente.";
    if (r.includes("too many authentication"))
      return "Demasiados intentos de autenticación fallidos.";
    if (r.includes("banner") || r.includes("protocol error"))
      return "Error de protocolo — el servidor respondió con un mensaje inesperado.";
    if (r.includes("session not found") || r.includes("sftp session") || r.includes("ftp session"))
      return "La sesión expiró o fue cerrada. Reconecta para continuar.";

    return raw;
  }

  // ── English ─────────────────────────────────────────────────────────────────

  if (
    r.includes("timed out") || r.includes("timeout") || r.includes("connection timed") ||
    r.includes("no route to host") || r.includes("network is unreachable") || r.includes("host unreachable") ||
    r.includes("connect_transport_failed") || r.includes("transport failed")
  ) {
    if (connType === "rdp") {
      return (
        "Cannot connect to the remote computer.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or not available on the network\n" +
        "  2) Remote Desktop (RDP) is not enabled on the server\n" +
        "  3) Port 3389 is blocked by a firewall\n\n" +
        "Make sure the computer is on, connected to the network,\n" +
        "and that remote access is enabled."
      );
    }
    if (connType === "vnc") {
      return (
        "Cannot connect to the VNC server.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or not available on the network\n" +
        "  2) The VNC server is not running\n" +
        "  3) The VNC port is blocked by a firewall"
      );
    }
    if (connType === "ssh" || connType === "sftp") {
      return (
        "Cannot connect to the SSH server.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or not available on the network\n" +
        "  2) The SSH port is blocked by a firewall\n" +
        "  3) The SSH service is not running (sshd stopped)"
      );
    }
    if (connType === "ftp") {
      return (
        "Cannot connect to the FTP server.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or not available on the network\n" +
        "  2) The FTP server is not running\n" +
        "  3) The FTP port is blocked by a firewall"
      );
    }
    return "Connection timed out — the host did not respond. It may be offline or blocked by a firewall.";
  }

  if (r.includes("connection refused")) {
    if (connType === "rdp") {
      return (
        "Connection refused on the RDP port.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or unreachable on the network\n" +
        "  2) Remote Desktop is not enabled on the server\n" +
        "  3) Port 3389 is blocked by a firewall"
      );
    }
    if (connType === "ssh" || connType === "sftp") {
      return (
        "Connection refused on the SSH port.\n\n" +
        "Possible reasons:\n" +
        "  1) The remote computer is off or unreachable on the network\n" +
        "  2) The SSH service is not running (sshd stopped)\n" +
        "  3) The SSH port is blocked by a firewall"
      );
    }
    return "Connection refused — the port is closed or the service is not running on the server.";
  }

  if (
    r.includes("authentication failed") || r.includes("permission denied") ||
    r.includes("login failed") || r.includes("invalid credentials") ||
    r.includes("logon_failure") || r.includes("logon failure") ||
    (r.includes("incorrect") && !r.includes("protocol"))
  ) {
    if (connType === "rdp") return "RDP authentication failed — check the username, password, and domain.";
    if (connType === "ftp") return "FTP login failed — check the username and password.";
    if (connType === "vnc") return "VNC authentication failed — check the VNC password on the server.";
    return "Authentication failed — check the username and password or SSH key.";
  }

  if (r.includes("host key verification") || r.includes("host key changed") || r.includes("host key mismatch"))
    return "Host key mismatch — the server may have been reinstalled. Check your known hosts file.";
  if (r.includes("certificate") || r.includes("nla") || r.includes("network level authentication"))
    return "NLA/certificate authentication error. Check credentials or the server's security settings.";

  if (
    r.includes("name or service not known") || r.includes("name resolution") ||
    r.includes("nodename nor servname") || r.includes("could not resolve") ||
    r.includes("dns_lookup_failed")
  )
    return "DNS resolution failed — check the hostname and your network connection.";

  if (r.includes("vnc authentication failed") || r.includes("vnc auth failed"))
    return "VNC authentication failed — check the VNC password on the server.";
  if (r.includes("no supported vnc security"))
    return "The VNC server uses an unsupported security type.";
  if (r.includes("vnc server refused") || r.includes("vnc read error") || r.includes("vnc write error"))
    return "The VNC server refused or dropped the connection.";

  if (r.includes("no_rdp_client"))
    return "No RDP client installed. Install freerdp or remmina.";
  if (r.includes("no_password"))
    return "No password saved. Add a password in the connection properties.";

  if (r.includes("connection reset") || r.includes("broken pipe") || r.includes("connection aborted"))
    return "Connection was unexpectedly reset.";
  if (r.includes("too many authentication"))
    return "Too many failed authentication attempts.";
  if (r.includes("banner") || r.includes("protocol error"))
    return "Protocol error — the server responded with an unexpected message.";
  if (r.includes("session not found") || r.includes("sftp session") || r.includes("ftp session"))
    return "The session expired or was closed. Reconnect to continue.";

  return raw;
}

/** Returns just the first line — suitable for single-line notification toasts. */
export function friendlyConnErrorShort(raw: string, lang: "es" | "en", connType?: string): string {
  return friendlyConnError(raw, lang, connType).split("\n")[0];
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function isUnreachable(r: string) {
  return (
    r.includes("timed out") || r.includes("timeout") || r.includes("connection timed") ||
    r.includes("no route to host") || r.includes("network is unreachable") ||
    r.includes("host unreachable") || r.includes("connect_transport_failed") ||
    r.includes("transport failed")
  );
}
function isRefused(r: string) { return r.includes("connection refused"); }

/**
 * Compact two-line format for the notification toast:
 *   Line 1 — short title
 *   Line 2 — numbered causes joined with "  ·  "
 */
export function friendlyConnErrorNotif(raw: string, lang: "es" | "en", connType?: string): string {
  const r = raw.toLowerCase();

  if (r === "session_ended" || r.startsWith("session_ended")) {
    return lang === "es" ? "Sesión finalizada." : "Session ended.";
  }

  if (lang === "es") {
    if (isUnreachable(r)) {
      if (connType === "rdp")
        return "No se puede conectar al equipo remoto.\n1) Equipo apagado o sin red  ·  2) Puerto 3389 bloqueado o modificado  ·  3) Acceso remoto (RDP) no habilitado en el servidor";
      if (connType === "vnc")
        return "No se puede conectar al servidor VNC.\n1) Equipo apagado o sin red  ·  2) Puerto VNC bloqueado  ·  3) Servidor VNC no está en ejecución";
      if (connType === "ssh" || connType === "sftp")
        return "No se puede conectar al servidor SSH.\n1) Equipo apagado o sin red  ·  2) Puerto SSH bloqueado  ·  3) Servicio SSH (sshd) no está en ejecución";
      if (connType === "ftp")
        return "No se puede conectar al servidor FTP.\n1) Equipo apagado o sin red  ·  2) Puerto FTP bloqueado  ·  3) Servidor FTP no está en ejecución";
      return "Tiempo de espera agotado — el host no respondió.";
    }
    if (isRefused(r)) {
      if (connType === "rdp")
        return "Conexión rechazada en el puerto RDP.\n1) Equipo apagado o sin red  ·  2) Puerto 3389 bloqueado o modificado  ·  3) Acceso remoto (RDP) no habilitado en el servidor";
      if (connType === "ssh" || connType === "sftp")
        return "Conexión rechazada en el puerto SSH.\n1) Equipo apagado o sin red  ·  2) Servicio SSH (sshd) no está en ejecución  ·  3) Puerto SSH bloqueado";
      if (connType === "vnc")
        return "Conexión rechazada en el puerto VNC.\n1) Equipo apagado o sin red  ·  2) Servidor VNC no está en ejecución  ·  3) Puerto VNC bloqueado";
      if (connType === "ftp")
        return "Conexión rechazada en el puerto FTP.\n1) Equipo apagado o sin red  ·  2) Servidor FTP no está en ejecución  ·  3) Puerto FTP bloqueado";
      return "Conexión rechazada — el puerto está cerrado o el servicio no está activo.";
    }
    return friendlyConnErrorShort(raw, lang, connType);
  }

  // English
  if (isUnreachable(r)) {
    if (connType === "rdp")
      return "Cannot connect to the remote computer.\n1) Computer off or no network  ·  2) Port 3389 blocked or changed  ·  3) Remote Desktop (RDP) not enabled on server";
    if (connType === "vnc")
      return "Cannot connect to the VNC server.\n1) Computer off or no network  ·  2) VNC port blocked  ·  3) VNC server is not running";
    if (connType === "ssh" || connType === "sftp")
      return "Cannot connect to the SSH server.\n1) Computer off or no network  ·  2) SSH port blocked  ·  3) SSH service (sshd) is not running";
    if (connType === "ftp")
      return "Cannot connect to the FTP server.\n1) Computer off or no network  ·  2) FTP port blocked  ·  3) FTP server is not running";
    return "Connection timed out — the host did not respond.";
  }
  if (isRefused(r)) {
    if (connType === "rdp")
      return "Connection refused on the RDP port.\n1) Computer off or no network  ·  2) Port 3389 blocked or changed  ·  3) Remote Desktop (RDP) not enabled on server";
    if (connType === "ssh" || connType === "sftp")
      return "Connection refused on the SSH port.\n1) Computer off or no network  ·  2) SSH service (sshd) is not running  ·  3) SSH port blocked";
    if (connType === "vnc")
      return "Connection refused on the VNC port.\n1) Computer off or no network  ·  2) VNC server is not running  ·  3) VNC port blocked";
    if (connType === "ftp")
      return "Connection refused on the FTP port.\n1) Computer off or no network  ·  2) FTP server is not running  ·  3) FTP port blocked";
    return "Connection refused — the port is closed or the service is not running.";
  }
  return friendlyConnErrorShort(raw, lang, connType);
}
