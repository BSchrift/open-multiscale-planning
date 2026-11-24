// Downloads a file the server sends as an attachment, such as an export: the browser saves it and the page stays where
// it is. The Mac app and the iPhone hand the link to a browser instead (Platform.openDownload).

export async function downloadLink(url: string): Promise<void> {
  Object.assign(document.createElement('a'), { href: url, rel: 'noopener' }).click();
}

/** Opens a link in the system browser: in the iPhone app's web view, a new window's link goes to Safari. */
export async function openInSystemBrowser(url: string): Promise<void> {
  Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener' }).click();
}
