// UF2 is a list of 512-byte blocks, each carrying up to 476 bytes for one
// flash address. Serial DFU wants the plain image instead, so this lays the
// blocks out from the lowest address up. See github.com/microsoft/uf2.

const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_NOT_MAIN_FLASH = 0x00000001;

export interface FirmwareImage {
  /** Flash address of the first byte. */
  start: number;
  data: Uint8Array;
}

export function uf2ToImage(uf2: Uint8Array): FirmwareImage {
  if (uf2.length % 512 !== 0) throw new Error("This UF2 file isn't a whole number of blocks.");
  const view = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  const blocks: { address: number; payload: Uint8Array }[] = [];
  for (let at = 0; at < uf2.length; at += 512) {
    if (view.getUint32(at, true) !== MAGIC_START0 || view.getUint32(at + 4, true) !== MAGIC_START1 || view.getUint32(at + 508, true) !== MAGIC_END) {
      throw new Error(`UF2 block ${at / 512} is damaged.`);
    }
    if (view.getUint32(at + 8, true) & FLAG_NOT_MAIN_FLASH) continue;
    const address = view.getUint32(at + 12, true);
    const size = view.getUint32(at + 16, true);
    if (size > 476) throw new Error(`UF2 block ${at / 512} claims ${size} bytes.`);
    blocks.push({ address, payload: uf2.subarray(at + 32, at + 32 + size) });
  }
  if (!blocks.length) throw new Error("This UF2 file has no firmware in it.");

  const start = Math.min(...blocks.map((b) => b.address));
  const end = Math.max(...blocks.map((b) => b.address + b.payload.length));
  // Gaps read as erased flash.
  const data = new Uint8Array(end - start).fill(0xff);
  for (const b of blocks) data.set(b.payload, b.address - start);
  return { start, data };
}
