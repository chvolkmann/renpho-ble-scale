import {
  Adapter, Bluetooth, createBluetooth, GattCharacteristic, GattServer
} from "node-ble";
import { Logger, LoggerWithoutCallSite } from "tslog";

import { communicateWithGATT, writeToUuid } from "./gatt";
import { Packet, parseIncomingPacket } from "./protocol";
import { buf2hexstr, delay, makeLongUuid } from "./util";

export interface EventEmitter {
  emit(eventName: string, ...args: any[]): unknown;

  on(eventName: string, handler: (...args: any[]) => unknown): this;
  off(eventName: string, handler: (...args: any[]) => unknown): this;
}

export interface EventTree {
  data: [packet: Packet];
  liveupdate: [weightValue: number];
  measurement: [weightValue: number];
  timeout: [];
}

export type EventName = keyof EventTree;

export class RenphoScale {
  protected listeners: Record<EventName, Array<(...args: any[]) => unknown>> = {
    liveupdate: [],
    measurement: [],
    data: [],
    timeout: [],
  };
  protected readonly logger = new Logger({
    name: RenphoScale.name,
    displayFunctionName: false,
    displayFilePath: "hidden",
  });

  protected verbose: boolean;

  timeout: boolean = false;

  public eventChar?: GattCharacteristic;

  static async connect(
    btAdapter: Adapter,
    macAddress: string,
    opts: { verbose?: boolean } = {}
  ) {
    const logger = new LoggerWithoutCallSite({
      name: "connect()",
      displayFunctionName: false,
      displayFilePath: "hidden",
    });
    if (opts.verbose)
      if (opts.verbose) logger.info(`Waiting for connection to ${macAddress}`);
    const device = await btAdapter.waitDevice(macAddress);
    await device.connect();
    if (opts.verbose) logger.info(`Connected!`);
    //  TODO we can get stuck here!, need another timeout
    const gatt = await device.gatt();
    return new RenphoScale(gatt, opts);
  }

  constructor(public gatt: GattServer, opts: { verbose?: boolean } = {}) {
    this.verbose = opts?.verbose ?? false;
  }

  protected static getScaleType(magicNumber: number) {
    // TODO fill this
    const SCALE_TYPES: Record<number, string> = { 21: "kg" };
    return SCALE_TYPES[magicNumber] ?? "unknown";
  }

  private getListeners(eventName: string) {
    if (!["liveupdate", "measurement", "data", "timeout"].includes(eventName))
      throw new Error(`Invalid event: ${eventName}`);
    return this.listeners[eventName as EventName];
  }

  protected emit(eventName: EventName, ...args: any[]): this {
    this.getListeners(eventName).forEach((fn: any) => fn(...args));
    return this;
  }

  on(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (handler) this.getListeners(eventName).push(handler);
    return this;
  }

  off(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    const listeners = this.getListeners(eventName);
    if (handler) {
      const index = listeners.findIndex((fn) => fn === handler);
      if (index >= 0) listeners.splice(index, 1);
    } else {
      listeners.splice(0, listeners.length);
    }
    return this;
  }

  protected async sendCommand(char: GattCharacteristic, buf: Buffer) {
    if (this.verbose)
      this.logger
        .getChildLogger({
          name: "SEND 👉",
        })
        .debug(buf2hexstr(buf));
    await char.writeValue(buf);
  }

