type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// One JSON line per event on stdout; never log secrets (tokens, passwords, invite codes).
export function createLogger(level: Level = 'info', sink: (line: string) => void = line => process.stdout.write(line + '\n')): Logger {
  const emit = (at: Level, message: string, fields?: Record<string, unknown>) => {
    if (order[at] < order[level]) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level: at, message, ...fields }));
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
