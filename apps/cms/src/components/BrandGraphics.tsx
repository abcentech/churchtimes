/**
 * Church Times Nigeria masthead in the CMS admin (login screen `Logo`, navigation `Icon`). The files live in
 * apps/cms/public/brand and are the same artwork as the public site's public/brand-assets. Payload sets
 * html[data-theme] to light or dark, so both files are rendered and CSS shows the matching one.
 */
const css = `
.ct-brand-dark{display:none}
html[data-theme=dark] .ct-brand-light{display:none}
html[data-theme=dark] .ct-brand-dark{display:block}
`

export function BrandLogo() {
  return (
    <span style={{ display: 'block', width: 'min(360px, 80vw)' }}>
      <style>{css}</style>
      <img className="ct-brand-light" src="/brand/masthead.svg" width={1141} height={276} alt="Church Times Nigeria" style={{ width: '100%', height: 'auto' }} />
      <img className="ct-brand-dark" src="/brand/masthead-dark.svg" width={1141} height={276} alt="" style={{ width: '100%', height: 'auto' }} />
    </span>
  )
}

export function BrandIcon() {
  return <img src="/brand/icon.svg" width={28} height={28} alt="Church Times Nigeria" style={{ display: 'block' }} />
}
