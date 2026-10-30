import test from 'node:test'
import assert from 'node:assert/strict'
import { decode } from '../src/stream.ts'
const WSOL = 'So11111111111111111111111111111111111111112'
const fakeConn = (meta) => ({ getTransaction: async () => ({ meta, transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: ['TRADER', 'POOL', 'POOLWSOL', 'POOLTOKEN'].map((k) => ({ toBase58: () => k })) }) } } }) })
test('decode: pool WSOL up = buy with exact size', async () => {
  const meta = { err: null, preTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: 'POOL', uiTokenAmount: { uiAmount: 100 } }], postTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: 'POOL', uiTokenAmount: { uiAmount: 102.5 } }], preBalances: [], postBalances: [] }
  const s = await decode(fakeConn(meta), 'POOL', 'sig1', 1); assert.equal(s.side, 'buy'); assert.ok(Math.abs(s.sol - 2.5) < 1e-9); assert.equal(s.trader, 'TRADER')
})
test('decode: pool WSOL down = sell; trader-owned WSOL ignored', async () => {
  const meta = { err: null, preTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: 'POOL', uiTokenAmount: { uiAmount: 100 } }, { accountIndex: 5, mint: WSOL, owner: 'TRADER', uiTokenAmount: { uiAmount: 0 } }], postTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: 'POOL', uiTokenAmount: { uiAmount: 97 } }, { accountIndex: 5, mint: WSOL, owner: 'TRADER', uiTokenAmount: { uiAmount: 3 } }], preBalances: [], postBalances: [] }
  const s = await decode(fakeConn(meta), 'POOL', 'sig2', 1); assert.equal(s.side, 'sell'); assert.ok(Math.abs(s.sol - 3) < 1e-9)
})
test('decode: failed tx or dust → null', async () => {
  assert.equal(await decode(fakeConn({ err: { x: 1 }, preTokenBalances: [], postTokenBalances: [] }), 'POOL', 's', 1), null)
  assert.equal(await decode(fakeConn({ err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [1e9, 5e9], postBalances: [1e9, 5e9 + 1000] }), 'POOL', 's', 1), null)
})
test('decode: pump bonding curve (native SOL pool) — the curve account\'s own lamport delta is the trade', async () => {
  // keys: TRADER, POOL(=curve), POOLWSOL, POOLTOKEN — a buy moves 1.98 SOL into the curve, 0.02 to the fee account, trader pays 2.0
  const buy = { err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [10e9, 30e9, 1e9, 2e6], postBalances: [8e9, 31.98e9, 1.02e9, 2e6] }
  const s = await decode(fakeConn(buy), 'POOL', 'p1', 1); assert.equal(s.side, 'buy'); assert.ok(Math.abs(s.sol - 1.98) < 1e-9); assert.equal(s.trader, 'TRADER')
  const sell = { err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [10e9, 30e9, 1e9, 2e6], postBalances: [10.7e9, 29.3e9, 1.0e9, 2e6] }
  const s2 = await decode(fakeConn(sell), 'POOL', 'p2', 1); assert.equal(s2.side, 'sell'); assert.ok(Math.abs(s2.sol - 0.7) < 1e-9)
})
