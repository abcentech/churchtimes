export async function copyShareLink(input, status, clipboard = globalThis.navigator?.clipboard) {
  try { await clipboard.writeText(input.value); status.textContent='Link copied.'; return true; }
  catch { input.focus(); input.select(); status.textContent='Copy is unavailable. The link is selected; use your device’s Copy command.'; return false; }
}
