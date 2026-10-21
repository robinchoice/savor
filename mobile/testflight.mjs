// Hands an uploaded iOS build to TestFlight groups and submits it for the beta
// review when one of them is external. Every assignment mails the group's testers,
// so external groups only get release builds (CLAUDE.md, "Deploy"). Each step is
// checked first, so a run that failed halfway can be repeated.
//
//   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8=<base64 .p8> node mobile/testflight.mjs [--quiet] <build number> <group>…
//
// --quiet turns off TestFlight's mail and push notification for this build.
import { createPrivateKey, sign } from 'node:crypto'

const args = process.argv.slice(2)
const quiet = args[0] === '--quiet'
const [number, ...names] = quiet ? args.slice(1) : args
const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer, ASC_KEY_P8: p8 } = process.env
if (!number || !names.length || !keyId || !issuer || !p8) {
  console.error('usage: ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8=… node mobile/testflight.mjs [--quiet] <build number> <group>…')
  process.exit(64)
}
const key = createPrivateKey(Buffer.from(p8, 'base64').toString())

function token() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`App Store Connect ${method} ${path.split('?')[0]}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

const app = (await api('GET', '/apps?filter[bundleId]=org.pleasance.savor')).data[0]
const allGroups = (await api('GET', `/apps/${app.id}/betaGroups?limit=200`)).data
const groups = names.map(name => {
  const group = allGroups.find(candidate => candidate.attributes.name === name)
  if (!group) throw new Error(`TestFlight group "${name}" not found`)
  return group
})

// Apple needs a few minutes, sometimes more, to process an upload
let build
for (let attempt = 0; ; attempt++) {
  build = (await api('GET', `/builds?filter[app]=${app.id}&filter[version]=${number}&limit=1`)).data[0]
  const state = build?.attributes.processingState
  if (state === 'VALID') break
  if (state && state !== 'PROCESSING') throw new Error(`Build ${number} is ${state}`)
  if (attempt === 60) throw new Error(`Build ${number} was not processed within an hour`)
  console.log(`Build ${number} is still processing …`)
  await new Promise(resolve => setTimeout(resolve, 60_000))
}

if (quiet) {
  const detail = (await api('GET', `/builds/${build.id}/buildBetaDetail`)).data
  await api('PATCH', `/buildBetaDetails/${detail.id}`, { data: { type: 'buildBetaDetails', id: detail.id, attributes: { autoNotifyEnabled: false } } })
  console.log(`Build ${number} notifies no testers`)
}

for (const group of groups) {
  const inGroup = (await api('GET', `/builds?filter[app]=${app.id}&filter[version]=${number}&filter[betaGroups]=${group.id}`)).data
  if (!inGroup.length) await api('POST', `/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] })
  console.log(`Build ${number} is in "${group.attributes.name}"`)
}

if (groups.some(group => !group.attributes.isInternalGroup)) {
  const state = (await api('GET', `/builds/${build.id}/buildBetaDetail`)).data.attributes.externalBuildState
  if (state === 'READY_FOR_BETA_SUBMISSION') {
    await api('POST', '/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } })
    console.log(`Build ${number} is submitted for the beta review`)
  } else {
    console.log(`Build ${number} beta review: ${state}`)
  }
}
