import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validDiditSignature, normalizeDiditDecision, compareDiditNames, diditNameGate } from '../server/didit-protocol';

test('V2 authenticates sorted, compact, Unicode-preserving JSON rather than raw bytes', () => {
  const raw = '{"status":"Approved", "decision":{"last_name":"José","first_name":"Marie"}}';
  const sorted = '{"decision":{"first_name":"Marie","last_name":"José"},"status":"Approved"}';
  const signature = crypto.createHmac('sha256', 'test-only').update(sorted).digest('hex');
  assert.equal(validDiditSignature(raw, signature, 'test-only', 'v2'), true);
  assert.equal(validDiditSignature(raw.replace('Approved', 'Declined'), signature, 'test-only', 'v2'), false);
  assert.equal(validDiditSignature(raw, signature, 'test-only', 'legacy'), false);
  assert.equal(validDiditSignature(raw, 'bad', 'test-only', 'v2'), false);
});

test('decision names come from actual V2/V3 reports, never fabricated', () => {
  const document = { status: 'Approved', first_name: 'Marie', last_name: 'Joseph' };
  assert.deepEqual(normalizeDiditDecision({ id_verification: document }).features, document);
  assert.deepEqual(normalizeDiditDecision({ id_verifications: [document] }).features, document);
  assert.deepEqual(normalizeDiditDecision({ decision: { features: document } }).features, document);
  assert.equal(normalizeDiditDecision({ status: 'Approved' }).features, undefined);
});

test('empty legacy features cannot mask a confirmed V2/V3 name mismatch', () => {
  const id = { status: 'Approved', first_name: 'Marie', last_name: 'Joseph' };
  const account = { firstName: 'Paul', lastName: 'Pierre' };
  for (const payload of [
    { features: {}, id_verification: id },
    { decision: { features: {}, id_verifications: [id] } },
    { decision: {}, id_verification: id },
  ]) {
    const decision = normalizeDiditDecision(payload);
    assert.equal(compareDiditNames(decision.features, account), 'mismatch');
    assert.equal(diditNameGate('Approved', decision, account).rejected, true);
    assert.equal(diditNameGate('In Review', decision, account).rejected, true);
  }
});

test('review name gate never invents a mismatch from missing or unapproved reports', () => {
  const account = { firstName: 'Paul', lastName: 'Pierre' };
  for (const payload of [
    { features: {} },
    { id_verifications: [] },
    { id_verification: { status: 'Declined', first_name: 'Marie', last_name: 'Joseph' } },
    { features: { first_name: 'Marie', last_name: 'Joseph' } },
  ]) {
    assert.equal(diditNameGate('In Review', normalizeDiditDecision(payload), account).rejected, false);
  }
  assert.equal(compareDiditNames(undefined, account), 'unverifiable');
  assert.equal(compareDiditNames({ first_name: 'Pául', last_name: 'Pierre' }, account), 'match');
  assert.equal(compareDiditNames({ first_name: 'Marie', last_name: 'Joseph' }, {}), 'adopt');
  assert.equal(diditNameGate('In Progress', { features: { status: 'Approved', first_name: 'Marie' } }, account).rejected, false);
});

test('lifecycle regression guards: initiation is pending, only current sessions update, no fake reviewer FK', () => {
  const server = readFileSync('server/didit-kyc.ts', 'utf8');
  const create = server.slice(server.indexOf('export async function createDiditSession'), server.indexOf('export function verifyDiditWebhookSignature'));
  assert.ok(!create.includes("'pending_review'"));
  assert.ok(create.includes("verificationStatus: 'pending'"));
  assert.ok(server.includes('latest?.id !== verification.id'));
  assert.ok(server.includes("latest.verificationStatus === 'verified'"));
  assert.ok(!server.includes("updates.verifiedBy = 'didit_ai'"));
  assert.ok(server.includes("case 'Abandoned':") && server.includes("case 'Declined':"));
  const client = readFileSync('client/src/pages/kyc.tsx', 'utf8');
  assert.ok(!client.includes('setTimeout'));
  assert.ok(!client.includes('returnedFromDidit'));
  assert.ok(client.includes("'/api/kyc/status?sync=1'"));
});