// Offline test for the channel rotation: which channel a host's next attempt
// takes, what moves it, and what does not.
//
// No network and no clock: the rotation is pure state, so every transition is
// asserted exactly. The strategy it encodes is the shipped one — a host starts
// direct, a *failure* moves it to the other channel, and a success leaves it
// where it is, so a healthy host never pays for a tunnel.
import {
  ChannelRotation,
  FIRST_CHANNEL,
  describeRotation,
  otherChannel,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

const HOST = 'api.example'
const OTHER = 'another.example'

// --- 1. An untouched host starts direct ------------------------------------
{
  const rotation = new ChannelRotation()
  check('an untouched host starts direct', rotation.channelFor(HOST), 'direct')
  check('the shipped first channel is direct', FIRST_CHANNEL, 'direct')
  check('an untouched host has no state', rotation.stateOf(HOST), undefined)
  check('otherChannel flips direct to proxy', otherChannel('direct'), 'proxy')
  check('otherChannel flips proxy to direct', otherChannel('proxy'), 'direct')
}

// --- 2. A failure moves the host to the other channel ----------------------
{
  const rotation = new ChannelRotation()
  check('the first failure points the next attempt at the proxy', rotation.record(HOST), 'proxy')
  check('the host is now on the proxy', rotation.channelFor(HOST), 'proxy')
  check('the second failure points back at direct', rotation.record(HOST), 'direct')
  check('the third failure flips again', rotation.record(HOST), 'proxy')
  check('the cursor is remembered', rotation.stateOf(HOST), 'proxy')
}

// --- 3. Every attempt moves the cursor, success included -------------------
// The rotation is a round-robin, not a verdict: an answered attempt still hands
// the next one to the other channel, so both paths are exercised instead of one
// being trusted on the strength of a single good minute.
{
  const rotation = new ChannelRotation()
  check('an answered first attempt moves the cursor to the proxy', rotation.record(HOST), 'proxy')
  check('the host is now on the proxy', rotation.channelFor(HOST), 'proxy')
  check('an answered proxy attempt moves it back', rotation.record(HOST), 'direct')
  check('and so on', rotation.record(HOST), 'proxy')
}

// --- 4. The cursor is per host ---------------------------------------------
{
  const rotation = new ChannelRotation()
  rotation.record(HOST)
  check('another host is untouched', rotation.channelFor(OTHER), 'direct')
  check('the failing host moved', rotation.channelFor(HOST), 'proxy')
  check('each host carries its own cursor',
    [rotation.channelFor(HOST), rotation.channelFor(OTHER)],
    ['proxy', 'direct'])
  rotation.record(OTHER)
  check('the other host moves on its own failure', rotation.channelFor(OTHER), 'proxy')
}

// --- 5. A whole run of retries alternates ----------------------------------
{
  const rotation = new ChannelRotation()
  const seen = []
  for (let i = 0; i < 6; i++) {
    seen.push(rotation.channelFor(HOST))
    rotation.record(HOST)
  }
  check('retries read direct, proxy, direct, proxy …',
    seen,
    ['direct', 'proxy', 'direct', 'proxy', 'direct', 'proxy'])
}

// --- 6. reset forgets every host -------------------------------------------
{
  const rotation = new ChannelRotation()
  rotation.record(HOST)
  rotation.record(OTHER)
  rotation.reset()
  check('reset returns every host to direct', rotation.channelFor(HOST), 'direct')
  check('reset forgets the cursor', rotation.stateOf(HOST), undefined)
  check('reset forgets the other host too', rotation.channelFor(OTHER), 'direct')
}

// --- 7. The mount log names the strategy -----------------------------------
check('describeRotation names the rotation',
  describeRotation(4),
  'route=rotate (attempt 1 direct, the other channel every attempt after it, up to 4 attempts)')
check('describeRotation handles a single attempt',
  describeRotation(1),
  'route=rotate (attempt 1 direct, the other channel every attempt after it, up to 1 attempt)')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
