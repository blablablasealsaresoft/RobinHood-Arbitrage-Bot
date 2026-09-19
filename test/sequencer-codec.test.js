import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeL2Message } from '../sequencer-codec.js';

const VERIFIED_L2_MSG = 'AwAAAAAAAABwBPhtggqNhApLnsCCXxiUenZHY9E9F+Pp2tpbA3GygN7xBGqGASjsTTkfgIIkkqAMPhc21kyIBZR0RowXW6Ho9E3rGhTjQiS+EryRYl6gdKBPl78LaXMB2YwV8xUBdkB3ZDFbl6+EXT7JVGb/h+M/cwAAAAAAAAD4BAL49IISN4IOOIRZaC8AhF2t7wCDCSfAlHOZGiXIGL8fESjeqrFJLUVjjeDTgLiE/G94ZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmgYAAAAAAAAAAAAAAAAdLJuwnVNy9J+Q6KlJ+OABTWKdy4AAAAAAAAAAAAAAAAAAAAA/////////////////////wAAAAAAAAAAAAAAAAAAAAD/////////////////////wICg2/lv1vQh9OylhGUpTdmx+6hbxyeZcwn5b4PRxKzH6yKgIYXJkdpJTLtQ8tGJwln97FiADyZ56U5WVfyBTyvAn3A=';

test('decodes signed transactions nested in a captured Robinhood Nitro batch', () => {
  const txs = decodeL2Message(Buffer.from(VERIFIED_L2_MSG, 'base64'));
  assert.equal(txs.length, 2);

  assert.deepEqual(txs[0], {
    txType: 0,
    to: '0x7a764763d13d17e3e9dada5b0371b280def1046a',
    selector: null,
    valueWei: '1275274803487',
    nonce: '2701',
    gas: '24344',
    dataLength: 0,
  });

  assert.equal(txs[1].txType, 2);
  assert.equal(txs[1].to, '0x73991a25c818bf1f1128deaab1492d45638de0d3');
  assert.equal(txs[1].selector, '0xfc6f7865');
  assert.equal(txs[1].valueWei, '0');
  assert.equal(txs[1].nonce, '3640');
  assert.equal(txs[1].gas, '600000');
  assert.equal(txs[1].dataLength, 132);
});

test('ignores unsupported L2 message kinds instead of inventing transactions', () => {
  assert.deepEqual(decodeL2Message(Buffer.from([0xff, 1, 2, 3])), []);
});
