/**
 * Opt-in Firefox / WebKit projects for the cross-app lane (XAPP_ALL_BROWSERS=1). Kept out of the main config so the
 * default run stays Chromium-only and the config diff stays small.
 */
import type { devices as Devices, PlaywrightTestConfig } from '@playwright/test'

/**
 * --host-resolver-rules is Chromium-only. Probed on Windows: Firefox 146 and Playwright's WebKit build both resolve
 * *.localhost to loopback on their own (RFC 6761), so WebKit needs no workaround. For Firefox we still list the exact hosts in
 * network.dns.localDomains so the lane keeps working if a build ever stops special-casing .localhost. Nothing is system-wide.
 * NOTE: Playwright's WebKit on Windows approximates Safari; it is not real Safari.
 */
/** The exact hosts the stack uses (see stack.ts HOSTS); Firefox resolves these to loopback via network.dns.localDomains. */
export const XAPP_LOCAL_HOSTS = ['cms.churchtimes.localhost', 'newsroom.churchtimes.localhost', 'www.churchtimes.localhost']

type Project = NonNullable<PlaywrightTestConfig['projects']>[number]

export function extraBrowserProjects(devices: typeof Devices): Project[] {
  const firefoxLaunch = {
    firefoxUserPrefs: { 'network.dns.localDomains': XAPP_LOCAL_HOSTS.join(',') },
  }
  return [
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 }, launchOptions: firefoxLaunch } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 14'] } },
  ]
}
