// Checks for a newer release and starts its download, unless that version was already downloaded and
// waits to be installed: electron-updater would otherwise start the download again on every check.
// Resolves to the newer version and its download, or to null when this one is current.
async function checkForUpdate(autoUpdater, ready) {
  autoUpdater.autoDownload = false
  const result = await autoUpdater.checkForUpdates()
  if (!result?.isUpdateAvailable) return null
  const version = result.updateInfo.version
  return { version, download: version === ready ? null : autoUpdater.downloadUpdate(result.cancellationToken) }
}

module.exports = { checkForUpdate }
