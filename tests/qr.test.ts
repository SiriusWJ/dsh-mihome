import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QrSessionStore, stripJsonpPrefix } from '../src/qr'

describe('stripJsonpPrefix', () => {
  it('strips the &&&START&&& prefix Xiaomi wraps JSON responses in', () => {
    expect(stripJsonpPrefix('&&&START&&&{"code":0,"qr":"https://x"}')).toBe('{"code":0,"qr":"https://x"}')
  })

  it('returns plain JSON unchanged', () => {
    expect(stripJsonpPrefix('{"a":1}')).toBe('{"a":1}')
  })
})

describe('QrSessionStore', () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('round-trips a session and clears it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mihome-test-'))
    const store = new QrSessionStore(join(dir, 'session.json'))

    expect(await store.load()).toBeNull()

    await store.save({
      userId: '12345',
      serviceToken: 'tok-abc',
      ssecurity: 'c2VjcmV0',
      cUserId: '54321',
      savedAt: new Date().toISOString(),
    })
    const loaded = await store.load()
    expect(loaded?.userId).toBe('12345')
    expect(loaded?.serviceToken).toBe('tok-abc')
    expect(loaded?.ssecurity).toBe('c2VjcmV0')
    expect(loaded?.cUserId).toBe('54321')

    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('returns null for malformed content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mihome-test-'))
    const store = new QrSessionStore(join(dir, 'session.json'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'session.json'), 'not json', 'utf8')
    expect(await store.load()).toBeNull()
  })
})
