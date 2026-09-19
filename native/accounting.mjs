// Provisional realized-P&L accounting. Receipts must come from the trusted local
// execution bridge; this does not authenticate an arbitrary remote receipt.
import { address, hash32, uint, ceilDiv, fingerprint } from './core.mjs';

export class SettlementLedger {
  constructor({ executor, relayer, lossLimits, maxPending = 64, maxReceipts = 8192 }) {
    this.executor = address(executor); this.relayer = address(relayer);
    if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 64) throw new Error('invalid pending limit');
    if (!Number.isInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 100000) throw new Error('invalid receipt history limit');
    this.maxPending = maxPending; this.maxReceipts = maxReceipts;
    this.pending = new Map(); this.receipts = new Map(); this.totals = new Map();
    this.lossLimits = new Map(); this.halted = false;
    if (!Array.isArray(lossLimits) || !lossLimits.length) throw new Error('explicit settlement-denominated session loss limits required');
    for (const item of lossLimits) {
      const token = address(item.settlementToken), loss = uint(item.maxLoss);
      if (!loss || this.lossLimits.has(token)) throw new Error('positive unique session loss limit required');
      this.lossLimits.set(token, loss);
    }
  }
  canTrade(token) {
    token = address(token);
    if (this.halted || this.receipts.size >= this.maxReceipts || !this.lossLimits.has(token)) return false;
    // Count all unresolved submissions as their entire authorized gas exposure.
    // Therefore a burst cannot bypass the session loss budget before receipts.
    let reserved = 0n;
    for (const p of this.pending.values()) if (p.token === token) reserved += p.maxGasCost;
    return (this.totals.get(token)?.net ?? 0n) - reserved > -this.lossLimits.get(token);
  }
  register(signed, opportunity) {
    const hash = hash32(signed.hash), token = address(opportunity.route.settlementToken);
    if (!this.canTrade(token) || this.pending.size >= this.maxPending) throw new Error('session risk limit');
    if (this.pending.has(hash) || this.receipts.has(hash)) throw new Error('duplicate transaction registration');
    const priceNumerator = uint(opportunity.costs.settlementUnitsPerWeiNumerator);
    const priceDenominator = uint(opportunity.costs.settlementUnitsPerWeiDenominator);
    const gasLimit = uint(signed.gasLimit), maxFeePerGas = uint(signed.maxFeePerGas);
    if (!priceNumerator || !priceDenominator || !gasLimit || !maxFeePerGas) throw new Error('missing signed gas/conversion limits');
    const maxGasCost = ceilDiv(gasLimit * maxFeePerGas * priceNumerator, priceDenominator);
    let exposure = maxGasCost;
    for (const item of this.pending.values()) if (item.token === token) exposure += item.maxGasCost;
    if ((this.totals.get(token)?.net ?? 0n) - exposure < -this.lossLimits.get(token)) throw new Error('submission exceeds remaining session loss budget');
    const entry = Object.freeze({ hash, token, nonce: uint(signed.nonce), digest: hash32(signed.intentDigest),
      anchorBlock: uint(opportunity.head.number), anchorHash: hash32(opportunity.head.hash),
      borrowed: uint(opportunity.amount), minProfit: uint(opportunity.route.minProfit),
      gasLimit, maxFeePerGas, priceNumerator, priceDenominator, maxGasCost,
      modeledProfit: BigInt(opportunity.grossProfit), routeId: opportunity.route.id, key: opportunity.key });
    this.pending.set(hash, entry);
    return entry;
  }
  settle(receipt, isCanonical) {
    const hash = hash32(receipt.txHash), digest = fingerprint(receipt);
    if (this.receipts.has(hash)) {
      if (this.receipts.get(hash).receiptFingerprint !== digest) throw new Error('conflicting duplicate receipt');
      return null;
    }
    if (this.receipts.size >= this.maxReceipts) throw new Error('receipt history full: checkpoint/reconciliation required');
    const p = this.pending.get(hash);
    if (!p) throw new Error('unregistered receipt');
    const blockNumber = uint(receipt.blockNumber), blockHash = hash32(receipt.blockHash);
    if (!isCanonical(blockNumber, blockHash)) throw new Error('receipt not on observed executed chain');
    if (blockNumber <= p.anchorBlock) throw new Error('receipt before execution window');
    if (uint(receipt.nonce) !== p.nonce || ![0, 1].includes(receipt.status)) throw new Error('receipt nonce/status mismatch');
    if (receipt.feeModel !== 'gasUsed-times-effectiveGasPrice-inclusive') throw new Error('unverified receipt fee accounting model');
    const gasUsed = uint(receipt.gasUsed), gasPrice = uint(receipt.effectiveGasPrice);
    if (!gasUsed || gasUsed > p.gasLimit || gasPrice > p.maxFeePerGas) throw new Error('receipt exceeds signed gas bounds');
    if (!Array.isArray(receipt.arbitrageEvents)) throw new Error('decoded executor events required');
    let profit = 0n;
    if (receipt.status === 1) {
      if (blockNumber !== p.anchorBlock + 1n) throw new Error('successful execution not in N+1');
      if (receipt.arbitrageEvents.length !== 1) throw new Error('successful receipt requires exactly one executor profit event');
      const event = receipt.arbitrageEvents[0];
      if (address(event.emitter) !== this.executor || address(event.relayer) !== this.relayer ||
          hash32(event.digest) !== p.digest || uint(event.anchorBlock) !== p.anchorBlock ||
          hash32(event.anchorBlockHash) !== p.anchorHash || address(event.settlementToken) !== p.token ||
          uint(event.borrowed) !== p.borrowed) throw new Error('executor event does not match signed intent');
      profit = uint(event.profit);
      if (profit < p.minProfit) throw new Error('realized profit below signed floor');
    } else if (receipt.arbitrageEvents.length) throw new Error('reverted receipt cannot contain successful arbitrage events');
    const gasWei = gasUsed * gasPrice;
    const gasCost = ceilDiv(gasWei * p.priceNumerator, p.priceDenominator);
    const net = profit - gasCost;
    const entry = Object.freeze({ txHash: hash, nonce: p.nonce, blockNumber, blockHash,
      settlementToken: p.token, status: receipt.status, grossProfit: profit, gasWei, gasCost, net,
      modeledProfit: p.modeledProfit, modelError: profit - p.modeledProfit, routeId: p.routeId, key: p.key,
      // Converted P&L is valued at the signed decision's frozen rational price;
      // native gasWei is also retained. It is not an independent fiat mark.
      conversionNumerator: p.priceNumerator, conversionDenominator: p.priceDenominator,
      provisional: true, receiptFingerprint: digest });
    // Commit only after every validation. A malformed receipt consumes nothing.
    this.pending.delete(hash); this.receipts.set(hash, entry);
    this.#add(entry, 1n);
    return entry;
  }
  #add(item, sign) {
    const t = this.totals.get(item.settlementToken) || { successes: 0n, reverts: 0n, grossProfit: 0n, gasCost: 0n, gasWei: 0n, net: 0n };
    t.successes += item.status === 1 ? sign : 0n; t.reverts += item.status === 0 ? sign : 0n;
    for (const key of ['grossProfit', 'gasCost', 'gasWei', 'net']) t[key] += sign * item[key];
    this.totals.set(item.settlementToken, t);
  }
  invalidateFrom(blockNumber) {
    blockNumber = uint(blockNumber); this.halted = true;
    const removed = [];
    for (const [hash, item] of this.receipts) if (item.blockNumber >= blockNumber) {
      this.#add(item, -1n); this.receipts.delete(hash); removed.push(hash);
    }
    // Do not reuse old EOA nonces: canonical-account reconciliation is required.
    return removed;
  }
  summary() {
    return { provisional: true, halted: this.halted, unresolved: this.pending.size,
      settlements: [...this.totals].map(([settlementToken, totals]) => ({ settlementToken, ...totals })) };
  }
}
