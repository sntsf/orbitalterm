export function friendlyConnError(raw: string, lang: "es" | "en"): string {
  const r = raw.toLowerCase();

  if (lang === "es") {
    if (r.includes("connection refused"))
      return "Conexión rechazada — el puerto está cerrado o el servicio no está activo en el servidor.";
    if (r.includes("no route to host") || r.includes("network is unreachable") || r.includes("host unreachable"))
      return "Host inalcanzable — verifica la dirección IP y que el servidor esté encendido.";
    if (r.includes("timed out") || r.includes("timeout") || r.includes("connection timed"))
      return "Tiempo de espera agotado — el host no respondió. Puede estar apagado o bloqueado por un firewall.";
    if (r.includes("authentication failed") || r.includes("permission denied") || r.includes("incorrect") || r.includes("invalid credentials"))
      return "Autenticación fallida — verifica el usuario y la contraseña o llave SSH.";
    if (r.includes("host key verification") || r.includes("host key changed") || r.includes("host key mismatch"))
      return "La llave del host no coincide — el servidor puede haber cambiado o reinstalado.";
    if (r.includes("name or service not known") || r.includes("name resolution") || r.includes("nodename nor servname") || r.includes("could not resolve"))
      return "No se pudo resolver el nombre DNS — verifica el hostname o la conexión a la red.";
    if (r.includes("no_rdp_client"))
      return "No hay cliente RDP instalado en el sistema. Instala freerdp o remmina.";
    if (r.includes("no_password"))
      return "No hay contraseña guardada. Agrégala en las propiedades de la conexión.";
    if (r.includes("connection reset") || r.includes("broken pipe") || r.includes("connection aborted"))
      return "La conexión fue interrumpida inesperadamente.";
    if (r.includes("too many authentication"))
      return "Demasiados intentos de autenticación fallidos.";
    if (r.includes("banner") || r.includes("protocol"))
      return "Error de protocolo — el servidor respondió con un mensaje inesperado.";
    return raw;
  }

  // English
  if (r.includes("connection refused"))
    return "Connection refused — the port is closed or the service is not running on the server.";
  if (r.includes("no route to host") || r.includes("network is unreachable") || r.includes("host unreachable"))
    return "Host unreachable — check the IP address and make sure the server is online.";
  if (r.includes("timed out") || r.includes("timeout") || r.includes("connection timed"))
    return "Connection timed out — the host did not respond. It may be offline or blocked by a firewall.";
  if (r.includes("authentication failed") || r.includes("permission denied") || r.includes("incorrect") || r.includes("invalid credentials"))
    return "Authentication failed — check the username and password or SSH key.";
  if (r.includes("host key verification") || r.includes("host key changed") || r.includes("host key mismatch"))
    return "Host key mismatch — the server's key has changed or it is a different server.";
  if (r.includes("name or service not known") || r.includes("name resolution") || r.includes("nodename nor servname") || r.includes("could not resolve"))
    return "DNS resolution failed — check the hostname and your network connection.";
  if (r.includes("no_rdp_client"))
    return "No RDP client installed. Install freerdp or remmina.";
  if (r.includes("no_password"))
    return "No password saved. Add a password in the connection properties.";
  if (r.includes("connection reset") || r.includes("broken pipe") || r.includes("connection aborted"))
    return "Connection was unexpectedly reset.";
  if (r.includes("too many authentication"))
    return "Too many failed authentication attempts.";
  if (r.includes("banner") || r.includes("protocol"))
    return "Protocol error — the server responded with an unexpected message.";
  return raw;
}
