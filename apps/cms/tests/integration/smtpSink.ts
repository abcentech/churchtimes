import net from 'node:net'

/**
 * Minimal local SMTP sink for tests (RFC 5321 happy path: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT). No TLS,
 * no AUTH, loopback only. Every accepted message is kept with its envelope and raw DATA so tests can check the
 * real bytes nodemailer put on the wire (headers, multipart structure). Never used outside tests.
 */
export type SinkMessage = { from: string; to: string[]; raw: string }
export type SmtpSink = { port: number; messages: SinkMessage[]; close: () => Promise<void>; rejectNext: (n?: number) => void }

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SinkMessage[] = []
  let rejects = 0
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    let inData = false
    let from = ''
    let to: string[] = []
    let data = ''
    const reply = (line: string) => socket.write(`${line}\r\n`)
    reply('220 sink.local ESMTP test sink')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) {
            // keep a tail in case the terminator spans chunks
            if (buffer.length > 5) {
              data += buffer.slice(0, -5)
              buffer = buffer.slice(-5)
            }
            return
          }
          data += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          if (rejects > 0) {
            rejects -= 1
            reply('554 5.7.1 test sink rejected this message')
          } else {
            messages.push({ from, to, raw: data.replace(/\r\n\.\./g, '\r\n.') })
            reply('250 2.0.0 queued')
          }
          from = ''
          to = []
          data = ''
          continue
        }
        const eol = buffer.indexOf('\r\n')
        if (eol === -1) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') {
          socket.write('250-sink.local\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 10485760\r\n')
        } else if (verb === 'HELO') reply('250 sink.local')
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? ''
          reply('250 2.1.0 ok')
        } else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
          reply('250 2.1.5 ok')
        } else if (verb === 'DATA') {
          inData = true
          reply('354 end with <CRLF>.<CRLF>')
        } else if (verb === 'RSET') {
          from = ''
          to = []
          reply('250 ok')
        } else if (verb === 'NOOP') reply('250 ok')
        else if (verb === 'QUIT') {
          reply('221 bye')
          socket.end()
          return
        } else reply('502 5.5.2 not implemented')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    port,
    messages,
    rejectNext: (n = 1) => {
      rejects = n
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/** Unfolded header value (RFC 5322 folding removed) from a raw message, or undefined. */
export function header(raw: string, name: string): string | undefined {
  const head = raw.split(/\r\n\r\n/)[0] ?? ''
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ')
  const line = unfolded.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  return line?.slice(name.length + 1).trim()
}
