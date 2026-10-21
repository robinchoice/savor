// The iOS app (Capacitor, mobile/ios) bundles this web client. No relay serves it there, so every paired
// computer remembers its relay, and pairing scans the QR code with the app's camera.
import { Capacitor } from '@capacitor/core'
import { t } from './i18n'

export const native = Capacitor.isNativePlatform()

export async function scanQrCode() {
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner')
  const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: t('Scan the pairing QR code in Savor on your computer') })
  return ScanResult
}

// The pairing QR code holds https://<relay>/#/rpair/<computer's key>/<code>.
export function parsePairingLink(text: string) {
  try {
    const url = new URL(text.trim())
    const [, route, daemonPk, code] = url.hash.split('/')
    if (!/^https?:$/.test(url.protocol) || route !== 'rpair' || !daemonPk || !code) return null
    return { relay: url.origin, daemonPk, code }
  } catch {
    return null
  }
}
