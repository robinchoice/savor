import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkForUpdate } from '../desktop/updates.cjs'

// Stands in for electron-updater's autoUpdater, with `latest` as the newest release.
function fakeUpdater(latest) {
  return {
    autoDownload: true,
    downloads: 0,
    async checkForUpdates() {
      if (latest === '0.6.36') return { isUpdateAvailable: false, updateInfo: { version: latest } }
      return { isUpdateAvailable: true, updateInfo: { version: latest }, cancellationToken: {}, downloadPromise: this.autoDownload ? this.downloadUpdate() : null }
    },
    downloadUpdate() {
      this.downloads++
      return Promise.resolve([`Savor-${latest}.AppImage`])
    },
  }
}

test('a newer release downloads once', async () => {
  const updater = fakeUpdater('0.6.37')
  const found = await checkForUpdate(updater, null)
  assert.equal(found.version, '0.6.37')
  assert.deepEqual(await found.download, ['Savor-0.6.37.AppImage'])
  assert.equal(updater.downloads, 1)
})

test('a release that already waits to be installed is not downloaded again', async () => {
  const updater = fakeUpdater('0.6.37')
  for (let i = 0; i < 3; i++) assert.deepEqual(await checkForUpdate(updater, '0.6.37'), { version: '0.6.37', download: null })
  assert.equal(updater.downloads, 0)
})

test('a release newer than the one waiting downloads', async () => {
  const updater = fakeUpdater('0.6.38')
  assert.equal((await checkForUpdate(updater, '0.6.37')).version, '0.6.38')
  assert.equal(updater.downloads, 1)
})

test('no update when this version is current', async () => {
  const updater = fakeUpdater('0.6.36')
  assert.equal(await checkForUpdate(updater, null), null)
  assert.equal(updater.downloads, 0)
})
