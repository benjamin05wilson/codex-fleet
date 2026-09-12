export async function copyText(text) {
  if (window.fleetDesktop?.writeClipboard)
    await window.fleetDesktop.writeClipboard(text);
  else await navigator.clipboard.writeText(text);
}