  protected async handlePacket(outChar: GattCharacteristic, p: Packet) {
    if (this.verbose)
      this.logger
        .getChildLogger({
          name: "RECV 📨",
        })
        .debug(buf2hexstr(p.data));

    this.emit("data", p);

    switch (p.packetId) {
      case 0x12:
        this.logger.debug(`✅ Received handshake packet 1/2`);
        // ????
        const magicBytesForFirstPacket = [
          0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForFirstPacket));
        return;
      case 0x14:
        this.logger.debug(`✅ Received handshake packet 2/2`);
        // turn on bluetooth indicator?
        const magicBytesForSecondPacket = [
          0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForSecondPacket));
        return;
      case 0x10:
        const flag = p.data[5];
        if (flag === 0) {
          this.emit("liveupdate", p.weightValue);
        } else if (flag === 1) {
          this.logger.debug(`✅ Received completed measurement packet`);
          // send stop packet
          await this.sendCommand(
            outChar,
            Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49])
          );
          this.emit("measurement", p.weightValue);
        }
        return;
      default:
        this.logger.silly("Unknown packet", p);
    }
  }

  async startListening() {
    if (this.eventChar) return;
    const TIMEOUT_AFTER = 10;

    this.logger.info(`Listening... (timeout after ${TIMEOUT_AFTER} seconds}`);

    const svc = await this.gatt.getPrimaryService(makeLongUuid("ffe0"));
    const eventChar = await svc.getCharacteristic(makeLongUuid("ffe1"));
    const commandChar = await svc.getCharacteristic(makeLongUuid("ffe3"));

    let timeout = false;
    const handleValueChange = (buf: Buffer) => {
      if (timeout) return;
      this.handlePacket(commandChar, parseIncomingPacket(buf)).catch((err) =>
        this.logger.error(err)
      );
    };
    eventChar.on("valuechanged", handleValueChange);

    await eventChar.startNotifications();
    this.eventChar = eventChar;

    let timerHandle: any;
    const onTimeout = () => {
      this.logger.warn(`timeout after (${TIMEOUT_AFTER}) seconds`);
      timeout = true;
      this.emit("timeout");
      eventChar.off("valuechanged", handleValueChange);
      this.stopListening().catch((err) =>
        this.logger.debug(
          `stopListening failed, but thats fine (${err.toString()})}`
        )
      );
    };
    const resetTimer = () => {
      if (timerHandle) clearTimeout(timerHandle);
      timerHandle = setTimeout(onTimeout, TIMEOUT_AFTER * 1000);
    };
    resetTimer();

    this.on("data", () => {
      resetTimer();
    });
  }

  async stopListening() {
    if (!this.eventChar) return;

    this.logger.info("Stopping...");
    await this.eventChar.stopNotifications();
    this.eventChar = undefined;
  }

  async takeMeasurement() {
    return await new Promise<number>(async (resolve) => {
      this.logger.info("Starting measurement...");

      const svc = await this.gatt.getPrimaryService(makeLongUuid("ffe0"));
      const eventChar = await svc.getCharacteristic(makeLongUuid("ffe1"));
      const commandChar = await svc.getCharacteristic(makeLongUuid("ffe3"));

      const sendCommand = async (buf: Buffer) => {
        if (this.verbose)
          this.logger
            .getChildLogger({
              name: "SEND 👉",
            })
            .debug(buf2hexstr(buf));
        await commandChar.writeValue(buf);
      };

      const handlePacket = async (p: Packet) => {
        if (this.verbose)
          this.logger
            .getChildLogger({
              name: "RECV 📨",
            })
            .debug(buf2hexstr(p.data));

        switch (p.packetId) {
          case 0x12:
            this.logger.debug(`✅ Received handshake packet 1/2`);
            // ????
            const magicBytesForFirstPacket = [
              0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42,
            ];
            await sendCommand(Buffer.from(magicBytesForFirstPacket));
            return;
          case 0x14:
            this.logger.debug(`✅ Received handshake packet 2/2`);
            // turn on bluetooth indicator?
            const magicBytesForSecondPacket = [
              0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26,
            ];
            await sendCommand(Buffer.from(magicBytesForSecondPacket));
            return;
          case 0x10:
            const flag = p.data[5];
            if (flag === 0) {
              this.emit("liveupdate", p.weightValue);
            } else if (flag === 1) {
              this.logger.debug(`✅ Received completed measurement packet`);
              // send stop packet
              await sendCommand(Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49]));

              await eventChar.stopNotifications();
              this.emit("measurement", p.weightValue);
              resolve(p.weightValue);
            }
            return;
          default:
            return;
        }
      };

      eventChar.on("valuechanged", (buf) => {
        handlePacket(parseIncomingPacket(buf)).catch((err) =>
          this.logger.error(err)
        );
      });

      await eventChar.startNotifications();
    });
  }
}

(async (once?: boolean) => {
  const logger = new Logger({
    name: "main()",
    displayFunctionName: false,
    displayFilePath: "hidden",
  });
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();

    const connectAndHandle = async () => {
      const scale = await RenphoScale.connect(adapter, "A4:C1:38:D9:67:6A", {
        verbose: true,
      });
      let raiseFlag: () => unknown;
      scale
        .on("measurement", (val) =>
          logger
            .getChildLogger({ name: "event:measurement" })
            .silly(`${val.toFixed(2)}kg`)
        )
        .on("liveupdate", (val) =>
          logger
            .getChildLogger({ name: "event:liveupdate" })
            .silly(`${val.toFixed(2)}kg`)
        )
        .on("timeout", () => {
          if (raiseFlag) raiseFlag();
        })
        .on("measurement", () => {
          if (raiseFlag) raiseFlag();
        });

      await scale.startListening();
      await new Promise<void>((resolve, reject) => {
        raiseFlag = resolve;
      });
    };

    // TODO DBusError: Operation already in progress can spam the console
    while (true) {
      try {
        await connectAndHandle();
        if (once) break;
      } catch (err: any) {
        logger.error(err.toString());
      }
      logger.info("Next iteration!");
      await delay(1);
    }

    logger.info("Done!");
  } finally {
    logger.info("Properly destroying bluetooth connection");
    destroy();
  }
})(false);
