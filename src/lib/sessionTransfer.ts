// Sessions in this Set are skipped during disconnect cleanup, allowing them
// to be transferred to/from detached windows without dropping the connection.
export const skipDisconnectSessions = new Set<string>();
