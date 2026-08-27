type Fields = Record<string, unknown>

function emit(level: string, msg: string, fields?: Fields): void {
  const line: Fields = { ts: new Date().toISOString(), level, msg }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) line[key] = value
    }
  }
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
}
