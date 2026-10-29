// Flashes a half over its bootloader's serial port, with no drive to choose.
// This is Nordic's legacy serial DFU, as Adafruit's nRF52 bootloader speaks
// it. Kinesis's bootloader is built from Adafruit's, and adafruit-nrfutil's
// `dfu serial` is the reference: every packet is SLIP-framed with a small
// header and a CRC, and the bootloader acknowledges each one.
//
// The order: a start packet with the image size (the bootloader then erases
// flash), a 14-byte init packet with the image's CRC, the image in 512-byte
// pieces, and a stop packet. The bootloader checks the CRC and restarts into
// the new firmware.

import { type PortLike, closePort, exclusive, openPort } from "./serial";
import { sleep } from "./util";

const START_PACKET = 3;
const INIT_PACKET = 1;
const DATA_PACKET = 4;
const STOP_PACKET = 5;
const MODE_APPLICATION = 4;
const PIECE = 512;

export interface DfuTiming {
  /** The longest the bootloader takes to erase one 4 KB flash page. */
  pageEraseMs: number;
  /** How long to wait for each acknowledgement, on top of any erasing. */
  ackMs: number;
}

// adafruit-nrfutil's figure for erasing. An Advantage360 Pro takes about 86 ms a page.
export const DFU_TIMING: DfuTiming = { pageEraseMs: 89.7, ackMs: 3000 };

/** CRC-16/CCITT starting at 0xFFFF, as the bootloader computes it. */
export function crc16(data: Uint8Array | number[], crc = 0xffff): number {
  for (const b of data) {
    crc = ((crc >> 8) & 0xff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
  }
  return crc & 0xffff;
}

/** The init packet: any device type and revision, any SoftDevice, and the image's CRC. */
export function initPacket(image: Uint8Array): Uint8Array {
  const out = new Uint8Array(14);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x0052, true); // device type, as Adafruit's tools set it
  v.setUint16(2, 0xffff, true); // any device revision
  v.setUint32(4, 0xffffffff, true); // any application version
  v.setUint16(8, 1, true); // one required SoftDevice entry...
  v.setUint16(10, 0xfffe, true); // ...meaning any SoftDevice
  v.setUint16(12, crc16(image), true);
  return out;
}

const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** One SLIP-framed transport packet carrying `payload`. */
export function frame(seq: number, payload: Uint8Array | number[]): Uint8Array {
  const length = payload.length;
  const header = [
    seq | (((seq + 1) % 8) << 3) | (1 << 6) | (1 << 7), // sequence, ack, integrity check, reliable
    14 | ((length & 0x0f) << 4), // vendor-specific packet type
    (length & 0x0ff0) >> 4,
  ];
  header.push((~(header[0] + header[1] + header[2]) + 1) & 0xff);
  const body = [...header, ...payload];
  const crc = crc16(body);
  body.push(crc & 0xff, (crc >> 8) & 0xff);

  const out = [0xc0];
  for (const b of body) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return new Uint8Array(out);
}

/** Collects SLIP frames from the port as they arrive. */
class Frames {
  private buffer: number[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {
    void this.pump();
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.buffer.push(...value);
        this.waiting?.();
      }
    } catch {
      // The port closed, or the bootloader restarted.
    }
    this.done = true;
    this.waiting?.();
  }

  /** Waits for the next complete frame, up to `ms`. */
  async next(ms: number): Promise<number[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const start = this.buffer.indexOf(0xc0);
      const end = start < 0 ? -1 : this.buffer.indexOf(0xc0, start + 1);
      if (end > start + 1) {
        const raw = this.buffer.slice(start + 1, end);
        this.buffer = this.buffer.slice(end + 1);
        return raw;
      }
      // Two delimiters in a row: drop the first and keep looking.
      if (end === start + 1) {
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (this.done) throw new Error("The bootloader closed the connection.");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("The bootloader stopped answering.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiting = null;
    }
  }

  /** Stops reading, so the port can close. */
  async release() {
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }
}

/**
 * Flashes `image` (the plain firmware, from address 0x26000) over a port in
 * update mode. `onProgress` gets the fraction sent, from 0 to 1.
 */
export async function dfuFlash(port: PortLike, image: Uint8Array, onProgress?: (fraction: number) => void, timing = DFU_TIMING): Promise<void> {
  await exclusive(port, async () => {
    await openPort(port, 115200);
    let frames: Frames | null = null;
    try {
      // Like adafruit-nrfutil: drop and raise DTR so the bootloader starts listening.
      await port.setSignals?.({ dataTerminalReady: false }).catch(() => {});
      await sleep(50);
      await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
      await sleep(100);

      frames = new Frames(port.readable!.getReader());
      const writer = port.writable!.getWriter();
      let seq = 0;
      const send = async (payload: number[], ms = timing.ackMs) => {
        seq = (seq + 1) % 8;
        await writer.write(frame(seq, payload));
        await frames!.next(ms);
      };

      try {
        await send([...u32(START_PACKET), ...u32(MODE_APPLICATION), ...u32(0), ...u32(0), ...u32(image.length)]);
        // The bootloader erases the application area, then answers the init packet.
        const pages = Math.floor(image.length / 4096) + 1;
        await send([...u32(INIT_PACKET), ...initPacket(image), 0, 0], timing.ackMs + pages * timing.pageEraseMs);

        // The bootloader answers each piece once it has taken it: about 5 ms,
        // and 45 more for every 8th, while it writes a 4 KB page. So unlike
        // adafruit-nrfutil, Tandem doesn't sleep between pieces.
        const pieces = Math.ceil(image.length / PIECE);
        for (let i = 0; i < pieces; i++) {
          await send([...u32(DATA_PACKET), ...image.subarray(i * PIECE, (i + 1) * PIECE)]);
          onProgress?.((i + 1) / pieces);
        }
        await send(u32(STOP_PACKET));
      } finally {
        writer.releaseLock();
      }
    } finally {
      await frames?.release();
      await closePort(port);
    }
  });
}
