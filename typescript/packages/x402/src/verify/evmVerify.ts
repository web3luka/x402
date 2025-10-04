import { type Address, decodeEventLog, erc20Abi, type Hex, isHex, parseAbiItem } from "viem";
import type { PublicClient } from "viem";
import { withEvmClientsRetry } from "./evmClient";

export type VerifyExactParams = {
  token: Address; // ERC-20 token address (e.g., USDC on BSC)
  to: Address; // recipient address (payTo)
  amountAtomic: bigint; // required amount in token decimals
  /**
   * Optional memo/tag carried offchain. If you enforce memo on-chain, you need app-specific logic
   * (e.g. transferWithMemo). Standard ERC20 Transfer doesn't have memo field.
   */
  memo?: string;
};

export type VerifyExactResult = {
  isValid: boolean;
  reason?: string;
  txHash?: Hex;
  payer?: Address;
};

export type VerifyNativeExactParams = {
  to: Address; // recipient address (payTo)
  amountWei: bigint; // required amount in wei
  /**
   * For stricter validation, require a simple value transfer (no calldata),
   * i.e. transaction.input === "0x". Defaults to true to avoid counting
   * internal value transfers from contracts.
   */
  requireEmptyInput?: boolean;
};

/**
 * Production helper: verifies ERC-20 exact payment by inspecting a specific transaction hash.
 * Succeeds when the tx includes a Transfer(token) event matching recipient and minimal amount.
 *
 * @param clients
 * @param txHash
 * @param params
 */
/**
 * Verifies ERC-20 exact (minimum) payment by inspecting a single transaction hash.
 * Succeeds when the tx includes a Transfer event for the given token with `to` and
 * value greater than or equal to `amountAtomic`.
 *
 * @param clients - Ordered list of viem PublicClient instances used with fallback.
 * @param txHash - Transaction hash to inspect (0x-prefixed hex string).
 * @param params - Verification parameters: `token`, `to`, `amountAtomic` (atomic units).
 * @returns Verification result containing validity, optional payer and tx hash, or reason on failure.
 */
export async function verifyErc20ExactByTxHash(
  clients: PublicClient[],
  txHash: Hex,
  params: VerifyExactParams,
): Promise<VerifyExactResult> {
  if (!isHex(txHash)) {
    return { isValid: false, reason: "INVALID_TX_HASH" };
  }
  try {
    const receipt = await withEvmClientsRetry(clients, c =>
      c.getTransactionReceipt({ hash: txHash }),
    );
    if (!receipt.logs?.length) return { isValid: false, reason: "NO_LOGS" };

    const matched = findMatchingTransfer(
      receipt.logs,
      params.token,
      params.to,
      params.amountAtomic,
    );
    if (!matched) return { isValid: false, reason: "NO_MATCHING_TRANSFER" };

    return { isValid: true, txHash, payer: matched.from };
  } catch (err) {
    return { isValid: false, reason: (err as Error)?.message ?? "VERIFY_FAILED" };
  }
}

/**
 * Verifies native coin (e.g., BNB) exact (minimum) payment by inspecting a transaction hash.
 * Limitations: cannot reliably account for internal transfers without trace APIs. By default
 * enforces empty input (EOA -> EOA value transfer). Use requireEmptyInput=false if you
 * explicitly allow contract calls sending value to `to` (less strict).
 *
 * @param clients
 * @param txHash
 * @param params
 */
/**
 * Verifies native coin (e.g., BNB) exact (minimum) payment by inspecting a transaction hash.
 * By default enforces empty calldata (EOA → EOA) to avoid counting internal transfers.
 *
 * @param clients - Ordered list of viem PublicClient instances used with fallback.
 * @param txHash - Transaction hash to inspect (0x-prefixed hex string).
 * @param params - Verification parameters: `to`, `amountWei`, `requireEmptyInput` (default true).
 * @returns Verification result containing validity, optional payer and tx hash, or reason on failure.
 */
export async function verifyNativeExactByTxHash(
  clients: PublicClient[],
  txHash: Hex,
  params: VerifyNativeExactParams,
): Promise<VerifyExactResult> {
  if (!isHex(txHash)) return { isValid: false, reason: "INVALID_TX_HASH" };
  const { to, amountWei, requireEmptyInput = true } = params;
  try {
    const tx = await withEvmClientsRetry(clients, c => c.getTransaction({ hash: txHash }));
    const receipt = await withEvmClientsRetry(clients, c =>
      c.getTransactionReceipt({ hash: txHash }),
    );

    if (receipt.status !== "success") return { isValid: false, reason: "TX_FAILED" };
    if (!tx.to) return { isValid: false, reason: "NO_TO_ADDRESS" };
    if (tx.to.toLowerCase() !== to.toLowerCase())
      return { isValid: false, reason: "WRONG_RECIPIENT" };
    if (requireEmptyInput && tx.input && tx.input !== "0x")
      return { isValid: false, reason: "NON_EMPTY_INPUT" };
    if (tx.value < amountWei) return { isValid: false, reason: "INSUFFICIENT_AMOUNT" };

    return { isValid: true, txHash, payer: tx.from as Address };
  } catch (err) {
    return { isValid: false, reason: (err as Error)?.message ?? "VERIFY_FAILED" };
  }
}

