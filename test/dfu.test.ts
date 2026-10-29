// Serial DFU's encoding, checked against bytes adafruit-nrfutil 0.5.3 produced
// for the same packets, and the UF2 reader it depends on.

import { describe, expect, it, vi } from "vitest";

import { crc16, dfuFlash, frame, initPacket } from "../src/engine/dfu";
import type { PortLike } from "../src/engine/serial";
import { uf2ToImage } from "../src/engine/uf2";
import { fakeUf2 } from "./fakes/github";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => [...Buffer.from(text, "hex")];

/**
 * A bootloader with the Advantage360 Pro's timing: after the start packet it
 * erases for `eraseMs` and answers nothing until it's done, and every 8th
 * piece takes 45 ms while it writes a page.
 */
function slowBootloader(eraseMs: number): PortLike {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let busyUntil = 0;
  let pieces = 0;
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    getInfo: () => ({ usbVendorId: 0x239a, usbProductId: 0x00b3 }),
    async open() {
      port.readable = new ReadableStream({ start: (c) => void (controller = c) });
      port.writable = new WritableStream({
        write(chunk) {
          // Unescape the one frame each write carries.
          const body: number[] = [];
          for (let i = 1; i < chunk.length - 1; i++) body.push(chunk[i] === 0xdb ? (chunk[++i] === 0xdc ? 0xc0 : 0xdb) : chunk[i]);
          const seq = body[0] & 7;
          const type = body[4];
          if (type === 4 && ++pieces % 8 === 0) busyUntil = Date.now() + 45;
          const answer = () => controller.enqueue(new Uint8Array([0xc0, ((seq + 1) % 8) << 3, 0, 0, 0, 0xc0]));
          setTimeout(answer, Math.max(0, busyUntil - Date.now()));
          if (type === 3) busyUntil = Date.now() + eraseMs;
        },
      });
    },
    async close() {
      port.readable = null;
      port.writable = null;
    },
  };
  return port satisfies PortLike;
}

describe("dfuFlash", () => {
  it("takes only as long as the bootloader does, however long it erases", async () => {
    vi.useFakeTimers();
    vi.setTimerTickMode("nextTimerAsync");
    try {
      // The right half's firmware: 374 pieces, and an erase longer than ackMs.
      const image = new Uint8Array(191_488);
      const began = Date.now();
      await dfuFlash(slowBootloader(4029), image);
      // 150 ms of DTR toggling before the first packet.
      expect(Date.now() - began).toBe(150 + 4029 + 46 * 45);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serial DFU encoding", () => {
  it("computes CRC-16/CCITT from 0xFFFF", () => {
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });

  it("frames packets exactly as adafruit-nrfutil does", () => {
    // The start packet for a 190,976-byte application, as the first packet.
    expect(hex(frame(1, fromHex("0300000004000000000000000000000000ea0200")))).toBe("c0d14e01e00300000004000000000000000000000000ea0200f9aec0");
    // The stop packet, as the third.
    expect(hex(frame(3, fromHex("05000000")))).toBe("c0e34e00cf05000000128cc0");
  });

  it("escapes the frame delimiter inside a packet", () => {
    const framed = frame(1, [0xc0, 0xdb]);
    const inner = framed.subarray(1, -1);
    expect(inner.includes(0xc0)).toBe(false);
    expect(hex(inner)).toContain("dbdcdbdd");
  });

  it("writes the 14-byte init packet with the image's CRC", () => {
    const image = new TextEncoder().encode("123456789");
    expect(hex(initPacket(image))).toBe("5200ffffffffffff0100feffb129");
  });
});

describe("uf2ToImage", () => {
  it("lays blocks out from the lowest address", () => {
    const { start, data } = uf2ToImage(fakeUf2("right-clique", "abc1234"));
    expect(start).toBe(0x26000);
    expect(new TextDecoder().decode(data).replace(/\0+$/, "")).toBe("right-clique:abc1234");
  });

  it("fills gaps between blocks with erased flash", () => {
    const uf2 = fakeUf2("x", "y".repeat(300)); // two blocks
    const view = new DataView(uf2.buffer);
    view.setUint32(512 + 12, 0x26000 + 1024, true); // move the second block up
    const { data } = uf2ToImage(uf2);
    expect(data.length).toBe(1024 + 256);
    expect(data[600]).toBe(0xff);
  });

  it("refuses a damaged file", () => {
    const uf2 = fakeUf2("x", "y");
    uf2[508] = 0;
    expect(() => uf2ToImage(uf2)).toThrow(/damaged/);
    expect(() => uf2ToImage(new Uint8Array(100))).toThrow(/whole number of blocks/);
  });
});
