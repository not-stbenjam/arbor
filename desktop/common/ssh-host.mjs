// Shared by the renderer and the main-process protocol boundary. This is the
// same bounded SSH destination grammar accepted by engine.ValidateHost.
export const MAX_HOST_LENGTH = 255;
export const MAX_HOST_LABEL_LENGTH = 100;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$/;

export function isValidSSHHost(host, { allowLocal = false } = {}) {
  return (
    typeof host === "string" &&
    host.length <= MAX_HOST_LENGTH &&
    // JavaScript's $ also matches before a final newline. Compare the complete
    // match so the protocol agrees with Go's full-string host validation.
    (host === "" ? allowLocal : HOST.exec(host)?.[0] === host)
  );
}
