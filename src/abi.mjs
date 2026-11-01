import { keccak256 } from './keccak.mjs';
import { address } from './config.mjs';
export const word = (n) => { const x = BigInt(n); if (x < 0n || x >= 1n << 256n) throw new Error('Invalid uint256'); return x.toString(16).padStart(64, '0'); };
export const addrWord = (a) => address(a).slice(2).padStart(64, '0');
export const selector = (signature) => '0x' + keccak256(signature).slice(0, 8);
export const TRANSFER = '0x' + keccak256('Transfer(address,address,uint256)');
export const ZERO_TOPIC = '0x' + '0'.repeat(64);
export function uint(result) { if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64,}$/.test(result)) throw new Error('Invalid ABI uint'); return BigInt('0x' + result.slice(2, 66)); }
export const topicAddress = (topic) => { if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error('Invalid address topic'); return '0x' + topic.slice(-40).toLowerCase(); };
export function encodeSwap(signature, amount, minOut, path, recipient, deadline) {
  if (path.length < 2 || path.length > 3) throw new Error('Unsupported route');
  const nativeIn = signature.startsWith('swapExactETH');
  const words = nativeIn ? [word(minOut), word(128), addrWord(recipient), word(deadline)] : [word(amount), word(minOut), word(160), addrWord(recipient), word(deadline)];
  return selector(signature) + words.join('') + word(path.length) + path.map(addrWord).join('');
}
export const APPROVE = selector('approve(address,uint256)');
export const BALANCE = selector('balanceOf(address)');
export const ALLOWANCE = selector('allowance(address,address)');
export const ALLOWED_MINT_SELECTORS = new Set([
  'mint()', 'freeMint()', 'claim()', 'mint(uint256)', 'publicMint()', 'freeMint(uint256)', 'mintFree()', 'claimFree()', 'agentMint()'
].map(selector));
