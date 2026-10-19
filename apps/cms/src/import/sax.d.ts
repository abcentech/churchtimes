declare module 'sax' {
  export interface SaxTag {
    name: string
    attributes: Record<string, string>
    isSelfClosing: boolean
  }
  export interface SaxParser {
    onerror: ((err: Error) => void) | null
    ontext: ((text: string) => void) | null
    oncdata: ((text: string) => void) | null
    onopentag: ((tag: SaxTag) => void) | null
    onclosetag: ((name: string) => void) | null
    ondoctype: ((doctype: string) => void) | null
    onsgmldeclaration: ((decl: string) => void) | null
    write(chunk: string): SaxParser
    close(): SaxParser
  }
  const sax: { parser(strict: boolean, opt?: Record<string, unknown>): SaxParser }
  export default sax
}
