import { describe, expect, it } from 'vitest'
import { createHash, createHmac, createCipheriv } from 'node:crypto'
import {
  rc4,
  rc4Drop1024,
  generateNonce,
  signedNonce,
  generateSignature,
  generateEncSignature,
  categoryOf,
  propsForCategory,
} from '../src/mi'

describe('rc4', () => {
  it('matches the classic test vector (key=Key, data=Plaintext)', () => {
    const out = rc4(Buffer.from('Key'), Buffer.from('Plaintext'))
    expect(out.toString('hex')).toBe('bbf316e8d940af0ad3')
  })

  it('is symmetric', () => {
    const key = Buffer.from('abc123xyz')
    const data = Buffer.from('hello, 米家')
    const enc = rc4(key, data)
    // RC4 is self-inverse: re-running with the same key decrypts.
    expect(rc4(key, enc).toString('utf8')).toBe(data.toString('utf8'))
  })

  it('matches the Xiaomi RC4-drop-1024 vector (al-one init1024)', () => {
    const key = Buffer.from('c2lnbmVkIG5vbmNlIGtleQ==', 'base64') // b64 of 'signed nonce key'
    const out = rc4Drop1024(key, Buffer.from('米家 test 123', 'utf8'))
    expect(out.toString('hex')).toBe('553c08d0c893a65278378ade8cf213')
    // And the plain (no-drop) RC4 differs — the drop is load-bearing.
    const plain = rc4(key, Buffer.from('米家 test 123', 'utf8'))
    expect(plain.toString('hex')).not.toBe(out.toString('hex'))
  })
})

describe('nonce', () => {
  it('is 12 bytes with a big-endian minute slot', () => {
    const millis = Date.UTC(2026, 8, 30, 12, 34, 56)
    const nonce = generateNonce(millis)
    const buf = Buffer.from(nonce, 'base64')
    expect(buf.length).toBe(12)
    expect(buf.readUInt32BE(8)).toBe(Math.floor(millis / 60000))
  })
})

describe('signedNonce', () => {
  it('is base64(sha256(b64(ssecurity) + b64(nonce)))', () => {
    const ssecurity = Buffer.from('the-salt-material').toString('base64')
    const nonce = Buffer.from('0123456789ab').toString('base64')
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')]))
      .digest('base64')
    expect(signedNonce(nonce, ssecurity)).toBe(expected)
  })
})

describe('generateSignature', () => {
  it('matches the current hmac-sha256 formula (path + nonce + sorted pairs)', () => {
    const url = 'https://api.io.mi.com/app/miIO/raw_command'
    const signedNonce = Buffer.from('signed-nonce-key').toString('base64')
    const nonce = Buffer.from('nonce').toString('base64')
    const params = { data: '{"did":"d1"}' }
    const parts = [new URL(url).pathname, signedNonce, nonce]
    for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) parts.push(`${k}=${v}`)
    const expected = createHmac('sha256', Buffer.from(signedNonce, 'base64'))
      .update(parts.join('&'))
      .digest('base64')
    expect(generateSignature(url, signedNonce, nonce, params)).toBe(expected)
  })
})

describe('generateEncSignature', () => {
  it('matches the al-one sha1 formula (method + path + pairs + nonce)', () => {
    const url = 'https://de.api.io.mi.com/app/v2/home/home_device_list'
    const signedNonce = 'abc'
    const params = { data: '{}' }
    const pathname = new URL(url).pathname
    const path = pathname.startsWith('/app/') ? pathname.slice(4) : pathname
    const parts = ['POST', path, 'data={}', signedNonce]
    const expected = createHash('sha1').update(parts.join('&'), 'utf8').digest('base64')
    expect(generateEncSignature(url, 'POST', signedNonce, params)).toBe(expected)
  })
})

describe('categoryOf / propsForCategory', () => {
  it('maps common Mi Home models to categories', () => {
    expect(categoryOf('yeelink.light.lamp1')).toBe('light')
    expect(categoryOf('zimi.plug.v1')).toBe('outlet')
    expect(categoryOf('lumi.sensor_ht.v1')).toBe('sensor')
    expect(categoryOf('zhimi.aircondition.m1')).toBe('climate')
    expect(categoryOf('xiaomi.tv.ac')).toBe('media')
    expect(categoryOf('roborock.vacuum.a10')).toBe('cleaning')
    expect(categoryOf('loock.lock.v1')).toBe('lock')
    expect(categoryOf('chuangmi.camera.h600')).toBe('camera')
    expect(categoryOf('dmaker.fan.p3')).toBe('fan')
    expect(categoryOf('unknown.thing')).toBe('other')
  })

  it('provides a non-empty prop list for every category, with power for control categories', () => {
    for (const cat of ['light', 'outlet', 'sensor', 'climate', 'media', 'cleaning', 'camera', 'lock', 'fan', 'meter', 'other']) {
      const props = propsForCategory(cat as Parameters<typeof propsForCategory>[0])
      expect(props.length).toBeGreaterThan(0)
    }
    for (const cat of ['light', 'outlet', 'climate', 'media', 'fan', 'other']) {
      expect(propsForCategory(cat as Parameters<typeof propsForCategory>[0])).toContain('power')
    }
  })
})