/**
 * Production helper: verifies ERC-20 exact payment by scanning recent logs for a recipient.
 * Use when nie masz txHash. Ogranicz zakres bloków (fromBlock/toBlock) według własnych SLO.
 *
 * @param clients
 * @param params
 */
/**
 * Verifies ERC-20 exact (minimum) payment by scanning logs in a given block range.
 * Filters Transfer events for the provided token and `to` address and validates amount.
 *
 * @param clients - Ordered list of viem PublicClient instances used with fallback.
 * @param params - Verification parameters: `token`, `to`, `amountAtomic`, `fromBlock`, optional `toBlock`.
 * @returns Verification result containing validity and optional payer/tx hash, or reason on failure.
 */
export async function verifyErc20ExactByLogs(
  clients: PublicClient[],
  params: VerifyExactParams & { fromBlock: bigint; toBlock?: bigint },
): Promise<VerifyExactResult> {
  try {
    const { token, to, amountAtomic, fromBlock, toBlock } = params;

    // Use typed event filter to avoid raw topics typing issues
    const transferEvent = parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    );
    const logs = await withEvmClientsRetry(clients, c =>
      c.getLogs({ address: token, event: transferEvent, args: { to }, fromBlock, toBlock }),
    );

    for (const log of logs) {
      const match = tryDecodeTransfer(log, token);
      if (!match) continue;
      if (match.to.toLowerCase() !== to.toLowerCase()) continue;
      if (match.value < amountAtomic) continue;
      return { isValid: true, txHash: log.transactionHash!, payer: match.from };
    }
    return { isValid: false, reason: "NO_MATCHING_TRANSFER" };
  } catch (err) {
    return { isValid: false, reason: (err as Error)?.message ?? "VERIFY_FAILED" };
  }
}

// ---- internals ----

/**
 *
 * @param log
 * @param log.address
 * @param log.data
 * @param log.topics
 * @param token
 */
/**
 * Attempts to decode an ERC-20 Transfer event from a log and normalize fields.
 *
 * @param log - Raw log object containing address, data and topics.
 * @param log.address - Contract address that emitted the log.
 * @param log.data - ABI-encoded data field.
 * @param log.topics - Topics array for the log (signature + indexed args).
 * @param token - Expected ERC-20 token contract address to match against.
 * @returns Decoded fields `{ from, to, value }` or `null` when log is not a matching Transfer.
 */
function tryDecodeTransfer(
  log: { address: Address; data: Hex; topics: readonly Hex[] },
  token: Address,
): { from: Address; to: Address; value: bigint } | null {
  if (log.address.toLowerCase() !== token.toLowerCase()) return null;
  try {
    if (!log.topics || log.topics.length === 0) return null;
    const topics = [...log.topics] as [Hex, ...Hex[]];
    const decoded = decodeEventLog({
      abi: erc20Abi,
      data: log.data,
      topics,
    });
    if (decoded.eventName !== "Transfer") return null;
    const { from, to, value } = decoded.args as {
      from: Address;
      to: Address;
      value: bigint;
    };
    return { from, to, value };
  } catch {
    return null;
  }
}

/**
 *
 * @param logs
 * @param token
 * @param to
 * @param minAmount
 */
/**
 * Finds the first matching ERC-20 Transfer within a list of logs for the given token and recipient.
 *
 * @param logs - Array of transaction logs to inspect.
 * @param token - ERC-20 token address to match.
 * @param to - Recipient address to match in the Transfer event.
 * @param minAmount - Minimum amount (atomic units) required to consider the transfer valid.
 * @returns `{ from }` when a valid transfer is found, otherwise `null`.
 */
function findMatchingTransfer(
  logs: Array<{ address: Address; data: Hex; topics: readonly Hex[]; transactionHash?: Hex }>,
  token: Address,
  to: Address,
  minAmount: bigint,
): { from: Address } | null {
  for (const log of logs) {
    const t = tryDecodeTransfer(log, token);
    if (!t) continue;
    if (t.to.toLowerCase() !== to.toLowerCase()) continue;
    if (t.value < minAmount) continue;
    return { from: t.from };
  }
  return null;
}
